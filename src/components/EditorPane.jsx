import { useEffect, useRef, useState } from 'react';
import { tr, getLang } from '../i18n.js';
import CodeMirror from 'codemirror';
import 'codemirror/mode/stex/stex';
import 'codemirror/mode/markdown/markdown';
import 'codemirror/mode/javascript/javascript';
import 'codemirror/mode/python/python';
import 'codemirror/mode/clike/clike';
import 'codemirror/mode/xml/xml';
import 'codemirror/mode/htmlmixed/htmlmixed';
import 'codemirror/mode/css/css';
import 'codemirror/mode/shell/shell';
import 'codemirror/mode/sql/sql';
import 'codemirror/mode/yaml/yaml';
import 'codemirror/mode/go/go';
import 'codemirror/mode/rust/rust';
import 'codemirror/mode/ruby/ruby';
import 'codemirror/mode/lua/lua';
import 'codemirror/mode/dockerfile/dockerfile';
import 'codemirror/addon/edit/closebrackets';
import 'codemirror/addon/edit/matchbrackets';
import 'codemirror/addon/selection/active-line';
import 'codemirror/addon/hint/show-hint';
import 'codemirror/addon/hint/show-hint.css';
import 'codemirror/addon/fold/foldcode';
import 'codemirror/addon/fold/foldgutter';
import 'codemirror/addon/fold/brace-fold';
import 'codemirror/addon/fold/indent-fold';
import 'codemirror/addon/fold/foldgutter.css';
import { buildChecker, findTypos } from '../spellcheck.js';
import { maskNonProse } from '../spellcheck.js';
import { LT_ENDPOINT, CHUNK_MAX, CHUNKS_PER_RUN, splitChunks, buildRequestBody, parseMatches } from '../grammar.js';
import { buildProofMessages, parseAIResult, proofChunks } from '../aiProofread.js';
import { chat as llmChat } from '../llm.js';
import { matchRefContext } from '../projectIndex.js';
import { commandCandidates, fileCandidates, matchCommandToken, matchEnvToken, matchFileToken, envNeedsEnd, ENVIRONMENTS } from '../completion.js';
import FindReplace from './FindReplace.jsx';

/* 词典懒加载：首次需要时才拉（静态托管约 2.7MB 原文，gzip 后小得多），
 * 加载失败就静默关闭拼写检查，不影响编辑；用户词表在 localStorage */
let spellCheckerPromise = null;
function loadSpellChecker() {
  if (!spellCheckerPromise) {
    spellCheckerPromise = fetch((import.meta.env.BASE_URL || './') + 'dict/en.txt', { cache: 'force-cache' })
      .then(r => { if (!r.ok) throw new Error('dict ' + r.status); return r.text(); })
      .then(text => {
        let extra = [];
        try { extra = JSON.parse(localStorage.getItem('paperlite.spell-user-words') || '[]'); } catch (e) { /* ignore */ }
        return buildChecker(text, Array.isArray(extra) ? extra : []);
      })
      .catch(() => null);
  }
  return spellCheckerPromise;
}

/* 统一 LaTeX 补全（一个 hint 按优先级分派）：
 *   \ref/\cite 键 → \begin{ 环境 → 文件参数 → \command 命令（内置表 + \newcommand）。
 * 各上下文的匹配器在 src/completion.js（纯逻辑，可单测）；这里只负责取光标上下文、
 * 组装候选与插入动作（命令模板光标落点、环境自动补 \end）。 */
function buildLatexHint(refCompletionRef, completionRef) {
  // 命令候选的插入：模板后缀里 '{' '[' 的第一个出现处是光标停留点
  const applyCommand = (cand) => function (cm, data) {
    const text = '\\' + cand.name + cand.suffix;
    cm.replaceRange(text, data.from, data.to);
    const nameLen = cand.name.length + 1;
    const br = cand.suffix.indexOf('{'), brk = cand.suffix.indexOf('[');
    let off = text.length;
    if (br >= 0 && (brk < 0 || br < brk)) off = nameLen + br + 1;
    else if (brk >= 0) off = nameLen + brk + 1;
    cm.setCursor({ line: data.from.line, ch: data.from.ch + off });
  };
  // 环境候选的插入：补名字后看光标后的窗口，没有同名 \end 就顺手闭合
  const applyEnv = (name) => function (cm, data) {
    cm.replaceRange(name + '}', data.from, data.to);
    const cur = cm.getCursor();
    let after = '';
    try { after = cm.getRange(cur, cm.posFromIndex(Math.min(cm.getValue().length, cm.indexFromPos(cur) + 3000))); } catch (e) { /* ignore */ }
    if (envNeedsEnd(name, after)) {
      cm.replaceRange('\n\\end{' + name + '}\n', cur);
      cm.setCursor(cur);
    }
  };
  return function (cm) {
    const cur = cm.getCursor();
    const before = (cm.getLine(cur.line) || '').slice(0, cur.ch);

    // 1) \ref / \cite 键位（跨文件索引）
    const m = matchRefContext(before);
    if (m) {
      const comp = refCompletionRef.current;
      if (comp) {
        const from = { line: cur.line, ch: cur.ch - m.segment.length };
        const pool = m.isCite ? (comp.bibKeys || []) : (comp.labels || []);
        const q = m.segment.toLowerCase();
        const seen = new Set();
        const list = [];
        for (const k of pool) {
          if (!k || !k.key || seen.has(k.key)) continue;
          if (q && k.key.toLowerCase().indexOf(q) < 0) continue;
          seen.add(k.key);
          list.push({ text: k.key, displayText: k.src ? k.key + '  ·  ' + k.src : k.key });
          if (list.length >= 50) break;
        }
        if (list.length) return { list, from, to: cur };
      }
      return null;
    }

    const cp = completionRef.current;
    if (!cp || !cp.texLike) return null;

    // 2) \begin{ 环境
    const env = matchEnvToken(before);
    if (env) {
      const q = env.partial.toLowerCase();
      const names = ENVIRONMENTS.filter(n => !q || n.toLowerCase().startsWith(q)).slice(0, 40);
      if (names.length) {
        return { list: names.map(n => ({ text: n + '}', displayText: n, hint: applyEnv(n) })),
          from: { line: cur.line, ch: cur.ch - env.partial.length }, to: cur };
      }
      return null;
    }

    // 3) 文件参数（\input / \includegraphics / \bibliography …）
    const ft = matchFileToken(before);
    if (ft) {
      const paths = fileCandidates(ft.kind, ft.partial, cp.pool);
      if (paths.length) {
        return { list: paths.map(p => ({ text: p, displayText: p })),
          from: { line: cur.line, ch: cur.ch - ft.partial.length }, to: cur };
      }
      return null;
    }

    // 4) \command 命令
    const ct = matchCommandToken(before);
    if (ct) {
      const cands = commandCandidates(ct.token, cp.userCommands);
      if (cands.length) {
        return { list: cands.map(c => {
          const text = '\\' + c.name + c.suffix;
          return { text, displayText: text, hint: applyCommand(c) };
        }), from: { line: cur.line, ch: ct.start }, to: cur };
      }
    }
    return null;
  };
}

/* CodeMirror 5 封装：单一编辑器实例 + 每 Tab 一个 CodeMirror.Doc（swapDoc 切换，
 * 各文件独立撤销历史与光标）。mode 由 Doc 创建时指定。
 * 查找/替换用自带的 FindReplace 面板（addon 的对话框没有跳转按钮与匹配计数）。
 * 诊断：行号左侧 gutter 红橙点（点击触发 AI 修复）+ 行内波浪线（VSCode 风格）。
 * 选中内容后在行号列旁弹出 AI 快捷条（对话 / 润色 / 翻译），动作交给上层 onSelectionAction。 */
export default function EditorPane({ doc, onChange, onInit, onScrollRatio, onSave, diagnostics, onFixIssue, findReq, spellcheck, grammarCheck, aiProofread, aiChannel, typewriter, refCompletion, completion, onImageFile, onForwardSync, onSelectionAction }) {
  const hostRef = useRef(null);
  const cmRef = useRef(null);
  const marksRef = useRef([]);
  const [cmInst, setCmInst] = useState(null);
  const [findOpen, setFindOpen] = useState(false);
  // 选区快捷条：{top,left} 相对 #editorPane；null 隐藏。拖选进行中不弹（draggingRef）
  const [selPop, setSelPop] = useState(null);
  const draggingRef = useRef(false);
  const cb = useRef({});
  cb.current = { onChange, onInit, onScrollRatio, onSave, onFixIssue, onImageFile, onForwardSync, onSelectionAction };
  const refCompletionRef = useRef(refCompletion);
  refCompletionRef.current = refCompletion;
  const completionRef = useRef(completion);
  completionRef.current = completion;
  const typewriterRef = useRef(typewriter === true);
  typewriterRef.current = typewriter === true;

  // ---- 拼写检查：开关走 ref（初始化 effect 只挂一次监听），标记随 Doc 走 ----
  const spellEnabledRef = useRef(spellcheck !== false);
  spellEnabledRef.current = spellcheck !== false;
  const spellTimerRef = useRef(null);
  const spellMarksRef = useRef([]);  const clearSpellMarks = () => {
    spellMarksRef.current.forEach(m => { try { m.clear(); } catch (e) { /* ignore */ } });
    spellMarksRef.current = [];
  };
  const scheduleSpell = () => {
    if (!spellEnabledRef.current) return;
    clearTimeout(spellTimerRef.current);
    spellTimerRef.current = setTimeout(runSpell, 600);
  };
  async function runSpell() {
    const cm = cmRef.current;
    if (!cm || !spellEnabledRef.current) return;
    const checker = await loadSpellChecker();
    if (!checker || !spellEnabledRef.current) return;   // 词典不可用就不画，编辑不受阻
    const value = cm.getValue();
    // 拉词典期间用户还在输入：快照过期，重新排队，避免标记错位
    if (cm.getValue() !== value) { scheduleSpell(); return; }
    if (value.length > 400000) { clearSpellMarks(); return; }
    const typos = findTypos(value, checker).slice(0, 500);
    clearSpellMarks();
    const d = cm.getDoc();
    for (const t of typos) {
      try {
        spellMarksRef.current.push(d.markText(
          { line: t.line, ch: t.from }, { line: t.line, ch: t.to },
          { className: 'pl-spell', title: t.word }));
      } catch (e) { /* 行已被改短等边界忽略 */ }
    }
  }

  // ---- LanguageTool 语法检查（可选、联网）：掩码后直连公共接口，失败静默 ----
  // 发送的是遮罩文本：注释/公式/命令区域已替换为空格，不会把 LaTeX 结构发出去
  const grammarEnabledRef = useRef(grammarCheck === true);
  grammarEnabledRef.current = grammarCheck === true;
  const grammarTimerRef = useRef(null);
  const grammarGenRef = useRef(0);
  const grammarMarksRef = useRef([]);
  const grammarLastRef = useRef('');
  const clearGrammarMarks = () => {
    grammarMarksRef.current.forEach(m => { try { m.clear(); } catch (e) { /* ignore */ } });
    grammarMarksRef.current = [];
  };
  const scheduleGrammar = () => {
    if (!grammarEnabledRef.current) return;
    clearTimeout(grammarTimerRef.current);
    grammarTimerRef.current = setTimeout(runGrammar, 2000);
  };
  async function runGrammar() {
    const cm = cmRef.current;
    if (!cm || !grammarEnabledRef.current) return;
    const gen = ++grammarGenRef.current;
    const value = cm.getValue();
    if (value === grammarLastRef.current) return;   // 内容没变不重复请求
    if (!value.trim() || value.length > 120000) { clearGrammarMarks(); return; }
    const masked = maskNonProse(value);
    const chunks = splitChunks(masked, CHUNK_MAX, CHUNKS_PER_RUN);
    const marks = [];
    try {
      for (const chunk of chunks) {
        const r = await fetch(LT_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: buildRequestBody(chunk.text),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const json = await r.json();
        if (gen !== grammarGenRef.current) return;   // 输入已变/开关已关：丢弃本轮
        marks.push(...parseMatches(json, masked, chunk.offset));
      }
    } catch (e) { return; /* 公共接口限流/断网：语法检查是增值项，绝不打扰写作 */ }
    if (gen !== grammarGenRef.current) return;
    if (cm.getValue() !== value) { scheduleGrammar(); return; }   // 期间又改了：重排
    grammarLastRef.current = value;
    clearGrammarMarks();
    const d = cm.getDoc();
    const L = getLang();
    for (const mk of marks.slice(0, 200)) {
      const tip = mk.msg + (mk.replacements.length ? '\n' + tr(L, 'gm.suggest') + mk.replacements.join(' / ') : '');
      try {
        grammarMarksRef.current.push(d.markText(
          { line: mk.line, ch: mk.from }, { line: mk.endLine, ch: mk.to },
          { className: 'pl-grammar', title: tip }));
      } catch (e) { /* 行已被改短等边界忽略 */ }
    }
  }

  // ---- AI 用词检测（可选、联网）：LanguageTool 查不出的搭配/可数性交给用户配置的 LLM ----
  // 发送同样是遮罩文本（命令/公式不外发）；模型逐字引用原文片段，前端回定位画青色波浪线。
  // 比 LT 更贵：停顿 5 秒才触发，长文按块轮转，每轮只查一块，多次停顿逐步覆盖全文
  const aiProofEnabledRef = useRef(aiProofread === true);
  aiProofEnabledRef.current = aiProofread === true;
  const aiChannelRef = useRef(aiChannel || null);
  aiChannelRef.current = aiChannel || null;
  const aiTimerRef = useRef(null);
  const aiGenRef = useRef(0);
  const aiMarksRef = useRef([]);
  const aiLastRef = useRef('');
  const aiCursorRef = useRef(0);   // 下一块下标：内容没变时逐块推进，查完一轮就停
  const aiFoundRef = useRef([]);   // 各块累积的结构化标记，重画时用
  const clearAIMarks = () => {
    aiMarksRef.current.forEach(m => { try { m.clear(); } catch (e) { /* ignore */ } });
    aiMarksRef.current = [];
  };
  const drawAIMarks = () => {
    clearAIMarks();
    const cm = cmRef.current;
    if (!cm) return;
    const L = getLang();
    for (const mk of aiFoundRef.current.slice(0, 200)) {
      const tip = tr(L, 'gm.aiTag') + mk.msg + (mk.replacements.length ? '\n' + tr(L, 'gm.suggest') + mk.replacements.join(' / ') : '');
      try {
        aiMarksRef.current.push(cm.getDoc().markText(
          { line: mk.line, ch: mk.from }, { line: mk.endLine, ch: mk.to },
          { className: 'pl-ai-grammar', title: tip }));
      } catch (e) { /* 行已被改短等边界忽略 */ }
    }
  };
  const scheduleAIProof = () => {
    if (!aiProofEnabledRef.current) return;
    clearTimeout(aiTimerRef.current);
    aiTimerRef.current = setTimeout(runAIProof, 5000);
  };
  async function runAIProof() {
    const cm = cmRef.current;
    if (!cm || !aiProofEnabledRef.current) return;
    const channel = aiChannelRef.current;
    if (!channel || !channel.baseUrl) return;   // 未配置渠道：静默，不打扰写作
    const gen = ++aiGenRef.current;
    const value = cm.getValue();
    if (!value.trim() || value.length > 120000) { clearAIMarks(); aiFoundRef.current = []; return; }
    if (value !== aiLastRef.current) { aiLastRef.current = value; aiCursorRef.current = 0; aiFoundRef.current = []; }
    const masked = maskNonProse(value);
    const chunks = proofChunks(masked);
    if (aiCursorRef.current >= chunks.length) return;   // 全文查完：等下次修改
    const chunk = chunks[aiCursorRef.current];
    let marks = [];
    try {
      const r = await llmChat(channel, buildProofMessages(chunk.text), { maxTokens: 1600, noReasoning: true, timeoutMs: 60000 });
      if (gen !== aiGenRef.current) return;   // 输入已变/开关已关：丢弃本轮
      marks = parseAIResult(r.content, masked, chunk.offset);
    } catch (e) { aiCursorRef.current = (aiCursorRef.current + 1) % Math.max(1, chunks.length); return; /* 失败静默，轮转推进避免卡在同一块 */ }
    if (gen !== aiGenRef.current) return;
    if (cm.getValue() !== value) { scheduleAIProof(); return; }   // 期间又改了：重排
    aiFoundRef.current = aiFoundRef.current.concat(marks);
    aiCursorRef.current = (aiCursorRef.current + 1) % Math.max(1, chunks.length);
    drawAIMarks();
  }

  useEffect(() => {
    const cm = CodeMirror(hostRef.current, {
      value: '',
      lineNumbers: true,
      gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter', 'pl-diag-gutter'],
      lineWrapping: true,
      autoCloseBrackets: true,
      matchBrackets: true,
      styleActiveLine: true,
      // 代码折叠：花括号 + 缩进两种 rangeFinder（stex 没有专用 fold mode）
      foldGutter: true,
      foldOptions: { rangeFinder: CodeMirror.fold.combine(CodeMirror.fold.brace, CodeMirror.fold.indent) },
      extraKeys: {
        'Ctrl-S': () => { cb.current.onSave && cb.current.onSave(); return false; },
        'Cmd-S': () => { cb.current.onSave && cb.current.onSave(); return false; }
      }
    });
    cmRef.current = cm;
    setCmInst(cm);
    // 关闭隐藏 textarea 的拼写检查：Chromium 会把拼写红线“透”到可见行上，造成假报错
    const inp = cm.getInputField();
    inp.setAttribute('spellcheck', 'false');
    inp.setAttribute('autocorrect', 'off');
    inp.setAttribute('autocapitalize', 'off');
    cm.on('change', () => cb.current.onChange && cb.current.onChange(cm.getDoc(), cm.getValue()));
    cm.on('change', scheduleSpell);
    cm.on('change', scheduleGrammar);
    cm.on('change', scheduleAIProof);
    // 打字机滚动：光标（含点击定位）始终居中。cursorCoords('local') 相对编辑器盒顶，
    // 折算回内容坐标（+scrollTop）再减半屏即目标滚动位置
    cm.on('cursorActivity', () => {
      if (!typewriterRef.current) return;
      const si = cm.getScrollInfo();
      const co = cm.cursorCoords(null, 'local');
      cm.scrollTo(si.left, Math.max(0, co.top + si.top - si.clientHeight / 2));
    });
    // 自动补全（\ref/\cite、环境、文件名、命令）：打出命令后的 { 立即出全量候选，
    // 键入字符按前缀过滤；走 change 而不是 inputRead——autoCloseBrackets 插 “{}” 时
    // 只发 change，inputRead 收不到 {。菜单已开时交给 show-hint 自己的 update，不重复弹出
    const latexHint = buildLatexHint(refCompletionRef, completionRef);
    const openHint = () => {
      if (cm.state.completionActive) return;
      cm.showHint({
        hint: latexHint,
        completeSingle: false,
        closeCharacters: /[\s()\[\]{};:]>/   // 逗号除外：\cite{a,b} 补下一个键时菜单不收
      });
    };
    cm.on('change', (cm2, change) => {
      if (change.origin !== '+input') return;
      const cur = cm2.getCursor();
      const before = (cm2.getLine(cur.line) || '').slice(0, cur.ch);
      const typed = (change.text || []).join('');
      const m = matchRefContext(before);
      if (m) {
        if (before.endsWith('{')) openHint();
        else if (m.segment.length >= 1 && /^[A-Za-z0-9_:.\-]$/.test(typed)) openHint();
        return;
      }
      const cp = completionRef.current;
      if (!cp || !cp.texLike) return;
      if (matchEnvToken(before) && (before.endsWith('{') || /^[a-zA-Z*]$/.test(typed))) return openHint();
      const ft = matchFileToken(before);
      if (ft && (before.endsWith('{') || typed === ',' || /^[\w./\\\-:]$/.test(typed))) return openHint();
      const ct = matchCommandToken(before);
      if (ct && (typed === '\\' || /^[a-zA-Z*]$/.test(typed))) return openHint();
    });
    // 拖拽 / 粘贴图片：同步 preventDefault 阻止 CodeMirror 把文件名当文本插入，
    // 然后走与工具栏「插入图片」同一条路径（打开文件夹时写盘，否则 base64 / 资源标签）
    const imageFromEvent = (ev) => {
      const files = ev.dataTransfer ? ev.dataTransfer.files : (ev.clipboardData ? ev.clipboardData.files : null);
      if (!files || !files.length) return null;
      const f = Array.prototype.slice.call(files).filter(x => /^image\//.test(x.type) || /\.(png|jpe?g|gif|svg|eps|webp|bmp|pdf)$/i.test(x.name))[0];
      return f || null;
    };
    cm.on('drop', (instance, ev) => {
      const f = imageFromEvent(ev);
      if (!f) return;
      ev.preventDefault();
      let pos;
      try { pos = instance.coordsChar({ left: ev.clientX, top: ev.clientY }, 'window'); }
      catch (e) { pos = instance.getCursor(); }
      cb.current.onImageFile && cb.current.onImageFile(f, instance.getDoc(), pos, pos);
    });
    cm.on('paste', (instance, ev) => {
      const f = imageFromEvent(ev);
      if (!f) return;
      ev.preventDefault();
      const cur = instance.getCursor();
      cb.current.onImageFile && cb.current.onImageFile(f, instance.getDoc(), cur, cur);
    });
    cm.on('scroll', () => {
      const si = cm.getScrollInfo();
      const ratio = si.top / Math.max(1, si.height - si.clientHeight);
      cb.current.onScrollRatio && cb.current.onScrollRatio(ratio, 'edit');
    });
    // Ctrl+点击 → 正向同步跳 PDF（Overleaf 习惯）；移动端不传 onForwardSync 即不挂
    cm.on('mousedown', (instance, e) => {
      if (!e.ctrlKey || e.defaultPrevented || !cb.current.onForwardSync) return;
      e.preventDefault();
      const pos = instance.coordsChar({ left: e.clientX, top: e.clientY });
      if (pos) cb.current.onForwardSync(pos.line);
    });
    // ---- 选区 AI 快捷条：竖排小控件，整体落在行号列内（left 固定贴 gutter 左缘，
    // 不遮挡正文任何内容），top 跟随选区首行并夹在编辑器可视区内 ----
    const updateSelPop = () => {
      const c = cmRef.current;
      if (!c || !cb.current.onSelectionAction) { setSelPop(null); return; }
      if (!c.somethingSelected()) { setSelPop(null); return; }
      try {
        const from = c.getCursor('from');
        const co = c.charCoords(from, 'local');
        const host = hostRef.current;
        const maxTop = host ? Math.max(0, host.clientHeight - 96) : Infinity;
        const next = { top: Math.min(Math.max(0, co.top - 2), maxTop) };
        // cursorActivity（打字机模式下高频）只有位置真的变了才 setState
        setSelPop(prev => (prev && prev.top === next.top) ? prev : next);
      } catch (e) { setSelPop(null); }
    };
    cm.on('mousedown', () => { draggingRef.current = true; });
    cm.on('cursorActivity', () => { if (!draggingRef.current) updateSelPop(); });
    // 滚动后行号列位置不变但选区行变了：重算（选区滚出可视区时 charCoords 可能为负，夹到 0）
    cm.on('scroll', () => { if (cm.somethingSelected()) updateSelPop(); else setSelPop(null); });
    const onMouseUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      // CodeMirror 在 mouseup 后才提交最终选区，等一拍再定位
      setTimeout(updateSelPop, 0);
    };
    // 切走窗口（alt-tab/点别的应用）必然中断拖选：重置拖选态，
    // 否则快捷条要等到下一次点击才恢复刷新
    const onBlur = () => { draggingRef.current = false; };
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('blur', onBlur);
    cb.current.onInit && cb.current.onInit(cm);
    setTimeout(() => cm.refresh(), 50);
    return () => {
      clearTimeout(spellTimerRef.current);
      clearTimeout(grammarTimerRef.current);
      grammarGenRef.current++;
      clearTimeout(aiTimerRef.current);
      aiGenRef.current++;
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', onBlur);
      // 先脱开共享 Doc（避免 StrictMode 双挂载时 “document is already in use”）
      try { cm.swapDoc(new CodeMirror.Doc('', 'stex')); } catch (e) { /* ignore */ }
      const el = cm.getWrapperElement();
      if (el && el.parentNode) el.parentNode.removeChild(el);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const cm = cmRef.current;
    if (cm && doc && cm.getDoc() !== doc) {
      cm.swapDoc(doc);
      cm.refresh();
      cm.focus();
      setSelPop(null);          // 换文档后旧选区失效，快捷条收起
      clearSpellMarks();   // 标记属于旧 Doc；新 Doc 稍后由 scheduleSpell 重画
      scheduleSpell();
      clearGrammarMarks();
      grammarLastRef.current = '';   // 换文档：内容变了，允许立即重新检查
      scheduleGrammar();
      clearAIMarks();
      aiLastRef.current = '';
      aiCursorRef.current = 0;
      aiFoundRef.current = [];
      scheduleAIProof();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  // 设置里开关拼写检查：开→立即重画；关→清掉现有标记
  useEffect(() => {
    if (spellcheck !== false) scheduleSpell();
    else { clearTimeout(spellTimerRef.current); clearSpellMarks(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spellcheck]);

  // 语法检查同理；关掉时还要让在途请求的回执作废
  useEffect(() => {
    if (grammarCheck) scheduleGrammar();
    else { clearTimeout(grammarTimerRef.current); grammarGenRef.current++; clearGrammarMarks(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grammarCheck]);

  // AI 用词检测开关同语法检查；关掉时游标与累积结果一并作废
  useEffect(() => {
    if (aiProofread) scheduleAIProof();
    else { clearTimeout(aiTimerRef.current); aiGenRef.current++; clearAIMarks(); aiFoundRef.current = []; aiCursorRef.current = 0; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiProofread]);

  // App 的 Ctrl+F / Ctrl+Shift+F 与「编辑 → 查找替换」都通过 findReq 递增来唤起面板
  useEffect(() => { if (findReq) setFindOpen(true); }, [findReq]);

  // 诊断标记：按行分组（错误优先），gutter 圆点可点击触发 AI 修复，行内画波浪线
  useEffect(() => {
    const cm = cmRef.current;
    if (!cm) return;
    marksRef.current.forEach(m => { try { m.clear(); } catch (e) { /* ignore */ } });
    marksRef.current = [];
    cm.clearGutter && cm.clearGutter('pl-diag-gutter');

    const markedDoc = cm.getDoc();
    const issues = (diagnostics || []).filter(d => Number.isInteger(d.line) && d.line >= 0 && d.line < cm.lineCount());
    if (!issues.length) return;

    const byLine = new Map();
    for (const d of issues) {
      if (!byLine.has(d.line)) byLine.set(d.line, []);
      byLine.get(d.line).push(d);
    }

    for (const [ln, list] of byLine) {
      const isErr = list.some(d => d.severity === 'error');
      const tip = tr(getLang(), isErr ? 'ed.error' : 'ed.warning') + ': ' + list.map(d => d.msg).join('\n') + '\n' + tr(getLang(), 'ed.clickFix');

      const dot = document.createElement('div');
      dot.className = 'pl-diag-dot ' + (isErr ? 'err' : 'warn');
      dot.title = tip;
      dot.addEventListener('click', ev => {
        ev.preventDefault();
        // 同一行多个问题一并发给 AI，主问题放最前
        cb.current.onFixIssue && cb.current.onFixIssue(list[0], list);
      });

      const wrap = document.createElement('div');
      wrap.style.cssText = 'width:100%;text-align:center;';
      wrap.appendChild(dot);
      cm.setGutterMarker(ln, 'pl-diag-gutter', wrap);

      // 波浪线：行首非空白到行尾（去尾空白），hover 提示问题详情
      const text = cm.getLine(ln) || '';
      const from = (text.match(/^\s*/) || [''])[0].length;
      const to = Math.max(from + 1, text.replace(/\s+$/, '').length);
      try {
        marksRef.current.push(cm.markText(
          { line: ln, ch: from }, { line: ln, ch: to },
          { className: 'pl-diag-' + (isErr ? 'err' : 'warn') + '-text', title: tip }
        ));
      } catch (e) { /* 跨行等边界忽略 */ }
    }
    // Gutter markers belong to the Doc; clear that Doc even after swapDoc has run.
    return () => {
      marksRef.current.forEach(m => m.clear());
      marksRef.current = [];
      markedDoc.clearGutter('pl-diag-gutter');
    };
  }, [diagnostics, doc]);

  return (
    <div id="editorPane">
      <div id="editorHost" ref={hostRef} />
      {selPop && cmInst && (
        <div className="pl-selpop" style={{ top: selPop.top }} role="toolbar">
          {[['chat', '💬', 'selpop.chat'],
            ['polish', '✨', 'selpop.polish'],
            ['translate', '🌐', 'selpop.translate']].map(([act, icon, labelKey]) => (
            <button key={act} title={tr(getLang(), labelKey)} aria-label={tr(getLang(), labelKey)}
              onMouseDown={e => e.preventDefault()}
              onClick={() => {
                const text = cmInst.getSelection();
                setSelPop(null);
                if (text) cb.current.onSelectionAction && cb.current.onSelectionAction({ action: act, text });
              }}>
              {icon}
            </button>
          ))}
        </div>
      )}
      {cmInst && doc && (
        <FindReplace cm={cmInst} doc={doc} open={findOpen} request={findReq}
          onClose={() => { setFindOpen(false); cmInst.focus(); }} />
      )}
    </div>
  );
}

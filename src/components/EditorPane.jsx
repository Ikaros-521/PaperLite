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
import { buildChecker, findTypos } from '../spellcheck.js';
import { matchRefContext } from '../projectIndex.js';
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

/* 跨文件 \ref / \cite 补全：光标前行文本匹配出「命令 + 键片段」才给候选（matchRefContext）。
 * 命令含 cite 用 bibKeys，其余用 labels。逗号不在 closeCharacters 里，多键引用逗号后菜单仍在 */
function refHintFrom(refCompletionRef) {
  return function (cm) {
    const comp = refCompletionRef.current;
    if (!comp) return null;
    const cur = cm.getCursor();
    const before = (cm.getLine(cur.line) || '').slice(0, cur.ch);
    const m = matchRefContext(before);
    if (!m) return null;
    const seg = m.segment;
    const from = { line: cur.line, ch: cur.ch - seg.length };
    const pool = m.isCite ? (comp.bibKeys || []) : (comp.labels || []);
    const q = seg.toLowerCase();
    const seen = new Set();
    const list = [];
    for (const k of pool) {
      if (!k || !k.key || seen.has(k.key)) continue;
      if (q && k.key.toLowerCase().indexOf(q) < 0) continue;
      seen.add(k.key);
      list.push({ text: k.key, displayText: k.src ? k.key + '  ·  ' + k.src : k.key });
      if (list.length >= 50) break;
    }
    if (!list.length) return null;
    return { list, from, to: cur };
  };
}

/* CodeMirror 5 封装：单一编辑器实例 + 每 Tab 一个 CodeMirror.Doc（swapDoc 切换，
 * 各文件独立撤销历史与光标）。mode 由 Doc 创建时指定。
 * 查找/替换用自带的 FindReplace 面板（addon 的对话框没有跳转按钮与匹配计数）。
 * 诊断：行号左侧 gutter 红橙点（点击触发 AI 修复）+ 行内波浪线（VSCode 风格）。 */
export default function EditorPane({ doc, onChange, onInit, onScrollRatio, onSave, diagnostics, onFixIssue, findReq, spellcheck, refCompletion }) {
  const hostRef = useRef(null);
  const cmRef = useRef(null);
  const marksRef = useRef([]);
  const [cmInst, setCmInst] = useState(null);
  const [findOpen, setFindOpen] = useState(false);
  const cb = useRef({});
  cb.current = { onChange, onInit, onScrollRatio, onSave, onFixIssue };
  const refCompletionRef = useRef(refCompletion);
  refCompletionRef.current = refCompletion;

  // ---- 拼写检查：开关走 ref（初始化 effect 只挂一次监听），标记随 Doc 走 ----
  const spellEnabledRef = useRef(spellcheck !== false);
  spellEnabledRef.current = spellcheck !== false;
  const spellTimerRef = useRef(null);
  const spellMarksRef = useRef([]);
  const clearSpellMarks = () => {
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

  useEffect(() => {
    const cm = CodeMirror(hostRef.current, {
      value: '',
      lineNumbers: true,
      gutters: ['CodeMirror-linenumbers', 'pl-diag-gutter'],
      lineWrapping: true,
      autoCloseBrackets: true,
      matchBrackets: true,
      styleActiveLine: true,
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
    // \ref / \cite 自动补全：打出命令后的 { 立即出全量候选，键入字符按前缀过滤；
    // 走 change 而不是 inputRead——autoCloseBrackets 插 "{}" 时只发 change，inputRead 收不到 {
    // 菜单已开时交给 show-hint 自己的 update，不重复弹出
    const refHint = refHintFrom(refCompletionRef);
    const openRefHint = () => {
      if (cm.state.completionActive) return;
      cm.showHint({
        hint: refHint,
        completeSingle: false,
        closeCharacters: /[\s()\[\]{};:]>/   // 逗号除外：\cite{a,b} 补下一个键时菜单不收
      });
    };
    cm.on('change', (cm2, change) => {
      if (change.origin !== '+input') return;
      const cur = cm2.getCursor();
      const before = (cm2.getLine(cur.line) || '').slice(0, cur.ch);
      const m = matchRefContext(before);
      if (!m) return;
      const typed = (change.text || []).join('');
      if (before.endsWith('{')) openRefHint();
      else if (m.segment.length >= 1 && /^[A-Za-z0-9_:.\-]$/.test(typed)) openRefHint();
    });
    cm.on('scroll', () => {
      const si = cm.getScrollInfo();
      const ratio = si.top / Math.max(1, si.height - si.clientHeight);
      cb.current.onScrollRatio && cb.current.onScrollRatio(ratio, 'edit');
    });
    cb.current.onInit && cb.current.onInit(cm);
    setTimeout(() => cm.refresh(), 50);
    return () => {
      clearTimeout(spellTimerRef.current);
      // 先脱开共享 Doc（避免 StrictMode 双挂载时 "document is already in use"）
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
      clearSpellMarks();   // 标记属于旧 Doc；新 Doc 稍后由 scheduleSpell 重画
      scheduleSpell();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  // 设置里开关拼写检查：开→立即重画；关→清掉现有标记
  useEffect(() => {
    if (spellcheck !== false) scheduleSpell();
    else { clearTimeout(spellTimerRef.current); clearSpellMarks(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spellcheck]);

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
      {cmInst && doc && (
        <FindReplace cm={cmInst} doc={doc} open={findOpen} request={findReq}
          onClose={() => { setFindOpen(false); cmInst.focus(); }} />
      )}
    </div>
  );
}

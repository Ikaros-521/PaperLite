/**
 * AI Agent 工具层（桌面 AI 面板的 Agent 模式）。
 *
 * 纯逻辑模块：不 import React、不触碰 window/localStorage，Node 单测可直接跑。
 * 工具协议走「文本 fenced 块」而不是各家 tools API——OpenAI 兼容网关、
 * Anthropic 直连、Ollama 本机对 tools 字段的支持参差不齐，文本协议零兼容成本：
 *   模型需要调工具时输出  ```tool\n{"tool":"read_file","args":{"path":"main.tex"}}\n```
 * 本模块负责：解析模型输出（parseToolCalls）、执行器工厂（makeAgentExecutor）。
 * 工具「是什么」的定义（入参规格/是否改盘/失败降级/清单文本）在 toolRegistry.js，
 * 执行器只负责「怎么做」：每个调用先过注册表校验，非法参数不进工具实现。
 * 执行器依赖全部以 getter 注入，保证每次执行都取到最新的编辑器/标签/文件夹状态。
 */
import { tr, getLang } from '../i18n.js';
import { collectSearchFiles, searchInFiles } from '../searchIndex.js';
import { validateCall, contentSig, toolDef, MUTATING_TOOLS } from './toolRegistry.js';

export { toolsSchema, MUTATING_TOOLS, makeCallLedger } from './toolRegistry.js';

// 单个工具结果回传给模型前的长度上限：防止 read_file 大文档直接吃光上下文预算
export const TOOL_RESULT_MAX_CHARS = 12000;

function clampResult(text) {
  const s = String(text == null ? '' : text);
  if (s.length <= TOOL_RESULT_MAX_CHARS) return s;
  return s.slice(0, TOOL_RESULT_MAX_CHARS)
    + '\n…(' + tr(getLang(), 'agent.toolTruncated', { n: s.length - TOOL_RESULT_MAX_CHARS }) + ')';
}

// sig 取截断前的原文：两次读取都超出上限时，截断后的前缀可能一模一样，
// 拿成品算签名会把「尾部其实变了」判成相同内容。
function ok(result) { const s = String(result == null ? '' : result); return { ok: true, result: clampResult(s), sig: contentSig(s) }; }
function fail(msg, code) { return { ok: false, result: String(msg), code: code || '' }; }

// 嵌套量词的粗判：组内已带量词、组外面又跟量词（(a+)+ / (a*)* 这类爆炸串）。
// 再加上「组内交替 + 组外量词」（(a|aa)+ 型）：只靠嵌套判据漏得最多，因为它的组里
// 没有量词。不做完整的安全分析，挡住模型最常写出的两种就够了——正则是逐行在 UI 线程
// exec 的，一条病态模式就能冻住整个标签页；认不出的形态由 searchInFiles 的墙钟预算兜住。
// 指数回溯判据：逐层跟踪括号，「组里出现过量词或交替」且「这个组整体又跟了量词」
// 就是 (a+)+ / ((a)+)+c / (a|aa)+ 这一类。之前用两条正则去匹配这种形态，嵌套一层就漏
// （((a)+)+c 实测放行），而正则是逐行在 UI 线程 exec 的，一条病态模式就冻住整个标签页。
// \d{2} 这类量词也计入，宁可误拒一条合理模式，也不要放过一个冻结界面的
function riskyPattern(p) {
  const text = String(p || '');
  const stack = [{ quant: false, alt: false }];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '[') { const j = text.indexOf(']', i + 1); if (j < 0) return true; i = j; continue; }
    if (c === '(') { stack.push({ quant: false, alt: false }); continue; }
    if (c === ')') {
      if (stack.length < 2) return true;   // 括号不配对也当可疑：交给上层报错，不放进 exec
      const g = stack.pop();
      const quantified = /[+*?{]/.test(text[i + 1] || '');
      if (quantified && (g.quant || g.alt)) return true;
      const top = stack[stack.length - 1];
      if (quantified || g.quant || g.alt) top.quant = true;
      continue;
    }
    if (!stack.length) continue;
    const top = stack[stack.length - 1];
    if (c === '|') top.alt = true;
    else if (c === '+' || c === '*' || c === '?' || c === '{') top.quant = true;
  }
  return stack.length > 1;                   // 括号没闭合也拒
}
// 病态正则执行预算：单次搜索最多占 UI 线程这么久
const SEARCH_TIME_BUDGET_MS = 1200;

/** 路径任一段以 . 开头 = 隐藏文件或点开头的目录（. 与 .. 一起挡在门外） */
function hiddenPath(p) {
  return String(p || '').split('/').some(seg => seg.startsWith('.'));
}

// 会动到用户正文或落盘的工具：权限分档只对这类工具设门槛，读类工具任何档位直通
const BRIEF_LEN = 160;
const briefText = (s) => {
  const one = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return one.length > BRIEF_LEN ? one.slice(0, BRIEF_LEN) + '…' : one;
};

/* ---- 解析模型输出中的工具调用 ---- */

// [ \t\r]*：容忍部分网关输出的 CRLF 行尾，否则整个工具协议在该网关下静默失效
const TOOL_BLOCK = /```tool[ \t\r]*\n([\s\S]*?)```/g;

/**
 * 解析 assistant 文本里的全部工具调用块。
 * @returns {{calls: Array<{tool: string, args: object, raw: string}>, bad: string[]}}
 *   bad 收集解析失败的块原文（截断），回传给模型让它自行修正。
 */
export function parseToolCalls(text) {
  const calls = [];
  const bad = [];
  const s = String(text || '');
  TOOL_BLOCK.lastIndex = 0;
  let m;
  while ((m = TOOL_BLOCK.exec(s))) {
    const raw = (m[1] || '').trim();
    let j = null;
    try { j = JSON.parse(raw); } catch (e) { /* 记入 bad */ }
    if (j && typeof j.tool === 'string') {
      calls.push({ tool: j.tool, args: j.args && typeof j.args === 'object' ? j.args : {}, raw });
    } else {
      bad.push(raw.slice(0, 200));
    }
  }
  return { calls, bad };
}

/** 从文本中剥离工具块（界面渲染用：正文与工具卡片分开画）；
 *  流式进行中的 ```tool 块可能还没闭合，一并剥掉避免露出半截 JSON */
export function stripToolBlocks(text) {
  return String(text || '')
    .replace(/```tool[ \t\r]*\n[\s\S]*?```/g, '')
    .replace(/```tool[ \t\r]*\n[\s\S]*$/g, '')
    .trim();
}

/* ---- 文档大纲（agent 简报用，也方便模型定位章节） ---- */

export function outlineOf(text) {
  const re = /^\s*\\(chapter|section|subsection|title)\*?\s*\{([^}]*)\}/gm;
  const out = [];
  let m;
  while ((m = re.exec(String(text || ''))) && out.length < 40) {
    out.push(m[1] + '{' + m[2] + '}');
  }
  return out;
}

/* ---- 执行器 ---- */

/**
 * @param deps {{
 *   cm: () => any,                    // 活动 CodeMirror 实例（可能为 null）
 *   tabs: () => any[],                // 全部标签（工作区 tabsRef.current）
 *   activeId: () => any,
 *   tabPath: (tab: any) => string,    // 标签的项目相对路径
 *   folderIndex: () => {texFiles: any[], bibFiles: any[], textFiles: any[], imageFiles: any[]},
 *   rootDir: () => any,               // FileSystemDirectoryHandle | null
 *   getDiagnostics: () => any[],
 *   beforeEdit: (tab: any | null) => void, // 修改前快照（版本历史）；tab 为非活动标签，null 表示活动编辑器
 *   markDirty?: (tab: any) => void,        // 后台标签被改后补脏标记（不经过编辑器 change 事件）
 *   createFile: (path: string, content: string) => Promise<{ok: boolean, msg?: string}>,
 *   openByPath: (path: string) => Promise<{ok: boolean, msg?: string}>,
 *   approval?: () => 'ask' | 'auto' | 'full',  // 权限档位；缺省按 'auto'。只有 'full' 放开隐藏路径读取
 * }}
 * @returns {(name: string, args: object) => Promise<{ok: boolean, result: string}>}
 */
export function makeAgentExecutor(deps) {
  // 项目文件清单：打开标签（实时内容）优先，磁盘索引去重补齐（与全局搜索同一装配口径）
  function searchFiles() {
    // 活动 Tab 的 Doc 与 cm.getDoc() 是同一对象，直接读 doc 拿到的就是编辑中的实时内容
    const tabsList = (deps.tabs() || [])
      .filter(x => x && x.doc)
      .map(x => ({ path: deps.tabPath(x), name: x.name, text: x.doc.getValue() }));
    const fi = deps.folderIndex() || {};
    const disk = [
      ...((fi.texFiles || []).map(f => ({ path: f.path, text: f.source }))),
      ...((fi.bibFiles || []).map(f => ({ path: f.path, text: f.source }))),
      ...((fi.textFiles || []).map(f => ({ path: f.path, text: f.source }))),
    ];
    // 搜索命中等于整行内容进结果，与 read_file 同一条隐私口径：隐藏路径默认不进候选。
    // 两份清单各自过滤——合并成一个数组会让 collectSearchFiles 把磁盘文件标成已打开
    const keep = (f) => !hiddenBlocked(f.path);
    return collectSearchFiles(tabsList.filter(keep), disk.filter(keep));
  }

  // 权限档位：'ask' 每个改动手先确认；'auto' 不打断（默认）；'full' 免确认且放开
  // 隐藏文件读取。没注入就当 'auto'——保守档，不会误开全访问。
  const level = () => (typeof deps.approval === 'function' ? deps.approval() : 'auto') || 'auto';

  // 隐藏路径的闸必须一次算在所有读盘入口上：扫描（App.jsx folderIndex）只跳过
  // JUNK 那几个名字，.notes/ 之类的点开头目录照样进索引，闸只管磁盘兜底分支等于没管
  const hiddenBlocked = (p) => hiddenPath(p) && level() !== 'full';

  async function readFromDisk(path) {
    const root = deps.rootDir();
    if (!root) return null;
    const parts = String(path).split('/').filter(Boolean);
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
    const handle = await dir.getFileHandle(parts[parts.length - 1]);
    const file = await handle.getFile();
    if (file.size > 2 * 1024 * 1024) throw new Error(tr(getLang(), 'agent.toolTooLarge'));
    return await file.text();
  }

  const toolListFiles = () => {
    const L = getLang();
    const lines = [];
    const tabs = (deps.tabs() || []).filter(x => x && x.doc);
    if (tabs.length) {
      lines.push(tr(L, 'agent.filesOpen'));
      for (const tb of tabs) lines.push('  ' + deps.tabPath(tb) + (tb.id === deps.activeId() ? '  ← ' + tr(L, 'agent.filesActive') : ''));
    }
    const fi = deps.folderIndex() || {};
    // 清单与读取同一口径：默认不把隐藏路径报给模型，否则等于指着它让它去 read_file
    const disk = [
      ...((fi.texFiles || []).map(f => f.path)),
      ...((fi.bibFiles || []).map(f => f.path)),
      ...((fi.textFiles || []).map(f => f.path)),
      // 图片清单存的是字符串路径（App 扫描时 push 的就是 path），旧写法取 f.path/f.name
      // 会得到一串 undefined，模型看不见图名只能瞎猜
      ...((fi.imageFiles || []).map(f => (typeof f === 'string' ? f : (f && (f.path || f.name))) || '').filter(Boolean)),
    ].filter(p => !hiddenBlocked(p));
    if (disk.length) {
      const opened = new Set(tabs.map(deps.tabPath));
      lines.push(tr(L, 'agent.filesFolder'));
      for (const p of disk) if (!opened.has(p)) lines.push('  ' + p);
    }
    if (!lines.length) return ok(tr(L, 'agent.filesEmpty'));
    return ok(lines.join('\n'));
  };

  async function toolReadFile(args) {
    const L = getLang();
    const path = String(args.path || '').trim();
    // 默认不放开隐藏文件：用户选的目录可能很宽（家目录/文档），.env、.git/config
    // 一旦被模型指名读到，就变成下一次请求里发给第三方渠道的素材。「完全访问」档由
    // 用户明确放弃这层保护，才允许读隐藏路径。闸只管磁盘兜底是不够的——扫描会把点开头
    // 目录里的 .tex/.md/.bib 整份存进 folderIndex，已打开的标签同样可能是隐藏路径
    if (hiddenBlocked(path)) return fail(tr(L, 'agent.errHiddenPath', { path }), 'hidden_path');

    function wrapReadFileResult(rawText) {
      const s = String(rawText == null ? '' : rawText);
      const sig = contentSig(s);
      const from = args.from_line, count = args.max_lines;
      let picked = s;
      if (from || count) {
        const lines = s.split('\n');
        const a = Math.max(0, (from || 1) - 1);
        const b = count ? a + count : lines.length;
        picked = lines.slice(a, b).join('\n');
      }
      // sig 沿用整篇的签名：它只回答「底层内容变没变」，与这次截取的区间无关，
      // 两次同区间重读因此能正确判重；切片后产物再过 clampResult
      return { ok: true, result: clampResult(picked), sig };
    }

    // 1) 打开的标签（拿编辑中的实时内容）
    const tab = (deps.tabs() || []).find(x => x && x.doc && deps.tabPath(x) === path);
    if (tab) return wrapReadFileResult(tab.id === deps.activeId() ? (deps.cm() ? deps.cm().getValue() : tab.doc.getValue()) : tab.doc.getValue());
    // 2) 文件夹索引（已扫描进内存的 .tex/.bib/.txt）
    const fi = deps.folderIndex() || {};
    const entry = [...(fi.texFiles || []), ...(fi.bibFiles || []), ...(fi.textFiles || [])].find(f => f.path === path);
    if (entry && typeof entry.source === 'string') return wrapReadFileResult(entry.source);
    // 3) 直读磁盘（未进索引的文件类型）；区分「不存在」与「读取失败」——
    //    权限/超大/非法路径等原因如实回传，避免模型误以为文件不存在而反复重读或盲目重建
    try {
      const text = await readFromDisk(path);
      if (text != null) return wrapReadFileResult(text);
    } catch (e) {
      if (e && e.name === 'NotFoundError') return fail(tr(L, 'agent.errFileNotFound', { path }), 'file_not_found');
      // 超大文件走 too_large：降级建议是「用行区间局部读」，不是「换工具」
      if (e && /2MB|toolTooLarge/.test(String(e.message || e))) return fail(e.message, 'too_large');
      return fail(tr(L, 'agent.toolCrashed', { msg: (e && e.message) || e }), 'tool_crashed');
    }
    return fail(tr(L, 'agent.errFileNotFound', { path }), 'file_not_found');
  }

  function toolSearch(args) {
    const L = getLang();
    // query 的必填与长度上限在注册表里，这里只留「跑起来才知道」的语义检查
    const query = String(args.query || '');
    if (args.regex === true && riskyPattern(query)) return fail(tr(L, 'agent.errRegexUnsafe'), 'regex_unsafe');
    const r = searchInFiles(searchFiles(), {
      query,
      regex: args.regex === true,
      matchCase: args.match_case === true || args.matchCase === true,
      wholeWord: args.whole_word === true || args.wholeWord === true,
      timeBudgetMs: SEARCH_TIME_BUDGET_MS,
    });
    if (!r.ok) return fail(tr(L, 'agent.errBadRegex'), 'bad_regex');
    if (!r.matches.length) return ok(tr(L, 'agent.searchNoHit', { query }));
    const shown = r.matches.slice(0, 40)
      .map(m => m.path + ':' + (m.line + 1) + ': ' + m.text.trim().slice(0, 160));
    const head = tr(L, 'agent.searchHit', { n: r.matches.length, files: r.fileCount })
      + (r.truncated || r.matches.length > 40 ? ' ' + tr(L, 'agent.searchTrunc') : '') + '\n';
    return ok(head + shown.join('\n'));
  }

  function toolDiagnostics() {
    const L = getLang();
    const list = deps.getDiagnostics() || [];
    if (!list.length) return ok(tr(L, 'agent.diagClean'));
    const shown = list.slice(0, 50)
      .map(d => '- ' + tr(L, 'ai.errLine', { n: d.line != null ? d.line + 1 : '?', msg: d.msg }));
    return ok(shown.join('\n') + (list.length > 50 ? '\n…' : ''));
  }

  function toolReadSelection() {
    const L = getLang();
    const c = deps.cm();
    if (!c) return fail(tr(L, 'agent.errNoEditor'), 'no_editor');
    const sel = c.getSelection();
    if (!sel) return ok(tr(L, 'agent.selEmpty'));
    return ok(sel);
  }

  /* 编辑目标解析：path 让模型指名要改哪个文件。省略 path 时沿用「活动编辑器」旧行为，
     但结果必须回显文件名——agent 自己的 open_file 或用户点一下标签都会切换活动文档，
     不回显就是把「改错文件」藏成一次静默的 replaceRange。 */
  function resolveTarget(args) {
    const L = getLang();
    const path = String(args.path || '').trim();
    const tabs = deps.tabs() || [];
    if (!path) {
      const c = deps.cm();
      if (!c) return { err: tr(L, 'agent.errNoEditor'), code: 'no_editor' };
      const active = tabs.find(x => x && x.id === deps.activeId());
      const activePath = active ? deps.tabPath(active) : '';
      // 读闸不能只盖 read_file：活动标签本身可能就是一个隐藏路径文件，
      // 不在这里拦，省略 path 的 edit_file 照样能改它
      if (hiddenBlocked(activePath)) return { err: tr(L, 'agent.errHiddenPath', { path: activePath }), code: 'hidden_path' };
      return { doc: c, tab: null, label: activePath };
    }
    if (hiddenBlocked(path)) return { err: tr(L, 'agent.errHiddenPath', { path }), code: 'hidden_path' };
    const tab = tabs.find(x => x && x.doc && deps.tabPath(x) === path);
    if (tab) return { doc: tab.doc, tab, label: path };
    return { err: tr(L, 'agent.errNotOpen', { path }), code: 'not_open' };
  }

  const labelOf = (t) => t || tr(getLang(), 'agent.filesActive');

  // 回滚要找的是「文件路径」，不是给人看的标签（省略 path 时 labelOf 会回「当前编辑」）。
  // 快照 id 由 deps.beforeEdit 返回——版本历史那一头才有 id，工具这头只能转述。
  const activePath = () => {
    const a = (deps.tabs() || []).find(x => x && x.id === deps.activeId());
    return a ? deps.tabPath(a) : '';
  };
  const pathOf = (target) => (target.tab ? deps.tabPath(target.tab) : activePath());

  function toolEditFile(args) {
    const L = getLang();
    const oldText = String(args.old_text == null ? '' : args.old_text);
    const newText = String(args.new_text == null ? '' : args.new_text);
    const target = resolveTarget(args);
    if (target.err) return fail(target.err, target.code);
    const doc = target.doc;
    const value = doc.getValue();
    const first = value.indexOf(oldText);
    if (first < 0) return fail(tr(L, 'agent.errOldNotFound'), 'old_not_found');
    if (value.indexOf(oldText, first + 1) >= 0) return fail(tr(L, 'agent.errOldAmbiguous'), 'old_ambiguous');
    const versionId = deps.beforeEdit ? deps.beforeEdit(target.tab) : null;
    const from = doc.posFromIndex(first);
    const to = doc.posFromIndex(first + oldText.length);
    doc.replaceRange(newText, from, to);
    // 后台标签的 Doc 没有挂载编辑器，改动不会经过 change 事件：不补脏标记，
    // 关标签时会跳过「未保存确认」，把 agent 刚写进去的内容一起丢掉
    if (target.tab && deps.markDirty) deps.markDirty(target.tab);
    return { ...ok(tr(L, 'agent.editDone', { path: labelOf(target.label), n: newText.length })), file: pathOf(target), versionId };
  }

  function toolInsert(args) {
    const L = getLang();
    const c = deps.cm();
    if (!c) return fail(tr(L, 'agent.errNoEditor'), 'no_editor');
    const text = String(args.text == null ? '' : args.text);
    const path = String(args.path || '').trim();
    const activePathNow = activePath();
    if (hiddenBlocked(activePathNow)) return fail(tr(L, 'agent.errHiddenPath', { path: activePathNow }), 'hidden_path');
    // 插入点定义就是「用户眼前的光标」：跨文档插入没有语义，宁可拒绝也不写进别的文件
    if (path && path !== activePathNow) return fail(tr(L, 'agent.errInsertActiveOnly', { path, active: labelOf(activePathNow) }), 'insert_active_only');
    const versionId = deps.beforeEdit ? deps.beforeEdit(null) : null;
    // 插入点的语义是「光标处插入」：CM5 的 replaceSelection 在有选区时是*替换*，
    // 划词问 Agent 之后它插一段话，用户选中的正文就没了
    const cur = c.getCursor();
    c.replaceRange(text, cur, cur);
    return { ...ok(tr(L, 'agent.insertDone', { path: labelOf(activePathNow) })), file: activePathNow, versionId };
  }

  // 「每次审核」档要用给人看的确认文案：路径解析与工具真正落点走同一条（resolveTarget），
  // 免得弹窗说改 a.tex、实际写进了别的文件
  function describe(name, args) {
    const L = getLang();
    const a = args && typeof args === 'object' ? args : {};
    const mutates = MUTATING_TOOLS.has(name);
    if (name === 'edit_file') {
      const target = resolveTarget(a);
      return { mutates, tool: name, path: target.err ? String(a.path || '') : labelOf(target.label),
        detail: tr(L, 'agent.reviewEdit', { old: briefText(a.old_text), next: briefText(a.new_text) }) };
    }
    if (name === 'insert_text') {
      const active = (deps.tabs() || []).find(x => x && x.id === deps.activeId());
      return { mutates, tool: name, path: labelOf(active ? deps.tabPath(active) : ''),
        detail: tr(L, 'agent.reviewInsert', { text: briefText(a.text) }) };
    }
    if (name === 'create_file') {
      const content = String(a.content == null ? '' : a.content);
      return { mutates, tool: name, path: String(a.path || ''),
        detail: tr(L, 'agent.reviewCreate', { n: content.length, first: briefText(content.split('\n')[0] || '') }) };
    }
    return { mutates, tool: name, path: String(a.path || ''), detail: '' };
  }

  const execute = async function (name, args) {
    // 校验先行：必填缺失、类型不对、超长度上限的调用不进工具实现。运行循环也会先过
    // 一遍（framework 侧拦截并记审计），这里是第二道——测试与任何直接调用执行器的
    // 路径都走同一条规格，不会出现「绕过循环就没校验」。
    const v = validateCall(name, args);
    if (!v.ok) return fail(v.error, v.code);
    const a = v.args;
    const def = toolDef(name);
    // 计划类动作的落点是任务状态，归运行循环处理；真到了文件执行器说明调用方漏了分发
    if (!def || def.domain !== 'fs') return fail(tr(getLang(), 'agent.errTaskToolDirect'), 'task_tool_direct');
    try {
      switch (name) {
        case 'list_files': return toolListFiles();
        case 'read_file': return await toolReadFile(a);
        case 'search_files': return toolSearch(a);
        case 'get_diagnostics': return toolDiagnostics();
        case 'read_selection': return toolReadSelection();
        case 'edit_file': return toolEditFile(a);
        case 'insert_text': return toolInsert(a);
        case 'create_file': {
          const r = await deps.createFile(String(a.path || ''), String(a.content == null ? '' : a.content));
          // 依赖方（App 的建文件入口）自带错误码：沿用它，注册表才知道该给哪条降级建议
          // file 用依赖方规范化后的真实路径——模型写「./a/../../b.tex」时落点不是它写的那个
          return r && r.ok ? { ...ok(r.msg || 'ok'), file: r.path || String(a.path || '') }
            : fail((r && r.msg) || tr(getLang(), 'agent.errCreateFailed'), (r && r.code) || 'create_failed');
        }
        case 'open_file': {
          const p = String(a.path || '').trim();
          // 打开也是读文件的入口：默认档不让模型借「先打开、再省略 path 修改」绕过读闸
          if (hiddenBlocked(p)) return fail(tr(getLang(), 'agent.errHiddenPath', { path: p }), 'hidden_path');
          const r = await deps.openByPath(p);
          return r && r.ok ? ok(r.msg || 'ok') : fail(r && r.msg || tr(getLang(), 'agent.errFileNotFound', { path: p }), (r && r.code) || 'file_not_found');
        }
        default: return fail(tr(getLang(), 'agent.errUnknownTool', { name: String(name) }), 'unknown_tool');
      }
    } catch (e) {
      return fail(tr(getLang(), 'agent.toolCrashed', { msg: (e && e.message) || e }), 'tool_crashed');
    }
  };
  execute.describe = describe;
  execute.level = level;
  return execute;
}

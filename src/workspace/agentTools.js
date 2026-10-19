/**
 * AI Agent 工具层（桌面 AI 面板的 Agent 模式）。
 *
 * 纯逻辑模块：不 import React、不触碰 window/localStorage，Node 单测可直接跑。
 * 工具协议走「文本 fenced 块」而不是各家 tools API——OpenAI 兼容网关、
 * Anthropic 直连、Ollama 本机对 tools 字段的支持参差不齐，文本协议零兼容成本：
 *   模型需要调工具时输出  ```tool\n{"tool":"read_file","args":{"path":"main.tex"}}\n```
 * 本模块负责：解析模型输出（parseToolCalls）、工具清单文本（toolsSchema）、
 * 执行器工厂（makeAgentExecutor）。执行器依赖全部以 getter 注入，
 * 保证每次执行都取到最新的编辑器/标签/文件夹状态。
 */
import { tr, getLang } from '../i18n.js';
import { collectSearchFiles, searchInFiles } from '../searchIndex.js';

// 单个工具结果回传给模型前的长度上限：防止 read_file 大文档直接吃光上下文预算
export const TOOL_RESULT_MAX_CHARS = 12000;

function clampResult(text) {
  const s = String(text == null ? '' : text);
  if (s.length <= TOOL_RESULT_MAX_CHARS) return s;
  return s.slice(0, TOOL_RESULT_MAX_CHARS)
    + '\n…(' + tr(getLang(), 'agent.toolTruncated', { n: s.length - TOOL_RESULT_MAX_CHARS }) + ')';
}

function ok(result) { return { ok: true, result: clampResult(result) }; }
function fail(msg) { return { ok: false, result: String(msg) }; }

// 嵌套量词的粗判：组内已带量词、组外面又跟量词（(a+)+ / (a*)* 这类爆炸串）。
// 不做完整的安全分析，挡住模型最常写出的那种就够了——正则是逐行在 UI 线程 exec 的。
const NESTED_QUANT = /\([^()]*(?:[+*?])\)[+*?{]/;
const SEARCH_QUERY_MAX = 200;

/** 路径任一段以 . 开头 = 隐藏文件或点开头的目录（. 与 .. 一起挡在门外） */
function hiddenPath(p) {
  return String(p || '').split('/').some(seg => seg.startsWith('.'));
}

/* ---- 模型侧工具清单（描述随界面语言） ---- */

export function toolsSchema() {
  const L = getLang();
  const lines = [
    '- list_files：' + tr(L, 'agent.tListFiles'),
    '- read_file {path}：' + tr(L, 'agent.tReadFile'),
    '- open_file {path}：' + tr(L, 'agent.tOpenFile'),
    '- search_files {query, regex?, match_case?, whole_word?}：' + tr(L, 'agent.tSearch'),
    '- read_selection：' + tr(L, 'agent.tReadSel'),
    '- get_diagnostics：' + tr(L, 'agent.tDiag'),
    '- edit_file {old_text, new_text, path?}：' + tr(L, 'agent.tEditFile'),
    '- insert_text {text}：' + tr(L, 'agent.tInsert'),
    '- create_file {path, content}：' + tr(L, 'agent.tCreateFile'),
  ];
  return lines.join('\n');
}

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
 * }}
 * @returns {(name: string, args: object) => Promise<{ok: boolean, result: string}>}
 */
export function makeAgentExecutor(deps) {
  // 项目文件清单：打开标签（实时内容）优先，磁盘索引去重补齐（与全局搜索同一装配口径）
  function searchFiles() {
    const L = getLang();
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
    return collectSearchFiles(tabsList, disk);
  }

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
    const disk = [
      ...((fi.texFiles || []).map(f => f.path)),
      ...((fi.bibFiles || []).map(f => f.path)),
      ...((fi.textFiles || []).map(f => f.path)),
      // 图片清单存的是字符串路径（App 扫描时 push 的就是 path），旧写法取 f.path/f.name
      // 会得到一串 undefined，模型看不见图名只能瞎猜
      ...((fi.imageFiles || []).map(f => (typeof f === 'string' ? f : (f && (f.path || f.name))) || '').filter(Boolean)),
    ];
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
    if (!path) return fail(tr(L, 'agent.errNoPath'));
    // 1) 打开的标签（拿编辑中的实时内容）
    const tab = (deps.tabs() || []).find(x => x && x.doc && deps.tabPath(x) === path);
    if (tab) return ok(tab.id === deps.activeId() ? (deps.cm() ? deps.cm().getValue() : tab.doc.getValue()) : tab.doc.getValue());
    // 2) 文件夹索引（已扫描进内存的 .tex/.bib/.txt）
    const fi = deps.folderIndex() || {};
    const entry = [...(fi.texFiles || []), ...(fi.bibFiles || []), ...(fi.textFiles || [])].find(f => f.path === path);
    if (entry && typeof entry.source === 'string') return ok(entry.source);
    // 3) 直读磁盘（未进索引的文件类型）；区分「不存在」与「读取失败」——
    //    权限/超大/非法路径等原因如实回传，避免模型误以为文件不存在而反复重读或盲目重建
    //    磁盘兜底不放开隐藏文件：用户选的目录可能很宽（家目录/文档），.env、.git/config
    //    一旦被模型指名读到，就变成下一次请求里发给第三方渠道的素材
    if (hiddenPath(path)) return fail(tr(L, 'agent.errHiddenPath', { path }));
    try {
      const text = await readFromDisk(path);
      if (text != null) return ok(text);
    } catch (e) {
      if (e && e.name === 'NotFoundError') return fail(tr(L, 'agent.errFileNotFound', { path }));
      return fail(tr(L, 'agent.toolCrashed', { msg: (e && e.message) || e }));
    }
    return fail(tr(L, 'agent.errFileNotFound', { path }));
  }

  function toolSearch(args) {
    const L = getLang();
    const query = String(args.query || '');
    if (!query) return fail(tr(L, 'agent.errNoQuery'));
    if (query.length > SEARCH_QUERY_MAX) return fail(tr(L, 'agent.errQueryTooLong', { n: SEARCH_QUERY_MAX }));
    if (args.regex === true && NESTED_QUANT.test(query)) return fail(tr(L, 'agent.errRegexUnsafe'));
    const r = searchInFiles(searchFiles(), {
      query,
      regex: args.regex === true,
      matchCase: args.match_case === true || args.matchCase === true,
      wholeWord: args.whole_word === true || args.wholeWord === true,
    });
    if (!r.ok) return fail(tr(L, 'agent.errBadRegex'));
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
    if (!c) return fail(tr(L, 'agent.errNoEditor'));
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
      if (!c) return { err: tr(L, 'agent.errNoEditor') };
      const active = tabs.find(x => x && x.id === deps.activeId());
      return { doc: c, tab: null, label: active ? deps.tabPath(active) : '' };
    }
    const tab = tabs.find(x => x && x.doc && deps.tabPath(x) === path);
    if (tab) return { doc: tab.doc, tab, label: path };
    return { err: tr(L, 'agent.errNotOpen', { path }) };
  }

  const labelOf = (t) => t || tr(getLang(), 'agent.filesActive');

  function toolEditFile(args) {
    const L = getLang();
    const oldText = String(args.old_text == null ? '' : args.old_text);
    const newText = String(args.new_text == null ? '' : args.new_text);
    if (!oldText) return fail(tr(L, 'agent.errNoOldText'));
    const target = resolveTarget(args);
    if (target.err) return fail(target.err);
    const doc = target.doc;
    const value = doc.getValue();
    const first = value.indexOf(oldText);
    if (first < 0) return fail(tr(L, 'agent.errOldNotFound'));
    if (value.indexOf(oldText, first + 1) >= 0) return fail(tr(L, 'agent.errOldAmbiguous'));
    if (deps.beforeEdit) deps.beforeEdit(target.tab);
    const from = doc.posFromIndex(first);
    const to = doc.posFromIndex(first + oldText.length);
    doc.replaceRange(newText, from, to);
    // 后台标签的 Doc 没有挂载编辑器，改动不会经过 change 事件：不补脏标记，
    // 关标签时会跳过「未保存确认」，把 agent 刚写进去的内容一起丢掉
    if (target.tab && deps.markDirty) deps.markDirty(target.tab);
    return ok(tr(L, 'agent.editDone', { path: labelOf(target.label), n: newText.length }));
  }

  function toolInsert(args) {
    const L = getLang();
    const c = deps.cm();
    if (!c) return fail(tr(L, 'agent.errNoEditor'));
    const text = String(args.text == null ? '' : args.text);
    if (!text) return fail(tr(L, 'agent.errNoOldText'));
    const path = String(args.path || '').trim();
    const active = (deps.tabs() || []).find(x => x && x.id === deps.activeId());
    const activePath = active ? deps.tabPath(active) : '';
    // 插入点定义就是「用户眼前的光标」：跨文档插入没有语义，宁可拒绝也不写进别的文件
    if (path && path !== activePath) return fail(tr(L, 'agent.errInsertActiveOnly', { path, active: labelOf(activePath) }));
    if (deps.beforeEdit) deps.beforeEdit(null);
    // 插入点的语义是「光标处插入」：CM5 的 replaceSelection 在有选区时是*替换*，
    // 划词问 Agent 之后它插一段话，用户选中的正文就没了
    const cur = c.getCursor();
    c.replaceRange(text, cur, cur);
    return ok(tr(L, 'agent.insertDone', { path: labelOf(activePath) }));
  }

  return async function execute(name, args) {
    const a = args && typeof args === 'object' ? args : {};
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
          return r && r.ok ? ok(r.msg || 'ok') : fail((r && r.msg) || tr(getLang(), 'agent.errCreateFailed'));
        }
        case 'open_file': {
          const r = await deps.openByPath(String(a.path || ''));
          return r && r.ok ? ok(r.msg || 'ok') : fail((r && r.msg) || tr(getLang(), 'agent.errFileNotFound', { path: String(a.path || '') }));
        }
        default: return fail(tr(getLang(), 'agent.errUnknownTool', { name: String(name) }));
      }
    } catch (e) {
      return fail(tr(getLang(), 'agent.toolCrashed', { msg: (e && e.message) || e }));
    }
  };
}

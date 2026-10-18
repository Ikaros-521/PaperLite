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
    '- edit_file {old_text, new_text}：' + tr(L, 'agent.tEditFile'),
    '- insert_text {text}：' + tr(L, 'agent.tInsert'),
    '- create_file {path, content}：' + tr(L, 'agent.tCreateFile'),
  ];
  return lines.join('\n');
}

/* ---- 解析模型输出中的工具调用 ---- */

const TOOL_BLOCK = /```tool[ \t]*\n([\s\S]*?)```/g;

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
    .replace(/```tool[ \t]*\n[\s\S]*?```/g, '')
    .replace(/```tool[ \t]*\n[\s\S]*$/g, '')
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
 *   beforeEdit: () => void,           // 修改文档前快照（版本历史，Ctrl+Z 兜底）
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
      ...((fi.imageFiles || []).map(f => (f.path || f.name))),
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
    // 3) 直读磁盘（未进索引的文件类型）
    try {
      const text = await readFromDisk(path);
      if (text != null) return ok(text);
    } catch (e) { /* 落到统一报错 */ }
    return fail(tr(L, 'agent.errFileNotFound', { path }));
  }

  function toolSearch(args) {
    const L = getLang();
    const query = String(args.query || '');
    if (!query) return fail(tr(L, 'agent.errNoQuery'));
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

  function toolEditFile(args) {
    const L = getLang();
    const c = deps.cm();
    if (!c) return fail(tr(L, 'agent.errNoEditor'));
    const oldText = String(args.old_text == null ? '' : args.old_text);
    const newText = String(args.new_text == null ? '' : args.new_text);
    if (!oldText) return fail(tr(L, 'agent.errNoOldText'));
    const value = c.getValue();
    const first = value.indexOf(oldText);
    if (first < 0) return fail(tr(L, 'agent.errOldNotFound'));
    if (value.indexOf(oldText, first + 1) >= 0) return fail(tr(L, 'agent.errOldAmbiguous'));
    if (deps.beforeEdit) deps.beforeEdit();
    const from = c.posFromIndex(first);
    const to = c.posFromIndex(first + oldText.length);
    c.replaceRange(newText, from, to);
    return ok(tr(L, 'agent.editDone', { n: newText.length }));
  }

  function toolInsert(args) {
    const L = getLang();
    const c = deps.cm();
    if (!c) return fail(tr(L, 'agent.errNoEditor'));
    const text = String(args.text == null ? '' : args.text);
    if (!text) return fail(tr(L, 'agent.errNoOldText'));
    if (deps.beforeEdit) deps.beforeEdit();
    c.replaceSelection(text);
    return ok(tr(L, 'agent.insertDone'));
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

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from 'codemirror';
import Toolbar from './components/Toolbar.jsx';
import EditorPane from './components/EditorPane.jsx';
import PreviewPane from './components/PreviewPane.jsx';
import StylePanel from './components/StylePanel.jsx';
import FileTree from './components/FileTree.jsx';
import TabsBar from './components/TabsBar.jsx';
import OutlinePanel from './components/OutlinePanel.jsx';
import DiagnosticsPanel from './components/DiagnosticsPanel.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import SettingsDialog from './components/SettingsDialog.jsx';
import { renderLatex } from './engines/latex.js';
import { renderMarkdownFull } from './engines/markdown.js';
import { lintLaTeX } from './engines/linter.js';
import { samples } from './engines/samples.js';
import { downloadFile, exportTex as exportTexFile, exportPDF } from './exporter.js';
import { infoFor } from './fileTypes.js';
import * as fs from './fs.js';
import * as llm from './llm.js';
import { LS_LANG, detectLang, getLang, setLang as setModuleLang, tr } from './i18n.js';
import { LangContext, useT } from './useI18n.js';

const LS_KEY = 'paperlite.doc.v2';
const LS_MODE = 'paperlite.viewmode.v2';
let lastRenderMs = 0;
let tabSeq = 0;

// 插入片段中的示例文字随界面语言变化（LaTeX 命令本身不变）
const makeSnippets = (t) => ({
  tEq: '\n\\begin{equation}\n  \n\\end{equation}\n',
  tList: '\n\\begin{itemize}\n  \\item \n\\end{itemize}\n',
  tEnum: '\n\\begin{enumerate}\n  \\item \n\\end{enumerate}\n',
  tTable: '\n\\begin{table}[h]\n\\centering\n\\begin{tabular}{lcc}\n\\toprule\n' + t('sn.col', { n: 1 }) + ' & ' + t('sn.col', { n: 2 }) + ' & ' + t('sn.col', { n: 3 }) + ' \\\\\n\\midrule\nA & B & C \\\\\n\\bottomrule\n\\end{tabular}\n\\caption{' + t('sn.tblCaption') + '}\n\\label{tab:mytab}\n\\end{table}\n',
  tFlow: '\n\\begin{tikzpicture}[node distance=1.5cm]\n  \\node[rectangle, rounded corners=6pt, fill=blue!15, draw=blue!60!black] (a) {' + t('sn.start') + '};\n  \\node[rectangle, rounded corners=6pt, fill=teal!12, draw=teal!70!black, right of=a, node distance=3cm] (b) {' + t('sn.step') + '};\n  \\node[diamond, fill=yellow!25, draw=orange!80!black, right of=b, node distance=3cm] (c) {' + t('sn.decision') + '};\n  \\node[rectangle, rounded corners=10pt, fill=green!12, draw=green!50!black, below of=b, node distance=2cm] (d) {' + t('sn.end') + '};\n  \\draw[-stealth, thick] (a) -- (b);\n  \\draw[-stealth, thick] (b) -- (c);\n  \\draw[-stealth, thick] (c) -- node[above, font=\\\\small]{' + t('sn.yes') + '} (d);\n\\end{tikzpicture}\n',
  tMermaid: '\n\\begin{mermaid}\nflowchart LR\n  A[' + t('sn.start') + '] --> B{' + t('sn.decision') + '}\n  B -- ' + t('sn.yes') + ' --> C[' + t('sn.process') + ']\n  B -- ' + t('sn.no') + ' --> D[' + t('sn.end') + ']\n\\end{mermaid}\n',
  tBib: '\\cite{key}'
});

function makeTab({ name, path, kind, handle, parentDir, text, modeSpec, saved, imageUrl }) {
  const id = ++tabSeq;
  const t = {
    id, name, path: path || name, kind, handle: handle || null, parentDir: parentDir || null,
    saved: saved !== undefined ? saved : (text || ''),
    imageUrl: imageUrl || null,
    dirty: false, doc: null
  };
  if (text !== undefined && text !== null) t.doc = new CodeMirror.Doc(text, modeSpec);
  return t;
}

export default function App() {
  const [lang, setLang] = useState(detectLang);
  setModuleLang(lang); // 引擎模块（linter/llm）读模块级语言；渲染期同步保证当帧文案正确
  const t = useT();

  // ---- 多标签 ----
  const [tabs, setTabs] = useState(() => {
    let saved = '';
    try { saved = localStorage.getItem(LS_KEY) || ''; } catch (e) { /* ignore */ }
    const text = saved.trim() ? saved : samples.demo;
    return [makeTab({ name: tr(detectLang(), 'app.draftName'), path: tr(detectLang(), 'app.draftPath'), kind: 'draft', text, modeSpec: 'stex', saved: text })];
  });
  const [activeId, setActiveId] = useState(() => 1);
  const [activeValue, setActiveValue] = useState(() => tabsInitValue());

  // ---- 视图 ----
  const [viewMode, setViewMode] = useState(() => { try { return localStorage.getItem(LS_MODE) || 'split'; } catch (e) { return 'split'; } });
  const [splitPct, setSplitPct] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [syncScroll, setSyncScroll] = useState(true);
  const [sideTab, setSideTab] = useState('outline');
  const [panelOpen, setPanelOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInject, setChatInject] = useState(null); // {text, n} 预填对话输入框（诊断点一键修复）
  const [selection, setSelection] = useState({ did: 0, sel: null });
  const [flashMsg, setFlashMsg] = useState('');
  const [cmReady, setCmReady] = useState(0);

  // ---- 文件夹 ----
  const [rootDir, setRootDir] = useState(null);
  const [restorePrompt, setRestorePrompt] = useState(null);
  const [treeKey, setTreeKey] = useState(0);

  // ---- 编译 ----
  const [engines, setEngines] = useState([]);
  const [engine, setEngine] = useState('xelatex');
  const [compiling, setCompiling] = useState(false);
  const [compileResult, setCompileResult] = useState(null);
  const [previewMode, setPreviewMode] = useState('rich');
  const pdfUrlRef = useRef(null);

  // ---- LLM ----
  const [channels, setChannels] = useState(() => llm.loadChannels());
  const [activeChannelId, setActiveChannelId] = useState(() => (llm.loadChannels()[0] || {}).id || '');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(null); // 'keys' | 'about' | null
  const [chatMessages, setChatMessages] = useState([]);
  const [aiBusy, setAiBusy] = useState(false);

  const cmRef = useRef(null);
  const ratioRef = useRef({ edit: 0, preview: 0 });
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const valueRef = useRef(activeValue);
  valueRef.current = activeValue;

  const activeTab = tabs.filter(t => t.id === activeId)[0] || tabs[0];
  const activeKind = activeTab ? activeTab.kind : 'tex';
  const isTexLike = activeKind === 'tex' || activeKind === 'draft';
  const isMd = activeKind === 'md';

  const flash = useCallback((msg) => {
    setFlashMsg(msg);
    setTimeout(() => setFlashMsg(''), 1600);
  }, []);

  useEffect(() => { llm.saveChannels(channels); }, [channels]);
  useEffect(() => {
    if (channels.length && !channels.some(c => c.id === activeChannelId)) setActiveChannelId(channels[0].id);
  }, [channels, activeChannelId]);

  // ---- 语言持久化 + <html lang> + 标题 ----
  useEffect(() => {
    try { localStorage.setItem(LS_LANG, lang); } catch (e) { /* ignore */ }
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.title = t('app.title');
  }, [lang, t]);

  // ---- 恢复文件夹 & 检测 TeX 引擎 ----
  useEffect(() => {
    (async () => {
      const h = await fs.loadRootHandle();
      if (h) {
        const perm = await fs.queryPermission(h, 'readwrite');
        if (perm === 'granted') setRootDir(h);
        else setRestorePrompt(h);
      }
      try {
        const r = await fetch('/api/health');
        if (r.ok) {
          const j = await r.json();
          setEngines(j.engines || []);
          if ((j.engines || []).length) setEngine(['xelatex', 'pdflatex', 'lualatex', 'latex'].find(e => j.engines.includes(e)));
        }
      } catch (e) { /* 静态模式，无编译服务 */ }
    })();
  }, []);

  // ---- 文件夹操作 ----
  const openFolder = async () => {
    try {
      const h = await fs.pickDirectory();
      setRootDir(h); setRestorePrompt(null);
      await fs.saveRootHandle(h);
      setSideTab('files');
      flash(t('app.folderOpened', { name: h.name }));
    } catch (e) { if (e && e.name !== 'AbortError') alert(t('app.openFolderFailed', { msg: e.message || e })); }
  };
  const closeFolder = async () => { setRootDir(null); setRestorePrompt(null); await fs.clearRootHandle(); };
  const restoreFolder = async () => {
    if (!restorePrompt) return;
    const perm = await fs.requestPermission(restorePrompt, 'readwrite');
    if (perm === 'granted') { setRootDir(restorePrompt); setRestorePrompt(null); setSideTab('files'); }
  };

  // ---- 打开文件 ----
  const openFileTab = useCallback(async (fileHandle, path, parentDir) => {
    const name = fileHandle.name || (path ? path.split('/').pop() : tr(getLang(), 'app.untitled'));
    const info = infoFor(name);
    const exist = tabsRef.current.filter(t => t.handle === fileHandle)[0];
    if (exist) { setActiveId(exist.id); return exist; }
    try {
      if (info.kind === 'image') {
        const url = await fs.fileBlobUrl(fileHandle);
        const t = makeTab({ name, path, kind: 'image', handle: fileHandle, imageUrl: url });
        setTabs(ts => ts.concat([t])); setActiveId(t.id); setActiveValue('');
        return t;
      }
      const text = await fs.readFileText(fileHandle);
      const t = makeTab({ name, path, kind: info.kind, handle: fileHandle, parentDir, text, modeSpec: info.mode, saved: text });
      setTabs(ts => ts.concat([t])); setActiveId(t.id); setActiveValue(text);
      return t;
    } catch (e) { alert(tr(getLang(), 'app.cannotOpen', { name, msg: e.message || e })); return null; }
  }, []);

  useEffect(() => {
    window.__plInject = (name, content) => {
      const info = infoFor(name);
      const nt = makeTab({ name, path: t('app.memPath') + ' ' + name, kind: info.kind, text: content, modeSpec: info.mode, saved: content });
      setTabs(ts => ts.concat([nt])); setActiveId(nt.id); setActiveValue(content);
      return nt.id;
    };
    window.__plTabs = () => tabsRef.current.map(t => ({ id: t.id, name: t.name, kind: t.kind, dirty: t.dirty }));
  }, []);

  // ---- 编辑器联动 ----
  const onDocChange = useCallback((doc, value) => {
    setActiveValue(value);
    setTabs(ts => ts.map(t => t.doc === doc ? { ...t, dirty: value !== t.saved } : t));
  }, []);

  useEffect(() => {
    if (activeTab && activeTab.doc) {
      const v = activeTab.doc.getValue();
      setActiveValue(prev => (prev === v ? prev : v));
    } else if (activeTab && activeTab.kind === 'image') setActiveValue('');
    setCompileResult(null); setPreviewMode('rich');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // 草稿自动保存
  useEffect(() => {
    if (!activeTab || activeTab.kind !== 'draft') return;
    const t = setTimeout(() => {
      try { localStorage.setItem(LS_KEY, activeValue); } catch (e) { /* ignore */ }
      setTabs(ts => ts.map(x => x.id === activeTab.id ? { ...x, saved: activeValue } : x));
    }, 800);
    return () => clearTimeout(t);
  }, [activeValue, activeTab]);

  useEffect(() => { try { localStorage.setItem(LS_MODE, viewMode); } catch (e) { /* ignore */ } }, [viewMode]);

  // ---- 新建文件（未保存标签；Ctrl+S 时另存到已开文件夹，或弹出系统另存为）----
  const newFile = () => {
    let n = 1;
    const base = t('app.newFileDefault', { n: '' });
    const existNames = new Set(tabsRef.current.map(t => t.name));
    while (existNames.has(base.replace('.tex', (n > 1 ? n : '') + '.tex'))) n++;
    const input = window.prompt(t('app.newFilePrompt'), base.replace('.tex', (n > 1 ? n : '') + '.tex'));
    if (!input) return;
    const name = input.trim();
    if (!name || /[\\/:*?"<>|]/.test(name)) { alert(t('app.badFileName')); return; }
    const info = infoFor(name);
    const t2 = makeTab({ name, path: t('app.unsavedPath'), kind: info.kind, text: '', modeSpec: info.mode, saved: '' });
    setTabs(ts => ts.concat([t2])); setActiveId(t2.id); setActiveValue('');
    flash(t('app.created', { name }));
  };

  // 另存为：无磁盘句柄的标签保存时走这里。
  // 已开文件夹 → 直接存到根目录（重名确认）；否则系统「另存为」对话框；再否则退化为下载。
  const saveTabAs = async (t) => {
    const value = t.doc ? t.doc.getValue() : '';
    if (rootDir) {
      try {
        await rootDir.getFileHandle(t.name);
        if (!window.confirm(t('app.overwriteConfirm', { name: t.name }))) return false;
      } catch (e) { /* 不存在，直接创建 */ }
      try {
        const h = await fs.createFile(rootDir, t.name);
        await fs.writeFileText(h, value);
        setTabs(ts => ts.map(x => x.id === t.id ? { ...x, handle: h, parentDir: rootDir, path: t.name, saved: value, dirty: false } : x));
        setTreeKey(k => k + 1);
        flash(t('app.savedToFolder', { name: t.name }));
        return true;
      } catch (e) { alert(t('app.saveFailed', { msg: e.message || e })); return false; }
    }
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const h = await window.showSaveFilePicker({ suggestedName: t.name });
        await fs.writeFileText(h, value);
        setTabs(ts => ts.map(x => x.id === t.id ? { ...x, name: h.name, handle: h, path: h.name, saved: value, dirty: false } : x));
        flash(t('app.saved', { name: h.name }));
        return true;
      } catch (e) {
        if (e && e.name !== 'AbortError') alert(t('app.saveFailed', { msg: e.message || e }));
        return false;
      }
    }
    downloadFile(t.name, value, 'text/plain;charset=utf-8');
    flash(t('app.downloadFallback', { name: t.name }));
    return false;
  };

  // ---- 保存 ----
  const saveActive = useCallback(async () => {
    const t = tabsRef.current.filter(x => x.id === activeId)[0];
    if (!t) return;
    if (t.kind === 'draft') {
      try { localStorage.setItem(LS_KEY, t.doc ? t.doc.getValue() : ''); } catch (e) { /* ignore */ }
      setTabs(ts => ts.map(x => x.id === t.id ? { ...x, saved: x.doc.getValue(), dirty: false } : x));
      flash(tr(getLang(), 'app.draftSaved'));
      return;
    }
    if (!t.handle) { await saveTabAs(t); return; }
    try {
      await fs.writeFileText(t.handle, t.doc.getValue());
      setTabs(ts => ts.map(x => x.id === t.id ? { ...x, saved: x.doc.getValue(), dirty: false } : x));
      flash(tr(getLang(), 'app.saved', { name: t.name }));
    } catch (e) { alert(tr(getLang(), 'app.saveFailed', { msg: e.message || e })); }
  }, [activeId, rootDir, flash]);

  // ---- 关闭标签 ----
  const closeTab = useCallback((id) => {
    const t = tabsRef.current.filter(x => x.id === id)[0];
    if (t && t.dirty && !window.confirm(tr(getLang(), 'app.dirtyClose', { name: t.name }))) return;
    if (t && t.imageUrl) URL.revokeObjectURL(t.imageUrl);
    setTabs(ts => {
      const rest = ts.filter(x => x.id !== id);
      if (!rest.length) {
        const text = samples.blank;
        const nt = makeTab({ name: tr(getLang(), 'app.draftName'), path: tr(getLang(), 'app.draftPath'), kind: 'draft', text, modeSpec: 'stex', saved: text });
        setActiveId(nt.id); setActiveValue(text);
        return [nt];
      }
      if (id === activeId) {
        const nt = rest[rest.length - 1];
        setActiveId(nt.id);
        setActiveValue(nt.doc ? nt.doc.getValue() : '');
      }
      return rest;
    });
  }, [activeId]);

  // ---- 编辑器辅助 ----
  const cm = () => cmRef.current;
  const wrap = (pre, post) => {
    const c = cm(); if (!c) return;
    c.replaceSelection(pre + (c.getSelection() || '') + post, 'around');
    const cur = c.getCursor();
    c.setSelection({ line: cur.line, ch: cur.ch - post.length }, cur);
    c.focus();
  };
  const insert = (text) => { const c = cm(); if (!c) return; c.replaceSelection(text, 'around'); c.focus(); };
  const insertLine = (pre, post) => {
    const c = cm(); if (!c) return;
    const cur = c.getCursor();
    const line = c.getLine(cur.line) || '';
    const indent = (line.match(/^\s*/) || [''])[0];
    const sel = c.getSelection() || '';
    if (sel) c.replaceSelection(pre + sel + post);
    else {
      c.replaceRange(indent + pre + post, { line: cur.line, ch: 0 }, { line: cur.line, ch: line.length });
      c.setCursor({ line: cur.line, ch: (indent + pre).length });
    }
    c.focus();
  };

  // ---- 跳转（大纲/诊断）----
  // 程序化跳转后短暂抑制"同步滚动"：编辑器 scrollIntoView 触发的 scroll 事件
  // 会按比例覆盖预览区刚刚设置的标题定位（反之亦然），造成跳转目标互打。
  const syncSuppRef = useRef(0);
  const jumpToLine = useCallback((line) => {
    const c = cm();
    if (!c || line == null) return;
    syncSuppRef.current = Date.now() + 900;
    c.setCursor({ line, ch: 0 });
    c.scrollIntoView({ line, ch: 0 }, 120);
    c.focus();
    try {
      c.addLineClass(line, 'background', 'jump-flash');
      setTimeout(() => c.removeLineClass(line, 'background', 'jump-flash'), 1400);
    } catch (e) { /* ignore */ }
    if (viewMode === 'preview') setViewMode('split');
  }, [viewMode]);

  const jumpToHeading = useCallback((h) => {
    const c = cm();
    let line = h.line;
    if (line == null && h.offset != null && c) {
      try { line = c.posFromIndex(h.offset).line; } catch (e) { line = null; }
    }
    if (line != null) jumpToLine(line);
    const el = document.getElementById(h.id);
    if (el) {
      const sc = document.getElementById('previewScroll');
      if (sc) {
        // Chromium 的 CSS zoom 语义下 scrollTop 即视觉像素坐标，rect 差值 + scrollTop 直接可用，无需除 zoom
        const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 60;
        // 个别内嵌 WebView 会静默忽略 smooth 程序滚动：120ms 后未生效则直接落位
        const before = sc.scrollTop;
        try { sc.scrollTo({ top: Math.max(0, top), behavior: 'smooth' }); } catch (e) { sc.scrollTop = Math.max(0, top); }
        setTimeout(() => { if (sc.scrollTop === before) sc.scrollTop = Math.max(0, top); }, 120);
      }
    }
  }, [jumpToLine]);

  // ---- 文件/模板 ----
  const openSingleFile = async () => {
    if (typeof window.showOpenFilePicker !== 'function') {
      alert(t('app.noFilePicker'));
      return;
    }
    try {
      const [h] = await window.showOpenFilePicker({ multiple: false });
      await openFileTab(h, h.name, null);
    } catch (e) { if (e && e.name !== 'AbortError') alert(t('app.openFailed', { msg: e.message || e })); }
  };

  const loadTemplate = (key) => {
    const t = tabsRef.current.filter(x => x.id === activeId)[0];
    const useDraft = t && (t.kind === 'draft' || t.kind === 'tex');
    if (!window.confirm(useDraft ? tr(getLang(), 'app.tplReplace') : tr(getLang(), 'app.tplNewTab'))) return;
    const text = samples[key] || '';
    if (useDraft && t.doc) {
      t.doc.setValue(text);
      setActiveValue(text);
      setTabs(ts => ts.map(x => x.id === t.id ? { ...x, saved: text, dirty: false } : x));
    } else {
      const nt = makeTab({ name: tr(getLang(), 'app.draftName'), path: tr(getLang(), 'app.draftPath'), kind: 'draft', text, modeSpec: 'stex', saved: text });
      setTabs(ts => ts.concat([nt])); setActiveId(nt.id); setActiveValue(text);
    }
  };

  // ---- 编译 ----
  const doCompile = async () => {
    if (compiling) return;
    if (!isTexLike) { flash(t('app.onlyTexCompile')); return; }
    if (!engines.length) {
      alert(t('app.noEngine'));
      return;
    }
    setCompiling(true);
    try {
      const r = await fetch('/api/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine, source: activeValue })
      });
      const j = await r.json();
      if (pdfUrlRef.current) { URL.revokeObjectURL(pdfUrlRef.current); pdfUrlRef.current = null; }
      if (j.ok) {
        const bin = atob(j.pdf);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        pdfUrlRef.current = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        setCompileResult({ ok: true, pdfUrl: pdfUrlRef.current, log: j.log || '', errors: j.errors || [], engine });
        setPreviewMode('pdf');
        flash(t('app.compileOk', { engine }));
      } else {
        setCompileResult({ ok: false, log: j.log || '', errors: j.errors || [], error: j.error || t('app.compileFailed'), engine });
        setPreviewMode('log');
      }
    } catch (e) {
      alert(t('app.compileReqFailed', { msg: e.message || e }));
    } finally { setCompiling(false); }
  };

  // ---- 预览渲染 ----
  const deferred = useDeferredValue(activeValue);
  const latexResult = useMemo(() => {
    if (!isTexLike) return null;
    const t0 = performance.now();
    let r;
    try { r = renderLatex(deferred, {}); }
    catch (e) { r = { html: '<div class="render-error">' + tr(getLang(), 'app.renderErr') + String(e && e.message || e) + '</div>', meta: {}, warnings: [String(e)], diagrams: [], stats: countOf(deferred), headings: [] }; }
    lastRenderMs = performance.now() - t0;
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferred, isTexLike]);

  const mdResult = useMemo(() => {
    if (!isMd) return null;
    const t0 = performance.now();
    let r;
    try { r = renderMarkdownFull(deferred); }
    catch (e) { r = { html: '<div class="render-error">' + tr(getLang(), 'app.mdRenderErr') + String(e && e.message || e) + '</div>', headings: [] }; }
    lastRenderMs = performance.now() - t0;
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferred, isMd]);

  const diagnostics = useMemo(() => (isTexLike ? lintLaTeX(deferred) : []), [deferred, isTexLike]);

  // 编辑器内联诊断：lint 问题 + TeX 编译错误（渲染警告无行号，不进 gutter）
  const editorIssues = useMemo(() => {
    const cs = compileResult && compileResult.errors
      ? compileResult.errors.map(e => ({ line: e.line, msg: e.msg || tr(getLang(), 'app.compileErr'), severity: 'error', src: 'compile' }))
      : [];
    return diagnostics.concat(cs);
  }, [diagnostics, compileResult]);

  const outlineItems = isTexLike ? (latexResult ? latexResult.headings : [])
    : isMd ? (mdResult ? mdResult.headings : []) : [];
  const outlineKind = isTexLike ? 'tex' : isMd ? 'md' : activeKind;

  const previewResult = isTexLike ? latexResult
    : isMd ? { html: mdResult ? mdResult.html : '', isMd: true, meta: { ctex: true }, warnings: [], diagrams: [], stats: countOf(deferred) }
    : null;

  // ---- 同步滚动 ----
  const handleScrollRatio = useCallback((ratio, from) => {
    ratioRef.current[from] = ratio;
    if (!syncScroll) return;
    if (Date.now() < syncSuppRef.current) return; // 程序化跳转后的抑制窗口
    const other = from === 'edit' ? 'preview' : 'edit';
    if (Math.abs(ratioRef.current[other] - ratio) < 0.015) return;
    if (from === 'edit') {
      const el = document.getElementById('previewScroll');
      if (el) el.scrollTop = ratio * (el.scrollHeight - el.clientHeight);
    } else {
      const c = cmRef.current;
      if (c) { const si = c.getScrollInfo(); c.scrollTo(si.left, ratio * (si.height - si.clientHeight)); }
    }
  }, [syncScroll]);

  // ---- 快捷键 ----
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveActive(); }
      if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); newFile(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'b' && (isTexLike || isMd)) { e.preventDefault(); wrap('\\textbf{', '}'); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'i' && (isTexLike || isMd)) { e.preventDefault(); wrap('\\emph{', '}'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---- 分栏拖拽 ----
  const dragDivider = (e) => {
    e.preventDefault();
    const move = (ev) => {
      const layout = document.getElementById('layout');
      if (!layout) return;
      const rect = layout.getBoundingClientRect();
      setSplitPct(Math.min(80, Math.max(20, (ev.clientX - rect.left - 232) / rect.width * 100)));
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('dragging');
      const c = cmRef.current; if (c) c.refresh();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.body.classList.add('dragging');
  };

  const setZoomClamped = (d) => setZoom(z => Math.min(1.6, Math.max(0.5, +(z + d).toFixed(2))));

  // ---- LLM 上下文构建 ----
  const buildContext = useCallback(async (scope, query, channel) => {
    const c = cm();
    const doc = valueRef.current || '';
    const limit = channel && channel.contextLimit ? channel.contextLimit : 24000;
    const L = getLang();
    const trunc = (t) => t.length > limit ? t.slice(0, Math.floor(limit * 0.7)) + '\n\n' + tr(L, 'app.ctxOmitted') + '\n\n' + t.slice(-Math.floor(limit * 0.3)) : t;
    if (scope === 'selection') {
      const sel = c ? c.getSelection() : '';
      return { text: sel || '', note: sel ? tr(L, 'app.ctxSel') : tr(L, 'app.ctxSelEmpty') };
    }
    if (scope === 'paragraph') {
      if (!c) return { text: '', note: '' };
      const cur = c.getCursor();
      let a = cur.line, b = cur.line;
      const n = c.lineCount();
      while (a > 0 && (c.getLine(a - 1) || '').trim()) a--;
      while (b < n - 1 && (c.getLine(b + 1) || '').trim()) b++;
      const text = rangeText(c, a, b);
      return { text: trunc(text), note: tr(L, 'app.ctxPara', { a: a + 1, b: b + 1 }) };
    }
    if (scope === 'retrieve') {
      if (channel && channel.embedModel) {
        const chunks = await llm.retrieve(channel, query, doc, 6);
        if (chunks && chunks.length) {
          return { text: chunks.join('\n\n——\n\n').slice(0, limit), note: tr(L, 'app.ctxRag', { n: chunks.length }) };
        }
      }
      return { text: trunc(doc), note: tr(L, 'app.ctxFallback') };
    }
    return { text: trunc(doc), note: tr(L, 'app.ctxFull') + (doc.length > limit ? tr(L, 'app.ctxTruncated') : '') };
  }, []);
  buildContext.cm = () => cmRef.current;

  // ---- AI 修复 ----
  const aiFix = async () => {
    const L = getLang();
    const channel = channels.filter(c => c.id === activeChannelId)[0];
    if (!channel) { setSettingsOpen(true); alert(tr(L, 'app.needChannel')); return; }
    if (!isTexLike) { flash(tr(L, 'app.onlyTexAiFix')); return; }
    const issues = [
      ...(compileResult && compileResult.errors ? compileResult.errors.map(e => ({ line: e.line, msg: e.msg })) : []),
      ...diagnostics
    ].slice(0, 20);
    if (!issues.length) { flash(tr(L, 'app.noFixable')); return; }
    setAiBusy(true);
    setChatOpen(true); setPanelOpen(false);
    const prompt = tr(L, 'ai.fixPrompt', {
      issues: issues.map(d => tr(L, 'ai.errLine', { n: d.line != null ? d.line + 1 : '?', msg: d.msg })).join('\n'),
      doc: activeValue.slice(0, channel.contextLimit || 24000)
    });
    setChatMessages(ms => ms.concat([{ role: 'user', content: tr(L, 'app.aiFixReq'), ctxNote: '🛠 ' + tr(L, 'app.nIssues', { n: issues.length }) }, { role: 'assistant', content: '', reasoning: '' }]));
    try {
      const r = await llm.chat(channel, [{ role: 'user', content: prompt }], { temperature: 0.2 });
      setChatMessages(ms => ms.map((m, i) => i === ms.length - 1 ? { ...m, content: r.content, reasoning: r.reasoning || '' } : m));
    } catch (e) {
      setChatMessages(ms => ms.map((m, i) => i === ms.length - 1 && !m.content ? { ...m, content: tr(L, 'app.aiFixFailed', { msg: e.message || e }) } : m));
    } finally { setAiBusy(false); }
  };

  // ---- AI 修复（单问题：编辑器诊断红橙点点击，预填提示词到对话输入框）----
  const aiFixIssue = (issue, list) => {
    const L = getLang();
    const channel = channels.filter(c => c.id === activeChannelId)[0];
    if (!channel) { setSettingsOpen(true); alert(tr(L, 'app.needChannel')); return; }
    if (!isTexLike) { flash(tr(L, 'app.onlyTexAiFix')); return; }
    const all = (list && list.length ? list : [issue]);
    const lines = activeValue.split('\n');
    setChatOpen(true); setPanelOpen(false);
    const detail = all.map(d => {
      const t = d.line != null ? (lines[d.line] || '').slice(0, 300) : '';
      return tr(L, 'ai.errLineSrc', { n: d.line != null ? d.line + 1 : '?', msg: d.msg, src: t.trim() });
    }).join('\n');
    const prompt = tr(L, 'ai.fixIssuePrompt', { detail });
    setChatInject({ text: prompt, n: Date.now() });
  };

  // ---- 导出 ----
  const exportPdfPrint = () => {
    const paper = document.getElementById('paper');
    if (!paper) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = paper.innerHTML;
    tmp.querySelectorAll('.dgrid-tools').forEach(el => el.remove());
    tmp.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
    exportPDF(tmp.innerHTML, (isTexLike && latexResult) ? latexResult.meta : {});
  };

  const SNIP = makeSnippets(t);
  const stats = previewResult && previewResult.stats ? previewResult.stats : countOf(activeValue);
  const wordText = (stats.cjk ? t('st.chars', { n: stats.cjk }) : '') + (stats.cjk && stats.words - stats.cjk > 0 ? ' + ' : '') + (stats.words - stats.cjk > 0 ? t('st.words', { n: stats.words - stats.cjk }) : '');
  const renderWarnCount = previewResult && previewResult.warnings ? previewResult.warnings.length : 0;
  const issueCount = diagnostics.length + renderWarnCount + (compileResult && compileResult.errors ? compileResult.errors.length : 0);
  const hasEditor = activeTab && activeTab.kind !== 'image';
  const channelCount = channels.length;

  return (
    <LangContext.Provider value={lang}>
      <Toolbar
        actions={{
          newFile, loadTemplate, openFile: openSingleFile, openFolder, save: saveActive,
          exportTex: () => {
            if (isTexLike) exportTexFile(activeValue, ((activeTab.name || 'paper').replace(/\.(tex|md)$/i, '')) + '.tex');
            else downloadFile(activeTab.name, activeValue, 'text/plain;charset=utf-8');
          },
          exportPdf: exportPdfPrint,
          editOp: (op) => {
            const c = cm();
            if (!c) return;
            if (op === 'undo') c.undo();
            else if (op === 'redo') c.redo();
            else if (op === 'selectAll') c.execCommand('selectAll');
            c.focus();
          },
          tool: (id) => {
            if (!isTexLike && !isMd) return;
            switch (id) {
              case 'tSec': return insertLine('\\section{', '}');
              case 'tSub': return insertLine('\\subsection{', '}');
              case 'tB': return wrap('\\textbf{', '}');
              case 'tI': return wrap('\\emph{', '}');
              case 'tU': return wrap('\\underline{', '}');
              case 'tTt': return wrap('\\texttt{', '}');
              case 'tMath': return wrap('$', '$');
              case 'tFn': return wrap('\\footnote{', '}');
              case 'tImg': {
                const inp = document.createElement('input');
                inp.type = 'file'; inp.accept = 'image/*';
                inp.onchange = () => {
                  const f = inp.files && inp.files[0];
                  if (!f) return;
                  const r = new FileReader();
                  r.onload = () => insert('\n\\begin{figure}[h]\n\\centering\n\\includegraphics[width=0.7\\textwidth]{' + r.result + '}\n\\caption{' + t('app.imageCaption') + '}\n\\label{fig:img}\n\\end{figure}\n');
                  r.readAsDataURL(f);
                };
                inp.click();
                return;
              }
              default: if (SNIP[id]) insert(SNIP[id]);
            }
          }
        }}
        viewMode={viewMode} setViewMode={setViewMode} latexOk={isTexLike || isMd}
        engines={engines} engine={engine} setEngine={setEngine} compiling={compiling} onCompile={doCompile}
        downloadPdf={compileResult && compileResult.pdfUrl ? () => downloadCompiled(compileResult) : null}
        channelCount={channelCount} onOpenChat={() => { setChatOpen(o => !o); setPanelOpen(false); }} onOpenSettings={() => setSettingsOpen(true)}
        onAiFix={aiFix}
        syncScroll={syncScroll} setSyncScroll={setSyncScroll}
        zoom={zoom} onZoom={setZoomClamped}
        onHelp={setHelpOpen}
        lang={lang} setLang={setLang}
      />

      <main id="layout" data-mode={viewMode} style={{ '--split': splitPct + '%' }}>
        <div id="sidebar">
          <div className="side-tabs">
            <button className={sideTab === 'files' ? 'on' : ''} title={t('side.files')} onClick={() => setSideTab('files')} disabled={!rootDir && !restorePrompt}>{lang === 'zh' ? '文' : '▤'}</button>
            <button className={sideTab === 'outline' ? 'on' : ''} title={t('side.outline')} onClick={() => setSideTab('outline')}>{lang === 'zh' ? '纲' : '≣'}</button>
            <button className={sideTab === 'issues' ? 'on' : ''} title={t('side.issues')} onClick={() => setSideTab('issues')}>{'⚠\uFE0E'}{issueCount ? <em>{issueCount}</em> : null}</button>
          </div>
          <div className="side-body">
            {sideTab === 'files' && (
              restorePrompt && !rootDir ? (
                <div className="side-pad">
                  <button className="btn sm" onClick={restoreFolder}>{t('side.restore', { name: restorePrompt.name })}</button>
                </div>
              ) : rootDir ? <FileTree root={rootDir} onOpenFile={openFileTab} onCloseFolder={closeFolder} refreshKey={treeKey} />
                : <div className="side-pad hint">{t('side.noFolder1')}<br />{t('side.noFolder2')}</div>
            )}
            {sideTab === 'outline' && <OutlinePanel kind={outlineKind} headings={outlineItems} onJump={jumpToHeading} />}
            {sideTab === 'issues' && (
              <DiagnosticsPanel
                diagnostics={diagnostics}
                renderWarnings={previewResult && previewResult.warnings}
                compileErrors={compileResult && compileResult.errors}
                onJump={(d) => jumpToLine(d.line)}
                onAiFix={aiFix} aiBusy={aiBusy}
              />
            )}
          </div>
        </div>

        <section id="editorCol">
          <TabsBar tabs={tabs} activeId={activeId} onActivate={id => setActiveId(id)} onClose={closeTab} />
          {hasEditor ? (
            <EditorPane
              doc={activeTab.doc}
              onChange={onDocChange}
              onInit={(c) => { cmRef.current = c; setCmReady(x => x + 1); }}
              onScrollRatio={handleScrollRatio}
              onSave={saveActive}
              diagnostics={editorIssues}
              onFixIssue={aiFixIssue}
            />
          ) : (
            <div className="binary-note">
              <div>{activeTab.name}</div>
              <div className="hint">{t('prev.imageNote')}</div>
            </div>
          )}
        </section>

        {viewMode === 'split' && <div id="divider" title={lang === 'zh' ? '拖动调整分栏' : 'Drag to resize split'} onMouseDown={dragDivider}></div>}

        {viewMode !== 'edit' && (
          activeTab && activeTab.kind === 'image' ? (
            <section id="previewPane">
              <div id="previewBar"><span className="pb-title">{t('prev.title')}</span></div>
              <div id="previewScroll"><div id="preview"><div id="paper" className="paper image-view" style={{ zoom }}>
                <img src={activeTab.imageUrl} alt={activeTab.name} style={{ maxWidth: '100%' }} />
              </div></div></div>
            </section>
          ) : previewMode === 'pdf' && compileResult && compileResult.ok ? (
            <section id="previewPane">
              <div id="previewBar">
                <span className="pb-title">✓ {compileResult.engine} {t('prev.compileOk')}</span>
                <span className="pb-spacer"></span>
                <button className="btn sm" onClick={() => downloadCompiled(compileResult)}>{t('prev.dlPdf')}</button>
                <button className="btn sm" onClick={() => window.open(compileResult.pdfUrl, '_blank')}>{t('prev.newWindow')}</button>
                <button className="btn sm" onClick={() => setPreviewMode('rich')}>{t('prev.close')}</button>
              </div>
              <div className="pdf-host"><iframe src={compileResult.pdfUrl} title="PDF" /></div>
            </section>
          ) : previewMode === 'log' && compileResult ? (
            <section id="previewPane">
              <div id="previewBar">
                <span className="pb-title bad">✕ {compileResult.engine} {t('prev.compileFail')}</span>
                <span className="pb-spacer"></span>
                <button className="btn sm" onClick={() => setPreviewMode('rich')}>{t('prev.back')}</button>
              </div>
              <div id="previewScroll">
                <div className="compile-log">
                  {(compileResult.errors || []).map((e, i) => (
                    <div key={i} className="diag-item error" onClick={() => e.line != null && jumpToLine(e.line)}>
                      <span className="diag-sev">✖</span>
                      <span className="diag-msg">{e.msg}</span>
                      {e.line != null && <span className="diag-line">{t('diag.line', { n: e.line + 1 })}</span>}
                    </div>
                  ))}
                  <pre>{(compileResult.log || '').split('\n').slice(-120).join('\n')}</pre>
                </div>
              </div>
            </section>
          ) : previewResult ? (
            <PreviewPane
              result={previewResult}
              selection={selection}
              onSelectNode={(did, sidx) => { setSelection({ did, sel: { type: 'node', sidx } }); setPanelOpen(true); setChatOpen(false); }}
              onScrollRatio={handleScrollRatio}
              zoom={zoom} onZoom={setZoomClamped}
              panelOpen={panelOpen} onTogglePanel={() => { setPanelOpen(o => !o); setChatOpen(false); }}
              syncScroll={syncScroll} onSyncToggle={setSyncScroll}
              engines={engines} engine={engine} setEngine={setEngine} compiling={compiling} onCompile={doCompile}
              hasCompile={!!compileResult}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenChat={() => { setChatOpen(o => !o); setPanelOpen(false); }}
            />
          ) : (
            <section id="previewPane">
              <div id="previewBar"><span className="pb-title">{t('prev.title')}</span></div>
              <div id="previewScroll"><div id="preview"><div id="paper" className="paper">
                <div className="code-placeholder">
                  <div className="cp-icon">{infoFor(activeTab ? activeTab.name : '').icon}</div>
                  <div className="cp-name">{activeTab ? activeTab.name : ''}</div>
                  <div className="cp-line">{t('prev.codeNote1')}</div>
                  <div className="cp-line hint">{t('prev.codeLines', { n: activeValue ? activeValue.split('\n').length : 0, size: fmtSize(activeValue) })}</div>
                  <div className="cp-line hint">{t('prev.codeNote2')}</div>
                </div>
              </div></div></div>
            </section>
          )
        )}
      </main>

      <footer id="statusbar">
        <span>{activeTab ? (activeTab.path || activeTab.name) : ''}</span>
        <span className="sep">·</span>
        <span>{wordText}</span>
        <span className="sep">·</span>
        <span>{isTexLike || isMd ? lastRenderMs.toFixed(0) + ' ms' : t('st.textMode')}</span>
        <span className="sep">·</span>
        <span className={'st-warn' + (issueCount ? ' has' : '')} onClick={() => setSideTab('issues')}>
          {issueCount ? t('st.issues', { n: issueCount }) : t('st.noIssues')}
        </span>
        <span className="grow"></span>
        {flashMsg && <span className="st-flash">{flashMsg}</span>}
        <span className="hint">{t('st.hint')}</span>
      </footer>

      {viewMode !== 'edit' && isTexLike && cmReady >= 0 && (
        <StylePanel open={panelOpen && !chatOpen} onClose={() => setPanelOpen(false)} result={latexResult} cm={cmRef.current} selection={selection} setSelection={setSelection} />
      )}

      <ChatPanel
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        inject={chatInject}
        channels={channels}
        activeChannelId={activeChannelId}
        setActiveChannelId={setActiveChannelId}
        onOpenSettings={() => setSettingsOpen(true)}
        buildContext={buildContext}
        messages={chatMessages}
        setMessages={setChatMessages}
      />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        channels={channels}
        setChannels={setChannels}
        activeChannelId={activeChannelId}
        setActiveChannelId={setActiveChannelId}
      />

      {helpOpen === 'keys' && (
        <div className="modal-mask" onClick={e => { if (e.target === e.currentTarget) setHelpOpen(null); }}>
          <div className="modal help-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-h">{t('help.keys')} <button className="btn sm" onClick={() => setHelpOpen(null)}>✕</button></div>
            <div className="modal-body">
              <table className="keys-table">
                <tbody>
                  {[['Ctrl+S', t('help.k1')],
                    ['Ctrl+B / Ctrl+I', t('help.k2')],
                    ['Ctrl+Z / Ctrl+Shift+Z', t('help.k3')],
                    ['Ctrl+A', t('help.k4')],
                    ['Tab / Shift+Tab', t('help.k5')]].map(([k, d]) => (
                    <tr key={k}><td><kbd>{k}</kbd></td><td>{d}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {helpOpen === 'about' && (
        <div className="modal-mask" onClick={e => { if (e.target === e.currentTarget) setHelpOpen(null); }}>
          <div className="modal help-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-h">{t('help.about')} <button className="btn sm" onClick={() => setHelpOpen(null)}>✕</button></div>
            <div className="modal-body about-body">
              <div className="about-logo"><span className="brand-seal">论</span>PaperLite</div>
              <div className="about-slogan">{t('help.slogan')}</div>
              <ul className="about-list">
                <li>{t('help.a1')}</li>
                <li>{t('help.a2')}</li>
                <li>{t('help.a3')}</li>
                <li>{t('help.a4')}</li>
              </ul>
              <div className="about-stack">React 18 · CodeMirror 5 · KaTeX · Mermaid · Vite</div>
            </div>
          </div>
        </div>
      )}
    </LangContext.Provider>
  );
}

function tabsInitValue() {
  try { const s = localStorage.getItem(LS_KEY); if (s && s.trim()) return s; } catch (e) { /* ignore */ }
  return samples.demo;
}
function rangeText(cm, a, b) {
  const lines = [];
  for (let i = a; i <= b; i++) lines.push(cm.getLine(i) || '');
  return lines.join('\n');
}
function countOf(s) {
  const str = String(s || '');
  const cjk = (str.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (str.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9][A-Za-z0-9'’\-]*/g) || []).length;
  return { cjk, words: latin + cjk };
}
function fmtSize(s) {
  const bytes = new Blob([String(s || '')]).size;
  return bytes < 1024 ? bytes + ' B' : (bytes / 1024).toFixed(1) + ' KB';
}
async function downloadCompiled(compileResult) {
  try {
    const r = await fetch(compileResult.pdfUrl);
    const blob = await r.blob();
    downloadFile('paper-' + compileResult.engine + '.pdf', blob, 'application/pdf');
  } catch (e) { /* ignore */ }
}

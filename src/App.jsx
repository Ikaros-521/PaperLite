import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from 'codemirror';
import FileDialog from './components/FileDialog.jsx';
import { validName, wordCount, readHistory, recordVersion, renameVersion, copyHistory, deleteHistory, clearHistory, historyUsage, downloadSourceZip } from './fileActions.js';
import HistoryDialog from './components/HistoryDialog.jsx';
import Toolbar from './components/Toolbar.jsx';
import { quickInsert, replaceTemplate } from './editorTools.js';
import EditorPane from './components/EditorPane.jsx';
import PreviewPane from './components/PreviewPane.jsx';
import StylePanel from './components/StylePanel.jsx';
import FileTree from './components/FileTree.jsx';
import TabsBar from './components/TabsBar.jsx';
import OutlinePanel from './components/OutlinePanel.jsx';
import DiagnosticsPanel from './components/DiagnosticsPanel.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import SettingsDialog from './components/SettingsDialog.jsx';
import TourWelcome from './components/TourWelcome.jsx';
import TourGuide from './components/TourGuide.jsx';
import { TOUR_STEPS, shouldWelcome, dismissWelcome, markTourDone } from './tour.js';
import { renderLatex } from './engines/latex.js';
import { renderMarkdownFull } from './engines/markdown.js';
import { lintLaTeX } from './engines/linter.js';
import { collectIssues, currentCompileErrors } from './diagnostics.js';
import { warmEngine, compileXeLaTeX, onEngineStatus } from './engines/xelatex.js';
import { samples } from './engines/samples.js';
import { downloadFile, exportTex as exportTexFile, exportPDF } from './exporter.js';
import { infoFor } from './fileTypes.js';
import * as fs from './fs.js';
import * as llm from './llm.js';
import * as ctxBudget from './context.js';
import { LS_LANG, detectLang, getLang, setLang as setModuleLang, tr } from './i18n.js';
import { detectTheme, applyTheme } from './theme.js';
import { LangContext } from './useI18n.js';

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

function makeTab({ name, path, kind, handle, parentDir, text, modeSpec, saved, imageUrl, historyScope = '' }) {
  const id = ++tabSeq;
  const t = {
    id, name, path: path || name, kind, handle: handle || null, parentDir: parentDir || null,
    historyKey: JSON.stringify([kind === 'draft' ? '' : historyScope, kind === 'draft' ? 'draft' : path || name]),
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
  // App 自身在 Provider 之上，useContext 读不到自己下发的值——直接由 lang 状态构建 t
  const t = useMemo(() => (key, params) => tr(lang, key, params), [lang]);

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
  const [theme, setTheme] = useState(detectTheme);
  const [splitPct, setSplitPct] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [editorSettings, setEditorSettings] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem('paperlite.editor-settings') || '{}'); return { fontSize: [12,14,16,18,20].includes(s.fontSize) ? s.fontSize : 14, lineWrapping: s.lineWrapping !== false, syncScroll: s.syncScroll !== false }; }
    catch { return { fontSize: 14, lineWrapping: true, syncScroll: true }; }
  });
  const [syncScroll, setSyncScroll] = useState(editorSettings.syncScroll);
  const [fileDialog, setFileDialog] = useState(null);
  const [, setHistoryTick] = useState(0);
  const [historyError, setHistoryError] = useState('');
  const historyClearedRef = useRef(new WeakMap());
  const [packaging, setPackaging] = useState(false);
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
  const [engine, setEngine] = useState('builtin');
  const [builtinStatus, setBuiltinStatus] = useState('idle');
  const [compiling, setCompiling] = useState(false);
  const [compileResult, setCompileResult] = useState(null);
  const [dismissedIssues, setDismissedIssues] = useState(null);
  const compileContextRef = useRef(null);
  const [previewMode, setPreviewMode] = useState('rich');
  const pdfUrlRef = useRef(null);

  // ---- LLM ----
  const [channels, setChannels] = useState(() => llm.loadChannels());
  const [activeChannelId, setActiveChannelId] = useState(() => (llm.loadChannels()[0] || {}).id || '');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(null); // 'keys' | 'about' | null
  const [tourStage, setTourStage] = useState(null); // 'welcome' | 'tour' | null
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
  // Invalidate pending compilation when switching documents, including switching back.
  if (compileContextRef.current?.doc !== activeTab?.doc) {
    compileContextRef.current = { doc: activeTab?.doc };
  }

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

  // ---- 皮肤：切换即涂 <html data-theme> 并落盘 ----
  useEffect(() => { applyTheme(theme); }, [theme]);

  // ---- 首次访问弹欢迎页（勾过「不再自动弹出」或走过教程就不再打扰）----
  useEffect(() => { if (shouldWelcome()) setTourStage('welcome'); }, []);

  const openHelp = useCallback((key) => {
    if (key === 'tour') { setHelpOpen(null); setTourStage('tour'); return; }
    setHelpOpen(key);
  }, []);

  // ---- 恢复文件夹 & 检测 TeX 引擎 ----
  useEffect(() => {
    (async () => {
      const h = await fs.loadRootHandle();
      if (h) {
        const perm = await fs.queryPermission(h, 'readwrite');
        if (perm === 'granted') setRootDir(h);
        else setRestorePrompt(h);
      }
      let local = [];
      try {
        const r = await fetch('/api/health');
        if (r.ok) {
          const j = await r.json();
          local = j.engines || [];
        }
      } catch (e) { /* 静态托管（GitHub Pages），仅有内置引擎 */ }
      // 内置 wasm 引擎始终可用；本机引擎排在前面供有 MiKTeX/TeX Live 的用户选择
      setEngines(local.length ? [...local, 'builtin'] : ['builtin']);
      if (!local.includes('xelatex')) setEngine('builtin');
    })();
  }, []);

  // ---- 内置 XeLaTeX 引擎：状态订阅 + 文档/导言区变化时后台预热 ----
  useEffect(() => onEngineStatus(setBuiltinStatus), []);
  const warmPreamble = activeValue.split(/\\begin\s*\{document\}/)[0];
  useEffect(() => {
    if (!isTexLike) return;
    const kick = () => { warmEngine(compileContextRef.current?.doc?.getValue() || '').catch(() => { /* 状态已置 error，由 UI 提示 */ }); };
    let ic = null, tid = null;
    if ('requestIdleCallback' in window) { ic = requestIdleCallback(kick, { timeout: 1000 }); }
    else tid = setTimeout(kick, 1000);
    return () => { if (ic !== null && 'cancelIdleCallback' in window) cancelIdleCallback(ic); if (tid !== null) clearTimeout(tid); };
  }, [activeTab?.doc, warmPreamble, isTexLike]);

  const historyKey = activeTab?.historyKey || JSON.stringify([rootDir?.name || '', activeTab?.kind === 'draft' ? 'draft' : activeTab?.path]);
  const snapshot = (label = '', reason = 'manual', force = true) => {
    if (!activeTab?.doc) return false;
    const result = recordVersion(historyKey, activeTab.doc.getValue(), { label, reason, force });
    setHistoryError(result.ok ? '' : t('hist.storageError'));
    setHistoryTick(n => n + 1);
    return result.ok;
  };
  useEffect(() => {
    const doc = activeTab?.doc;
    if (!doc) return;
    let timer;
    const capture = () => {
      if (historyClearedRef.current.get(doc) === doc.getValue()) return;
      const result = recordVersion(historyKey, doc.getValue());
      setHistoryError(result.ok ? '' : tr(getLang(), 'hist.storageError'));
      setHistoryTick(n => n + 1);
    };
    capture();
    const changed = () => {
      if (historyClearedRef.current.get(doc) !== doc.getValue()) historyClearedRef.current.delete(doc);
      clearTimeout(timer); timer = setTimeout(capture, 3000);
    };
    doc.on('change', changed);
    // Flush the actual document on tab changes; never record stale activeValue.
    const flush = () => { if (historyClearedRef.current.get(doc) !== doc.getValue()) recordVersion(historyKey, doc.getValue()); };
    window.addEventListener('pagehide', flush);
    return () => { clearTimeout(timer); doc.off('change', changed); window.removeEventListener('pagehide', flush); flush(); };
  }, [activeTab?.doc, historyKey]);
  useEffect(() => {
    const settings = { ...editorSettings, syncScroll };
    try { localStorage.setItem('paperlite.editor-settings', JSON.stringify(settings)); } catch { /* ignore */ }
    const c = cmRef.current;
    if (c) { c.setOption('lineWrapping', settings.lineWrapping); c.getWrapperElement().style.fontSize = settings.fontSize + 'px'; c.refresh(); }
  }, [editorSettings, syncScroll, cmReady]);

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
      const t = makeTab({ name, path, kind: info.kind, handle: fileHandle, parentDir, text, modeSpec: info.mode, saved: text, historyScope: parentDir ? rootDir?.name || '' : '' });
      setTabs(ts => ts.concat([t])); setActiveId(t.id); setActiveValue(text);
      return t;
    } catch (e) { alert(tr(getLang(), 'app.cannotOpen', { name, msg: e.message || e })); return null; }
  }, [rootDir?.name]);

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
    compileContextRef.current = { doc };
    setDismissedIssues(null);
    // Compile diagnostics describe the old source. Keep PDF/log artifacts, but retire markers.
    setCompileResult(r => r ? { ...r, errors: [] } : r);
    setPreviewMode(mode => mode === 'log' ? 'rich' : mode);
    setActiveValue(value);
    setTabs(ts => ts.map(t => t.doc === doc ? { ...t, dirty: value !== t.saved } : t));
  }, []);

  useEffect(() => {
    if (activeTab && activeTab.doc) {
      const v = activeTab.doc.getValue();
      setActiveValue(prev => (prev === v ? prev : v));
    } else setActiveValue('');
    setCompileResult(null); setDismissedIssues(null); setPreviewMode('rich');
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
    const t2 = makeTab({ name, path: t('app.unsavedPath') + '/' + name, kind: info.kind, text: '', modeSpec: info.mode, saved: '' });
    setTabs(ts => ts.concat([t2])); setActiveId(t2.id); setActiveValue('');
    flash(t('app.created', { name }));
  };

  const newFolder = async () => {
    try {
      const dir = rootDir || await fs.pickDirectory();
      if (!rootDir) { setRootDir(dir); setRestorePrompt(null); await fs.saveRootHandle(dir); }
      setSideTab('files');
      const name = window.prompt(t('ft.newDirPrompt'))?.trim();
      if (!name) return;
      if (!validName(name)) { alert(t('app.badFileName')); return; }
      for await (const [existing] of dir.entries()) if (existing === name) { alert(t('file.exists', { name })); return; }
      await fs.createDirectory(dir, name);
      setTreeKey(n => n + 1);
      flash(t('app.created', { name }));
    } catch (e) { if (e.name !== 'AbortError') alert(t('ft.createFailed', { msg: e.message })); }
  };

  const uploadFiles = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = true;
    input.onchange = async () => {
      for (const file of Array.from(input.files || [])) {
        try {
          if (!validName(file.name)) throw new Error(t('app.badFileName'));
          if (rootDir) {
            let exists = false;
            try { await rootDir.getFileHandle(file.name); exists = true; } catch (e) { if (e.name !== 'NotFoundError') throw e; }
            const opened = tabsRef.current.find(tab => tab.handle && tab.path === file.name);
            if ((exists || opened) && !window.confirm(t('app.overwriteConfirm', { name: file.name }))) continue;
            const handle = await fs.createFile(rootDir, file.name);
            const writable = await handle.createWritable();
            await writable.write(file); await writable.close();
            if (opened) {
              if (opened.doc) { const value = await file.text(); opened.doc.setValue(value); setTabs(ts => ts.map(x => x.id === opened.id ? { ...x, saved: value, dirty: false } : x)); }
              else { const url = await fs.fileBlobUrl(handle); URL.revokeObjectURL(opened.imageUrl); setTabs(ts => ts.map(x => x.id === opened.id ? { ...x, imageUrl: url } : x)); }
              setActiveId(opened.id);
            } else await openFileTab(handle, file.name, rootDir);
          } else {
            // Open uploaded files in memory when no local folder is connected.
            const info = infoFor(file.name);
            let uploaded;
            if (info.kind === 'image') uploaded = makeTab({ name: file.name, kind: 'image', imageUrl: URL.createObjectURL(file) });
            else {
              const text = file.size <= 2 * 1024 * 1024 ? await file.text() : null;
              uploaded = text !== null && !text.includes('\u0000')
                ? makeTab({ name: file.name, kind: info.kind, text, modeSpec: info.mode })
                : makeTab({ name: file.name, kind: 'asset' });
            }
            uploaded.uploadedFile = file;
            setTabs(ts => ts.concat(uploaded)); setActiveId(uploaded.id); setActiveValue(uploaded.doc?.getValue() || '');
          }
        } catch (e) { alert(t('file.uploadFailed', { name: file.name, msg: e.message })); }
      }
      setTreeKey(n => n + 1); if (rootDir) setSideTab('files');
    };
    input.click();
  };

  const makeCopy = () => {
    if (!activeTab?.doc) return;
    const original = activeTab.name;
    const dot = original.lastIndexOf('.');
    const base = dot > 0 ? original.slice(0, dot) : original;
    const ext = dot > 0 ? original.slice(dot) : '';
    let name = base + '-copy' + ext, n = 2;
    while (tabsRef.current.some(tab => tab.name === name)) name = base + '-copy-' + n++ + ext;
    const value = activeTab.doc.getValue(), info = infoFor(name);
    const copy = makeTab({ name, path: t('app.unsavedPath') + '/' + name, kind: info.kind, text: value, modeSpec: info.mode, saved: '' });
    copy.dirty = !!value;
    setTabs(ts => ts.concat(copy)); setActiveId(copy.id); setActiveValue(value);
    flash(t('app.created', { name }));
  };

  const exportProject = async () => {
    if (packaging) return;
    setPackaging(true);
    try {
      const entries = new Map();
      const visit = async (dir, prefix = '') => {
        for (const entry of await fs.listDir(dir)) {
          const path = prefix + entry.name;
          if (entry.kind === 'directory') await visit(entry.handle, path + '/');
          else { const file = await entry.handle.getFile(); entries.set(path, await file.arrayBuffer()); }
        }
      };
      if (rootDir) await visit(rootDir);
      for (const tab of tabsRef.current) {
        let path = tab.name;
        if (rootDir && tab.handle) { const resolved = await rootDir.resolve(tab.handle); path = resolved ? resolved.join('/') : 'external/' + tab.id + '/' + tab.name; }
        else if (rootDir || entries.has(path)) path = 'unsaved/' + tab.id + '/' + tab.name;
        if (tab.doc) entries.set(path, tab.doc.getValue());
        else if (tab.uploadedFile) entries.set(path, await tab.uploadedFile.arrayBuffer());
        else if (tab.handle) entries.set(path, await (await tab.handle.getFile()).arrayBuffer());
      }
      downloadSourceZip(rootDir?.name || 'paperlite-source', [...entries].map(([name, bytes]) => ({ name, bytes })));
    } catch (e) { alert(t('file.downloadFailed', { msg: e.message })); }
    finally { setPackaging(false); }
  };

  // 另存为：无磁盘句柄的标签保存时走这里。
  // 已开文件夹 → 直接存到根目录（重名确认）；否则系统「另存为」对话框；再否则退化为下载。
  const saveTabAs = async (tab) => {
    const value = tab.doc ? tab.doc.getValue() : '';
    if (rootDir) {
      try {
        await rootDir.getFileHandle(tab.name);
        if (!window.confirm(t('app.overwriteConfirm', { name: tab.name }))) return false;
      } catch (e) { /* 不存在，直接创建 */ }
      try {
        const h = await fs.createFile(rootDir, tab.name);
        await fs.writeFileText(h, value);
        const nextKey = JSON.stringify([rootDir.name, tab.name]);
        const copied = copyHistory(tab.historyKey, nextKey);
        if (!copied) setHistoryError(tr(getLang(), 'hist.storageError'));
        setTabs(ts => ts.map(x => x.id === tab.id ? { ...x, historyKey: copied ? nextKey : x.historyKey, handle: h, parentDir: rootDir, path: tab.name, saved: value, dirty: false } : x));
        setTreeKey(k => k + 1);
        flash(t('app.savedToFolder', { name: tab.name }));
        return true;
      } catch (e) { alert(t('app.saveFailed', { msg: e.message || e })); return false; }
    }
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const h = await window.showSaveFilePicker({ suggestedName: tab.name });
        await fs.writeFileText(h, value);
        const nextKey = JSON.stringify(['', h.name]);
        const copied = copyHistory(tab.historyKey, nextKey);
        if (!copied) setHistoryError(tr(getLang(), 'hist.storageError'));
        setTabs(ts => ts.map(x => x.id === tab.id ? { ...x, historyKey: copied ? nextKey : x.historyKey, name: h.name, handle: h, path: h.name, saved: value, dirty: false } : x));
        flash(t('app.saved', { name: h.name }));
        return true;
      } catch (e) {
        if (e && e.name !== 'AbortError') alert(t('app.saveFailed', { msg: e.message || e }));
        return false;
      }
    }
    downloadFile(tab.name, value, 'text/plain;charset=utf-8');
    flash(t('app.downloadFallback', { name: tab.name }));
    return false;
  };

  // ---- 保存 ----
  const saveActive = useCallback(async () => {
    const t = tabsRef.current.filter(x => x.id === activeId)[0];
    if (!t?.doc) return;
    const recorded = recordVersion(t.historyKey, t.doc.getValue(), { reason: 'save' });
    setHistoryError(recorded.ok ? '' : tr(getLang(), 'hist.storageError'));
    setHistoryTick(n => n + 1);
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
    replaceTemplate(c, pre, c.getSelection() || '', post);
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
    if (engine !== 'builtin' && !engines.includes(engine)) {
      alert(t('app.noEngine'));
      return;
    }
    setCompiling(true);
    const context = compileContextRef.current;
    const source = activeTab.doc.getValue();
    const tabId = activeTab.id;
    setDismissedIssues(null);
    setCompileResult(r => r ? { ...r, errors: [] } : r);
    try {
      let ok, pdfBytes, log, errors, errText;
      if (engine === 'builtin') {
        const r = await compileXeLaTeX(source);
        ok = r.ok; pdfBytes = r.pdfBytes; log = r.log || ''; errors = r.errors || [];
        if (!ok) errText = (errors[0] && errors[0].msg) || t('app.compileFailed');
      } else {
        const r = await fetch('/api/compile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ engine, source })
        });
        const j = await r.json();
        ok = j.ok; log = j.log || ''; errors = j.errors || [];
        if (ok) {
          const bin = atob(j.pdf);
          pdfBytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) pdfBytes[i] = bin.charCodeAt(i);
        } else errText = j.error || t('app.compileFailed');
      }
      // A late response must never restore errors for edited or inactive documents.
      if (compileContextRef.current !== context) return;
      if (ok) {
        if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
        pdfUrlRef.current = URL.createObjectURL(new Blob([pdfBytes], { type: 'application/pdf' }));
        setCompileResult({ ok: true, pdfUrl: pdfUrlRef.current, log, errors, engine, tabId, source });
        setPreviewMode('pdf');
        flash(t('app.compileOk', { engine: engine === 'builtin' ? t('app.builtinEngine') : engine }));
      } else {
        setCompileResult({ ok: false, log, errors, error: errText, engine, tabId, source });
        setPreviewMode('log');
      }
    } catch (e) {
      if (compileContextRef.current !== context) return;
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

  const diagnostics = useMemo(() => (isTexLike ? lintLaTeX(activeValue) : []), [activeValue, isTexLike, lang]);
  const allIssues = collectIssues(
    diagnostics,
    deferred === activeValue ? (latexResult?.warnings || []) : [],
    currentCompileErrors(compileResult, activeTab?.id, activeValue)
  );
  const dismissed = dismissedIssues?.tabId === activeTab?.id
    && dismissedIssues.source === activeValue && dismissedIssues.result === compileResult
    ? dismissedIssues.ids : [];
  const visibleIssues = allIssues.filter(d => !dismissed.includes(d.id));
  const editorIssues = visibleIssues.filter(d => d.src !== 'render');
  const dismissIssues = ids => setDismissedIssues({
    tabId: activeTab?.id, source: activeValue, result: compileResult,
    ids: [...dismissed, ...ids]
  });

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
      const editorFocused = e.target.closest?.('.CodeMirror');
      if (editorFocused && (e.ctrlKey || e.metaKey) && e.key === 'b' && (isTexLike || isMd)) { e.preventDefault(); quickInsert(cm(), 'tB', null, { markdown: isMd }); }
      if (editorFocused && (e.ctrlKey || e.metaKey) && e.key === 'i' && (isTexLike || isMd)) { e.preventDefault(); quickInsert(cm(), 'tI', null, { markdown: isMd }); }
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

  // ---- LLM 上下文构建（按 token 预算截断，见 context.js） ----
  const buildContext = useCallback(async (scope, query, channel) => {
    const c = cm();
    const doc = valueRef.current || '';
    const L = getLang();
    const budget = ctxBudget.docBudget(channel, scope);
    const omitted = '\n\n' + tr(L, 'app.ctxOmitted') + '\n\n';
    // 截断后确实验证超了预算才提示「已截断」，避免估算与展示不一致
    const fit = (t) => {
      const out = ctxBudget.truncateToTokens(t, budget, omitted);
      return { text: out, cut: out !== t };
    };
    const note = (base, cut) => base + (cut ? tr(L, 'app.ctxTruncated') : '');
    if (scope === 'selection') {
      const sel = c ? c.getSelection() : '';
      if (!sel) return { text: '', note: tr(L, 'app.ctxSelEmpty'), tokens: 0, budget };
      const full = ctxBudget.inputBudget(channel);
      const out = ctxBudget.truncateToTokens(sel, full, omitted);
      return { text: out, note: note(tr(L, 'app.ctxSel'), out !== sel), tokens: ctxBudget.estimateTokens(out), budget: full };
    }
    if (scope === 'paragraph') {
      if (!c) return { text: '', note: '', tokens: 0, budget };
      const cur = c.getCursor();
      let a = cur.line, b = cur.line;
      const n = c.lineCount();
      while (a > 0 && (c.getLine(a - 1) || '').trim()) a--;
      while (b < n - 1 && (c.getLine(b + 1) || '').trim()) b++;
      const f = fit(rangeText(c, a, b));
      return { text: f.text, note: note(tr(L, 'app.ctxPara', { a: a + 1, b: b + 1 }), f.cut), tokens: ctxBudget.estimateTokens(f.text), budget };
    }
    if (scope === 'retrieve') {
      if (channel && channel.embedModel) {
        const chunks = await llm.retrieve(channel, query, doc, 6);
        if (chunks && chunks.length) {
          const f = fit(chunks.join('\n\n——\n\n'));
          return { text: f.text, note: note(tr(L, 'app.ctxRag', { n: chunks.length }), f.cut), tokens: ctxBudget.estimateTokens(f.text), budget };
        }
      }
      const f = fit(doc);
      return { text: f.text, note: note(tr(L, 'app.ctxFallback'), f.cut), tokens: ctxBudget.estimateTokens(f.text), budget };
    }
    const f = fit(doc);
    return { text: f.text, note: note(tr(L, 'app.ctxFull'), f.cut), tokens: ctxBudget.estimateTokens(f.text), budget };
  }, []);
  buildContext.cm = () => cmRef.current;

  // ---- AI 修复 ----
  const aiFix = async () => {
    const L = getLang();
    const channel = channels.filter(c => c.id === activeChannelId)[0];
    if (!channel) { setSettingsOpen(true); alert(tr(L, 'app.needChannel')); return; }
    if (!isTexLike) { flash(tr(L, 'app.onlyTexAiFix')); return; }
    const issues = editorIssues.slice(0, 20);
    if (!issues.length) { flash(tr(L, 'app.noFixable')); return; }
    setAiBusy(true);
    setChatOpen(true); setPanelOpen(false);
    const prompt = tr(L, 'ai.fixPrompt', {
      issues: issues.map(d => tr(L, 'ai.errLine', { n: d.line != null ? d.line + 1 : '?', msg: d.msg })).join('\n'),
      doc: ctxBudget.truncateToTokens(activeValue, ctxBudget.docBudget(channel, 'full'), '\n\n' + tr(L, 'app.ctxOmitted') + '\n\n')
    });
    setChatMessages(ms => ms.concat([{ role: 'user', content: tr(L, 'app.aiFixReq'), ctxNote: '🛠 ' + tr(L, 'app.nIssues', { n: issues.length }) }, { role: 'assistant', content: '', reasoning: '' }]));
    try {
      const r = await llm.chat(channel, [{ role: 'user', content: prompt }], { temperature: 0.2 });
      setChatMessages(ms => ms.map((m, i) => i === ms.length - 1 ? { ...m, content: r.content, reasoning: r.reasoning || '', usage: r.usage || null } : m));
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
    const tmp = document.createElement('div');
    tmp.innerHTML = paper?.innerHTML || previewResult?.html || '';
    if (!tmp.innerHTML) return;
    tmp.querySelectorAll('.dgrid-tools').forEach(el => el.remove());
    tmp.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
    exportPDF(tmp.innerHTML, (isTexLike && latexResult) ? latexResult.meta : {});
  };

  const SNIP = makeSnippets(t);
  const stats = previewResult && previewResult.stats ? previewResult.stats : countOf(activeValue);
  const wordText = (stats.cjk ? t('st.chars', { n: stats.cjk }) : '') + (stats.cjk && stats.words - stats.cjk > 0 ? ' + ' : '') + (stats.words - stats.cjk > 0 ? t('st.words', { n: stats.words - stats.cjk }) : '');
  const issueCount = visibleIssues.length;
  const hasEditor = !!activeTab?.doc;
  const channelCount = channels.length;

  return (
    <LangContext.Provider value={lang}>
      <Toolbar
        actions={{
          newFolder, upload: uploadFiles, copy: makeCopy, canCopy: !!activeTab?.doc,
          history: () => setFileDialog('history'), wordCount: () => setFileDialog('wordCount'),
          submit: () => setFileDialog('submit'), settings: () => setFileDialog('settings'),
          sourceZip: exportProject, packaging, pdfAvailable: isTexLike || isMd,
          exportSource: () => downloadFile(activeTab.name, activeTab.doc.getValue(), 'text/plain;charset=utf-8'),
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
          tool: (id, value) => {
            if (!isTexLike && !isMd) return;
            if (quickInsert(cm(), id, value, { markdown: isMd, text: t('q.placeholder') })) return;
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
        markdown={isMd} documentKey={activeId}
        labels={[...new Set([...activeValue.replace(/(?<!\\)%[^\n]*/g, '').matchAll(/\\label\{([^}]+)\}/g)].map(match => match[1]))]}
        engines={engines} engine={engine} setEngine={setEngine} compiling={compiling} onCompile={doCompile} builtinStatus={builtinStatus}
        downloadPdf={compileResult && compileResult.pdfUrl ? () => downloadCompiled(compileResult) : null}
        channelCount={channelCount} onOpenChat={() => { setChatOpen(o => !o); setPanelOpen(false); }} onOpenSettings={() => setSettingsOpen(true)}
        onAiFix={aiFix}
        syncScroll={syncScroll} setSyncScroll={setSyncScroll}
        zoom={zoom} onZoom={setZoomClamped}
        onHelp={openHelp}
        lang={lang} setLang={setLang}
        theme={theme} setTheme={setTheme}
      />

      <main id="layout" data-mode={viewMode} style={{ '--split': splitPct + '%' }}>
        <div id="sidebar">
          <div className="side-tabs">
            <button className={sideTab === 'files' ? 'on' : ''} title={t('side.files')} onClick={() => setSideTab('files')} disabled={!rootDir && !restorePrompt}>{lang === 'zh' ? '文' : '▤'}</button>
            <button className={sideTab === 'outline' ? 'on' : ''} title={t('side.outline')} onClick={() => setSideTab('outline')}>{lang === 'zh' ? '纲' : '≣'}</button>
            <button className={sideTab === 'issues' ? 'on' : ''} title={t('side.issues')} onClick={() => setSideTab('issues')}>{'⚠\uFE0E'}{issueCount ? <em>{issueCount}</em> : null}</button>
            <button title={t('m.history')} aria-label={t('m.history')} disabled={!activeTab?.doc} onClick={() => setFileDialog('history')}>↶</button>
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
                issues={visibleIssues}
                dismissedCount={allIssues.length - visibleIssues.length}
                onRestore={() => setDismissedIssues(null)}
                onDismiss={d => dismissIssues([d.id])}
                onClear={() => dismissIssues(visibleIssues.map(d => d.id))}
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
              <div className="hint">{t(activeTab.kind === 'image' ? 'prev.imageNote' : 'file.assetNote')}</div>
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
                  {visibleIssues.filter(d => d.src === 'compile').map((e, i) => (
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
              onSelMermaid={(block, id, cur) => { setSelection({ did: 0, sel: { type: 'mermaid', block, id, cur } }); setPanelOpen(true); setChatOpen(false); }}
              onScrollRatio={handleScrollRatio}
              zoom={zoom} onZoom={setZoomClamped}
              panelOpen={panelOpen} onTogglePanel={() => { setPanelOpen(o => !o); setChatOpen(false); }}
              syncScroll={syncScroll} onSyncToggle={setSyncScroll}
              engines={engines} engine={engine} setEngine={setEngine} compiling={compiling} onCompile={doCompile} builtinStatus={builtinStatus}
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
        <span>{activeTab ? (activeTab.kind === 'draft' ? t('app.draftPath') : (activeTab.path || activeTab.name)) : ''}</span>
        <span className="sep">·</span>
        <span>{wordText}</span>
        <span className="sep">·</span>
        <span>{isTexLike || isMd ? lastRenderMs.toFixed(0) + ' ms' : t('st.textMode')}</span>
        <span className="sep">·</span>
        <span className={'st-warn' + (issueCount ? ' has' : '')} onClick={() => setSideTab('issues')}>
          {issueCount ? t('st.issues', { n: issueCount }) : dismissed.length ? t('diag.hidden', { n: allIssues.length }) : t('st.noIssues')}
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

      {fileDialog === 'history' && activeTab.doc && <HistoryDialog key={activeId} name={activeTab.name} current={activeTab.doc.getValue()} versions={readHistory(historyKey)}
        usage={historyUsage(historyKey)}
        onDelete={id => {
          const version = readHistory(historyKey).find(v => v.id === id);
          const ok = deleteHistory(historyKey, id);
          if (ok && version?.text === activeTab.doc.getValue()) historyClearedRef.current.set(activeTab.doc, activeTab.doc.getValue());
          setHistoryError(ok ? '' : t('hist.storageError')); setHistoryTick(n => n + 1); return ok;
        }}
        onClear={all => {
          const ok = clearHistory(all ? undefined : historyKey);
          if (ok) for (const tab of tabsRef.current) if (tab.doc && (all || tab.historyKey === historyKey)) historyClearedRef.current.set(tab.doc, tab.doc.getValue());
          setHistoryError(ok ? '' : t('hist.storageError')); setHistoryTick(n => n + 1); return ok;
        }}
        error={historyError} onClose={() => setFileDialog(null)} onSnapshot={snapshot}
        onRename={(id, label) => { const ok = renameVersion(historyKey, id, label); setHistoryError(ok ? '' : t('hist.storageError')); setHistoryTick(n => n + 1); return ok; }}
        onRestore={version => {
          if (!snapshot('', 'beforeRestore')) return false;
          const backupId = readHistory(historyKey)[0]?.id;
          activeTab.doc.replaceRange(version.text, { line: 0, ch: 0 }, activeTab.doc.posFromIndex(activeTab.doc.getValue().length), 'historyRestore');
          const result = recordVersion(historyKey, version.text, { reason: 'restore', label: version.label, force: true, protectIds: [backupId] });
          setHistoryError(result.ok ? '' : t('hist.storageError'));
          setHistoryTick(n => n + 1); setCompileResult(null); setPreviewMode('rich'); flash(t('file.restored'));
          return true;
        }}
      />}
      {fileDialog && fileDialog !== 'history' && <FileDialog key={fileDialog + activeId} mode={fileDialog} onClose={() => setFileDialog(null)}
        name={activeTab.name} counts={wordCount(previewText(previewResult?.html, activeTab.doc?.getValue() || ''))}
        selectionCounts={cmRef.current?.getSelection() ? wordCount(cmRef.current.getSelection()) : null}
        settings={{ ...editorSettings, syncScroll }} onSettings={settings => { setEditorSettings(settings); setSyncScroll(settings.syncScroll); }}
        theme={theme} setTheme={setTheme}
        engines={engines} engine={engine} setEngine={setEngine}
        onSource={exportProject} busy={packaging} pdfAvailable={isTexLike || isMd}
        onPdf={compileResult?.ok ? () => downloadCompiled(compileResult) : exportPdfPrint}
      />}

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
              <div className="about-repo">
                <a href="https://github.com/Ikaros-521/PaperLite" target="_blank" rel="noopener noreferrer">{t('help.repo')}</a>
              </div>
              <div className="about-stack">React 18 · CodeMirror 5 · KaTeX · Mermaid · Vite</div>
            </div>
          </div>
        </div>
      )}

      {tourStage === 'welcome' && (
        <TourWelcome
          stepCount={TOUR_STEPS.length}
          onStart={() => setTourStage('tour')}
          onClose={noAuto => { dismissWelcome(noAuto); setTourStage(null); }}
        />
      )}

      {tourStage === 'tour' && (
        <TourGuide steps={TOUR_STEPS} onClose={() => { markTourDone(); setTourStage(null); }} />
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

function previewText(html, fallback) {
  if (!html) return fallback;
  const node = document.createElement('div');
  node.innerHTML = html;
  node.querySelectorAll('.katex, .mermaid-block, .dgrid, svg, style, script, .eq-no').forEach(el => el.remove());
  node.querySelectorAll('p, div, h1, h2, h3, li, td, br').forEach(el => el.append(' '));
  return node.textContent || '';
}

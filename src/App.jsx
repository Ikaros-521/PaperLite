import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from 'codemirror';
import FileDialog from './components/FileDialog.jsx';
import DialogHost from './components/MessageDialog.jsx';
import { showAlert as alert, showConfirm, showPrompt } from './dialogs.js';
import { validName, wordCount, readHistory, recordVersion, renameVersion, copyHistory, deleteHistory, clearHistory, historyUsage, downloadSourceZip } from './fileActions.js';
import HistoryDialog from './components/HistoryDialog.jsx';
import Toolbar from './components/Toolbar.jsx';
import { quickInsert, replaceTemplate } from './editorTools.js';
import EditorPane from './components/EditorPane.jsx';
import PreviewPane from './components/PreviewPane.jsx';
import PdfViewer from './components/PdfViewer.jsx';
import StylePanel from './components/StylePanel.jsx';
import TablePanel from './components/TablePanel.jsx';
import FileTree from './components/FileTree.jsx';
import TabsBar from './components/TabsBar.jsx';
import OutlinePanel from './components/OutlinePanel.jsx';
import DiagnosticsPanel from './components/DiagnosticsPanel.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import SettingsDialog from './components/SettingsDialog.jsx';
import TourWelcome from './components/TourWelcome.jsx';
import TourGuide from './components/TourGuide.jsx';
import { tourStepsFor, shouldWelcome, dismissWelcome, markTourDone } from './tour.js';
import { renderLatex } from './engines/latex.js';
import { renderMarkdownFull } from './engines/markdown.js';
import { lintLaTeX } from './engines/linter.js';
import { collectIssues, currentCompileErrors, issueFingerprint } from './diagnostics.js';
import { collectLabels, collectBibKeys } from './projectIndex.js';
import { resolveMainDoc, hasDocumentclass, loadMainDocSetting, saveMainDocSetting } from './mainDoc.js';
import { collectUserCommands } from './completion.js';
import { locateLineInSource, paragraphHeadAtLine, stripTexCommands } from './pdfSync.js';
import { insertImageFile } from './imageInsert.js';
import { PROVIDERS, makeBibKey, entryToBibTeX, referencedBibFiles } from './citation.js';
import CiteDialog from './components/CiteDialog.jsx';
import GlobalSearchPanel from './components/GlobalSearchPanel.jsx';
import { collectSearchFiles, searchInFiles } from './searchIndex.js';
import { loadSnippets, saveSnippets } from './snippets.js';

import { samples } from './engines/samples.js';
import { downloadFile, exportTex as exportTexFile, exportPDF } from './exporter.js';
import { extOf, infoFor } from './fileTypes.js';
import * as fs from './fs.js';
import * as llm from './llm.js';
import { LS_LANG, detectLang, getLang, setLang as setModuleLang, tr } from './i18n.js';
import { detectTheme, applyTheme } from './theme.js';
import { saveState } from './saveState.js';
import { makeTab } from './workspace/tabModel.js';
import { useWorkspace } from './workspace/useWorkspace.js';
import { useCompile } from './workspace/useCompile.js';
import { buildLLMContext, aiFixIssuePrompt } from './workspace/chatContext.js';
import { runFixQueue } from './workspace/aiFixQueue.js';
import { LangContext } from './useI18n.js';

const LS_MODE = 'paperlite.viewmode.v2';
const LS_LAYOUT = 'paperlite.layout.v1';
// 把手宽度与 app.css 的 .divider 保持一致，拖拽换算按它补偿半格偏移
const DIVIDER_W = 5;
const SIDEBAR_MIN = 150, SIDEBAR_MAX = 520, SIDEBAR_DEFAULT = 232;
const SPLIT_MIN = 15, SPLIT_MAX = 85, SPLIT_DEFAULT = 52;
// 侧栏拖到最宽时，仍要给编辑区 + 预览区留出的最小空间
const PANES_KEEP = 350;
const clampNum = (v, lo, hi, dflt) => (Number.isFinite(v) && v > 0 ? Math.min(hi, Math.max(lo, v)) : dflt);
let lastRenderMs = 0;

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

export default function App() {
  const [lang, setLang] = useState(detectLang);
  setModuleLang(lang); // 引擎模块（linter/llm）读模块级语言；渲染期同步保证当帧文案正确
  // App 自身在 Provider 之上，useContext 读不到自己下发的值——直接由 lang 状态构建 t
  const t = useMemo(() => (key, params) => tr(lang, key, params), [lang]);

  // 工作区 hook 需要这几个 UI 回调，先于它声明
  const [flashMsg, setFlashMsg] = useState('');
  const flash = useCallback((msg) => {
    setFlashMsg(msg);
    setTimeout(() => setFlashMsg(''), 1600);
  }, []);
  const [treeKey, setTreeKey] = useState(0);
  const [sideTab, setSideTab] = useState('outline');

  // ---- 工作区：标签 / 草稿 / 文件夹 / 保存 / 版本历史（与移动端 #/m 共用同一份编排）----
  const {
    tabs, setTabs, tabsRef, activeId, setActiveId, activeValue, setActiveValue,
    rootDir, setRootDir, restorePrompt, setRestorePrompt,
    historyKey, setHistoryTick, historyError, setHistoryError, historyClearedRef,
    noteHistory, snapshot,
    openFolder, closeFolder, restoreFolder, openFileTab,
    newFile, makeCopy, uploadFiles, saveTabAs, saveActive, closeTab,
    onDocChange: applyDocChange,
  } = useWorkspace({
    t, flash, alertBox: alert, confirm: showConfirm, prompt: showPrompt,
    onTreeChanged: () => setTreeKey(n => n + 1), onSideTab: setSideTab,
  });

  // ---- 视图 ----
  const [preferredViewMode, setViewMode] = useState(() => { try { return localStorage.getItem(LS_MODE) || 'split'; } catch (e) { return 'split'; } });
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 900px)').matches);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const viewMode = compact && preferredViewMode === 'split' ? 'edit' : preferredViewMode;
  useEffect(() => { setSidebarOpen(false); }, [activeId]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const change = () => { setCompact(media.matches); setSidebarOpen(false); };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (!sidebarOpen) return;
    const close = e => { if (e.key === 'Escape') { setSidebarOpen(false); document.getElementById('sidebarToggle')?.focus(); } };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [sidebarOpen]);
  const [theme, setTheme] = useState(detectTheme);
  // 三栏宽度：侧栏按 px，编辑/预览按比例（随窗口缩放）
  const [layoutSize, setLayoutSize] = useState(() => {
    try {
      const s = JSON.parse(localStorage.getItem(LS_LAYOUT) || '{}');
      return { sidebar: clampNum(+s.sidebar, SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_DEFAULT), split: clampNum(+s.split, SPLIT_MIN, SPLIT_MAX, SPLIT_DEFAULT) };
    } catch (e) { return { sidebar: SIDEBAR_DEFAULT, split: SPLIT_DEFAULT }; }
  });
  const [zoom, setZoom] = useState(1);
  const [editorSettings, setEditorSettings] = useState(() => {
    try {
      const s = JSON.parse(localStorage.getItem('paperlite.editor-settings') || '{}');
      return {
        fontSize: [12,14,16,18,20].includes(s.fontSize) ? s.fontSize : 14,
        lineWrapping: s.lineWrapping !== false,
        syncScroll: s.syncScroll !== false,
        spellcheck: s.spellcheck !== false,
        autoCompile: ['off', 'save', 'idle'].includes(s.autoCompile) ? s.autoCompile : 'off',
        vimMode: s.vimMode === true,
        grammarCheck: s.grammarCheck === true,
        typewriter: s.typewriter === true,
      };
    }
    catch { return { fontSize: 14, lineWrapping: true, syncScroll: true, spellcheck: true, autoCompile: 'off', vimMode: false, grammarCheck: false, typewriter: false }; }
  });
  const [syncScroll, setSyncScroll] = useState(editorSettings.syncScroll);
  const [fileDialog, setFileDialog] = useState(null);
  const [citeOpen, setCiteOpen] = useState(false);
  // 沉浸模式：隐藏全部外壳只留编辑/预览；Esc 退出。自定义片段存 localStorage
  const [zen, setZen] = useState(false);
  const [snippets, setSnippets] = useState(() => loadSnippets());
  const [packaging, setPackaging] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInject, setChatInject] = useState(null); // {text, n} 预填对话输入框（诊断点一键修复）
  const [selection, setSelection] = useState({ did: 0, sel: null });
  const [cmReady, setCmReady] = useState(0);

  // ---- 编译结果的界面形态（引擎与编译本身在 useCompile 里，与移动端共用）----
  const [dismissedIssues, setDismissedIssues] = useState(null);
  const [previewMode, setPreviewMode] = useState('rich');
  const [logFull, setLogFull] = useState(false);

  // ---- LLM ----
  const [channels, setChannels] = useState(() => llm.loadChannels());
  const [activeChannelId, setActiveChannelId] = useState(() => (llm.loadChannels()[0] || {}).id || '');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(null); // 'keys' | 'feedback' | 'about' | null
  const [tourStage, setTourStage] = useState(null); // 'welcome' | 'tour' | null
  const [chatMessages, setChatMessages] = useState([]);
  // AI 修复串行队列状态：{ active, total, done, per: { [issueId]: { status, attempt, error } } }
  const [fixRun, setFixRun] = useState(null);
  const [selIds, setSelIds] = useState(() => new Set()); // 勾选待修复的 issue id
  const fixCtrlRef = useRef(null);

  const cmRef = useRef(null);
  const ratioRef = useRef({ edit: 0, preview: 0 });
  const valueRef = useRef(activeValue);
  valueRef.current = activeValue;

  // 唤起编辑器内查找/替换面板：seq 递增让同一个模式也能重新聚焦并全选输入框
  const [findReq, setFindReq] = useState(null);
  const reqFind = useCallback((mode) => setFindReq(r => ({ seq: (r ? r.seq : 0) + 1, mode })), []);

  const activeTab = tabs.filter(t => t.id === activeId)[0] || tabs[0];
  const activeKind = activeTab ? activeTab.kind : 'tex';
  const isTexLike = activeKind === 'tex' || activeKind === 'draft';
  const isMd = activeKind === 'md';
  const isSvg = extOf(activeTab?.name) === 'svg';
  const svgPreviewUrl = useMemo(() => isSvg && activeTab?.doc
    ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(activeValue) : null,
  [isSvg, activeTab?.doc, activeValue]);

  // 编译链与移动端共用同一份；换文档时 hook 内部重绑上下文，迟到响应不会贴回旧错误
  // getEntry：主文档入口（多文件项目从带 \documentclass 的主文件编译，而不是当前子文件）。
  // 真正的实现在下面（依赖 mainDoc 等状态），这里用稳定的中转函数交给 hook，避免重编 compile
  const getEntryRef = useRef(null);
  const getEntryTrampoline = useCallback((...args) => (getEntryRef.current ? getEntryRef.current(...args) : null), []);
  const rootDirRef = useRef(rootDir); rootDirRef.current = rootDir;
  const tabPath = useCallback((tb) => (rootDirRef.current && tb.kind !== 'draft' && tb.handle ? (tb.path || tb.name) : tb.name), []);
  const tabPathRef = useRef(tabPath); tabPathRef.current = tabPath;
  const {
    engines, engine, setEngine, builtinStatus, compiling, compileResult, setCompileResult, pdfIsStale,
    compile: runCompile, cancelCompile: doCancelCompile, retireErrors,
  } = useCompile({ t, flash, alertBox: alert }, { tabsRef, activeTab, isTexLike, getEntry: getEntryTrampoline });

  // ---- 跨文件 \ref / \cite 索引 + 项目文件清单（主文档解析、文件名补全、项目搜索都吃它）----
  // 磁盘扫描（文件夹变化/保存时）+ 打开中的标签（随输入即时）
  const [folderIndex, setFolderIndex] = useState({ labels: [], bibKeys: [], texFiles: [], imageFiles: [], bibFiles: [], textFiles: [] });
  useEffect(() => {
    let cancelled = false;
    if (!rootDir) { setFolderIndex({ labels: [], bibKeys: [], texFiles: [], imageFiles: [], bibFiles: [], textFiles: [] }); return undefined; }
    (async () => {
      const labels = [], bibKeys = [], texFiles = [], imageFiles = [], bibFiles = [], textFiles = [];
      let scanned = 0;
      const IMAGE = /\.(png|jpe?g|gif|svg|eps|webp|bmp)$/i;
      const TEXT_EXTRA = /\.(md|markdown|txt)$/i;
      const walk = async (dir, depth, prefix = '') => {
        if (cancelled || depth > 2 || scanned >= 30) return;
        let entries;
        try { entries = await fs.listDir(dir); } catch (e) { return; }
        for (const ent of entries) {
          if (cancelled || scanned >= 30) return;
          const path = prefix + ent.name;
          if (ent.kind === 'directory') { await walk(ent.handle, depth + 1, path + '/'); continue; }
          if (IMAGE.test(ent.name)) { imageFiles.push(path); continue; }
          const nm = ent.name.toLowerCase();
          const isTex = nm.endsWith('.tex'), isBib = nm.endsWith('.bib'), isText = TEXT_EXTRA.test(ent.name);
          if (!isTex && !isBib && !isText) continue;
          let text;
          try { text = await fs.readFileText(ent.handle, 200 * 1024); } catch (e) { continue; } // 超大/二进制跳过
          scanned++;
          if (isBib) {
            // source/handle 留给项目搜索：磁盘 .bib 未打开也能搜到、搜到能打开
            bibFiles.push({ path, source: text, handle: ent.handle });
            for (const k of collectBibKeys(text)) bibKeys.push({ key: k.key, src: ent.name });
          } else if (isTex) {
            // source 留给主文档解析：磁盘上的主文档没打开时编译也要拿得到内容
            texFiles.push({ path, name: ent.name, source: text, isMain: hasDocumentclass(text), handle: ent.handle });
            for (const l of collectLabels(text)) labels.push({ key: l.key, src: ent.name });
          } else {
            textFiles.push({ path, source: text, handle: ent.handle });
          }
        }
      };
      await walk(rootDir, 0);
      if (!cancelled) setFolderIndex({ labels, bibKeys, texFiles, imageFiles, bibFiles, textFiles });
    })();
    return () => { cancelled = true; };
  }, [rootDir, treeKey]);

  // 合并优先级：当前标签 → 其他打开的标签 → 磁盘扫描结果；键去重，先到先得
  const refCompletion = useMemo(() => {
    const labels = [], bibKeys = [];
    const seenL = new Set(), seenB = new Set();
    for (const tb of tabs) {
      if (!tb.doc) continue;
      const text = tb.id === activeId ? activeValue : tb.doc.getValue();
      const src = tb.id === activeId ? '' : tb.name;
      for (const l of collectLabels(text)) if (!seenL.has(l.key)) { seenL.add(l.key); labels.push({ key: l.key, src }); }
      for (const k of collectBibKeys(text)) if (!seenB.has(k.key)) { seenB.add(k.key); bibKeys.push({ key: k.key, src }); }
    }
    for (const l of folderIndex.labels) if (!seenL.has(l.key)) { seenL.add(l.key); labels.push(l); }
    for (const k of folderIndex.bibKeys) if (!seenB.has(k.key)) { seenB.add(k.key); bibKeys.push(k); }
    return { labels, bibKeys };
  }, [tabs, activeId, activeValue, folderIndex]);

  // ---- 主文档（编译入口）：固定设置按文件夹名隔离；候选 = 打开的 tex 标签（实时内容）→ 磁盘扫描 ----
  const [mainDocSetting, setMainDocSetting] = useState(() => loadMainDocSetting());
  const folderKeyRef = useRef(rootDir?.name || '_tabs');
  folderKeyRef.current = rootDir?.name || '_tabs';
  const setPinnedMainDoc = useCallback((path) => {
    saveMainDocSetting(folderKeyRef.current, path);
    setMainDocSetting(loadMainDocSetting());
  }, []);
  const pinnedMainDoc = mainDocSetting[folderKeyRef.current] || '';

  const mainDocCandidates = useMemo(() => {
    const list = [], seen = new Set();
    const active = tabs.filter(x => x.id === activeId)[0] || tabs[0];
    // 活动标签排最前：同为 open 候选时优先被探测
    for (const tb of [active, ...tabs]) {
      if (!tb || (tb.kind !== 'tex' && tb.kind !== 'draft') || !tb.doc) continue;
      const path = tabPath(tb);
      if (seen.has(path)) continue;
      seen.add(path);
      list.push({ path, name: tb.name, source: tb.id === activeId ? activeValue : tb.doc.getValue(), open: true });
    }
    for (const f of folderIndex.texFiles) {
      if (seen.has(f.path)) continue; // 已打开的标签用编辑中的内容，磁盘版本不参与
      seen.add(f.path);
      list.push({ path: f.path, name: f.name, source: f.source, open: false, isMain: f.isMain });
    }
    return list;
  }, [tabs, activeId, activeValue, folderIndex, tabPath]);

  const mainDoc = useMemo(() => resolveMainDoc({
    pinned: pinnedMainDoc || null,
    activePath: activeTab ? tabPath(activeTab) : null,
    candidates: mainDocCandidates,
  }), [pinnedMainDoc, mainDocCandidates, activeTab, tabPath]);
  const mainDocRef = useRef(mainDoc); mainDocRef.current = mainDoc;

  // 编译入口装配：打开的主文档标签用实时内容；磁盘主文档按相对路径逐段取句柄
  const getEntry = useCallback(async () => {
    const md = mainDocRef.current;
    if (!md) return null;
    if (md.open) {
      const tb = tabsRef.current.filter(x => tabPathRef.current(x) === md.path)[0];
      if (tb?.doc) return { source: tb.doc.getValue(), name: tb.name, parentDir: tb.parentDir || rootDirRef.current, entryTabId: tb.id };
      return null; // 标签刚被关闭：退回当前标签，下一轮扫描会纠正
    }
    const root = rootDirRef.current;
    if (!root) return null;
    const parts = String(md.path).split('/');
    const name = parts.pop();
    let dir = root;
    for (const seg of parts) {
      try { dir = await dir.getDirectoryHandle(seg); } catch (e) { return null; }
    }
    try {
      const fh = await dir.getFileHandle(name);
      return { source: await fs.readFileText(fh, 2 * 1024 * 1024), name, parentDir: dir, entryTabId: null };
    } catch (e) { return null; }
  }, [tabsRef]);
  getEntryRef.current = getEntry;

  // 设置里的主文档下拉选项（按 path 去重；label 直接用相对路径）
  const mainDocOptions = useMemo(() => {
    const seen = new Set();
    return mainDocCandidates.filter(c => { if (seen.has(c.path)) return false; seen.add(c.path); return true; })
      .map(c => ({ path: c.path, label: c.path }));
  }, [mainDocCandidates]);

  // 补全池：\input / \includegraphics / \bibliography 的文件名候选（打开的标签 ∪ 磁盘扫描）
  const completionPool = useMemo(() => {
    const tex = [...folderIndex.texFiles.map(f => f.path)];
    const image = [...folderIndex.imageFiles];
    const bib = [...folderIndex.bibFiles.map(f => f.path)];
    for (const tb of tabs) {
      const nm = tb.name || '';
      const path = tabPath(tb);
      if ((tb.kind === 'tex' || tb.kind === 'draft') && !tex.includes(path)) tex.push(path);
      if (tb.kind === 'image' && !image.includes(nm)) image.push(nm);
      if (/\.bib$/i.test(nm) && !bib.includes(path)) bib.push(path);
    }
    return { tex, image, bib };
  }, [folderIndex, tabs, tabPath]);
  // 文档内 \newcommand 定义的命令并入命令补全候选
  const userCommands = useMemo(() => collectUserCommands(
    tabs.filter(x => x.doc).map(x => (x.id === activeId ? activeValue : x.doc.getValue()))
  ), [tabs, activeId, activeValue]);

  // ---- 文献检索插入：选中条目 → 生成 BibTeX 追加到 .bib 标签 + 光标处插 \cite ----
  // 目标 .bib 优先级：文档 \bibliography/\addbibresource 引用的 → 已打开的 .bib → refs.bib（新建）
  const insertCitation = useCallback(async (entry) => {
    const cur = tabsRef.current.filter(x => x.id === activeId)[0];
    if (!cur?.doc || !isTexLike) { flash(t('cite.onlyTex')); return; }
    const taken = new Set(refCompletion.bibKeys.map(k => k.key));
    const key = makeBibKey(entry, taken);
    const bibtex = entryToBibTeX(entry, key);

    const wanted = referencedBibFiles(cur.doc.getValue());
    let target = null;
    for (const w of wanted) {
      target = tabsRef.current.find(x => x.doc && /\.bib$/i.test(x.name) && (x.name === w || x.name.endsWith('/' + w)));
      if (target) break;
    }
    if (!target) target = tabsRef.current.find(x => x.doc && /\.bib$/i.test(x.name)) || null;

    const backId = cur.id;
    let prefilled = false;
    if (!target) {
      const name = wanted[0] || 'refs.bib';
      if (rootDir) {
        try {
          const fh = await rootDir.getFileHandle(name);
          target = await openFileTab(fh, name, rootDir);   // 磁盘已有：打开为标签（会切过去，稍后切回）
        } catch (e) {
          try {
            const fh = await fs.createFile(rootDir, name);
            await fs.writeFileText(fh, bibtex + '\n');      // 新建文件直接带上首条
            setTreeKey(n => n + 1);
            const info = infoFor(name);
            target = makeTab({ name, kind: info.kind, handle: fh, parentDir: rootDir, text: bibtex + '\n', modeSpec: info.mode, saved: bibtex + '\n', historyScope: rootDir.name || '' });
            setTabs(ts => ts.concat(target));
            prefilled = true;
          } catch (err) { /* 写不了盘就退回内存标签 */ }
        }
      }
      if (!target && !prefilled) {
        const info = infoFor(name);
        target = makeTab({ name, kind: info.kind, text: '', modeSpec: info.mode, saved: '' });
        setTabs(ts => ts.concat(target));
      }
    }
    if (!target?.doc) { flash(t('cite.noBibTarget')); return; }
    if (!prefilled) {
      const base = target.doc.getValue();
      const sep = base ? (base.endsWith('\n\n') ? '' : base.endsWith('\n') ? '\n' : '\n\n') : '';
      target.doc.replaceRange(sep + bibtex + '\n', target.doc.posFromIndex(base.length), undefined, '+input');
      // 追加发生在未挂载的 Doc 上，不经过编辑器的 change 事件——手动补脏标记，
      // 否则关闭标签时会跳过「未保存确认」把刚追加的条目一起丢掉
      setTabs(ts => ts.map(x => x.doc === target.doc ? { ...x, dirty: x.doc.getValue() !== x.saved } : x));
    }
    // 回到原文档光标处插 \cite：直接写 Doc，不依赖当前编辑器挂载的是哪个文档
    const pos = cur.doc.getCursor();
    cur.doc.replaceRange('\\cite{' + key + '}', pos, pos, '+input');
    setActiveId(backId);
    flash(t('cite.inserted', { cmd: '\\cite{' + key + '}', file: target.name }));
  }, [activeId, isTexLike, refCompletion, rootDir, openFileTab, flash, t]);

  // 桌面在这里决定"编译完看哪里"：切 PDF / 切日志，窄屏顺带切到预览
  const doCompile = async () => {
    const status = await runCompile();
    if (status === 'ok') {
      setPreviewMode('pdf');
      if (compact) setViewMode('preview');
    } else if (status === 'fail') {
      setLogFull(false);
      setPreviewMode('log');
      if (compact) setViewMode('preview');
    }
  };

  // ---- PDF ⇄ 源码 近似跳转（synctex-lite）：引擎 wasm 不产 synctex，
  // 用编译产物文本（pdf.js 抽取）与源码段落做归一化匹配，见 src/pdfSync.js ----
  const pdfViewerRef = useRef(null);
  const compiledSource = () => (compileResult && compileResult.source != null ? compileResult.source : activeValue);
  const forwardSyncToPdf = useCallback(line => {
    if (previewMode !== 'pdf' || !compileResult?.ok) { flash(t('sync.needPdf')); return; }
    const head = paragraphHeadAtLine(compiledSource(), line);
    const ok = pdfViewerRef.current?.jumpToText?.(stripTexCommands(head.text));
    if (!ok) flash(t('sync.noHit'));
    if (compact) setViewMode('preview');
  }, [compileResult, activeValue, previewMode, flash, t, compact]);
  const backSyncToSource = useCallback(str => {
    const src = compiledSource();
    let line = locateLineInSource(src, str);
    if (line == null && src !== activeValue) line = locateLineInSource(activeValue, str);
    if (line == null) { flash(t('sync.noHit')); return; }
    if (src !== activeValue) {
      // 编译入口是别的标签（主文档）：切到那个标签再跳行
      const tab = tabsRef.current.find(x => x.doc && x.doc.getValue() === src);
      if (tab && tab.id !== activeId) { setActiveId(tab.id); requestAnimationFrame(() => jumpToLine(line)); return; }
    }
    jumpToLine(line);
  }, [compileResult, activeValue, activeId, flash, t]);

  // ---- 自动编译：保存时 / 输入停顿后。quiet 模式不动视图、成功不 flash，问题栏照常反映 ----
  const settingsRef = useRef(editorSettings); settingsRef.current = editorSettings;
  const autoCompileNow = useCallback(() => { runCompile({ quiet: true }); }, [runCompile]);
  const saveActiveAuto = useCallback(async () => {
    const wasTex = isTexLike;
    await saveActive();
    if (settingsRef.current.autoCompile === 'save' && wasTex) autoCompileNow();
  }, [saveActive, isTexLike, autoCompileNow]);
  useEffect(() => {
    if (editorSettings.autoCompile !== 'idle' || !isTexLike) return undefined;
    const tid = setTimeout(() => {
      if (compiling) return;
      // 引擎还在装载/出错时不偷偷触发；首次编译必须由用户发起（内置引擎首编译要拉约 98MB 资源）
      if (engine === 'builtin' && (builtinStatus === 'loading' || builtinStatus === 'error' || builtinStatus === 'idle')) return;
      if (!compileResult) return; // 只「跟随」已编译过的会话
      const md = mainDocRef.current;
      const live = md ? md.source : activeValue;
      if (live === compileResult.source) return; // 内容没变不重复编译
      autoCompileNow();
    }, 6000);
    return () => clearTimeout(tid);
    // activeValue 每次击键都变，effect 重跑即重置 6 秒窗口
  }, [activeValue, editorSettings.autoCompile, isTexLike, compiling, engine, builtinStatus, compileResult, autoCompileNow]);

  useEffect(() => { llm.saveChannels(channels); }, [channels]);
  // 沉浸模式：涂在 <body> 上让 CSS 隐藏全部外壳；片段变更即落盘（失败静默，编辑仍在内存）
  useEffect(() => { document.body.classList.toggle('pl-zen', zen); }, [zen]);
  useEffect(() => { saveSnippets(snippets); }, [snippets]);
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
    if (key === 'welcome') { setHelpOpen(null); setTourStage('welcome'); return; }
    if (key === 'tour') { setHelpOpen(null); setTourStage('tour'); return; }
    setHelpOpen(key);
  }, []);

  // ---- 恢复上次授权的文件夹（引擎探测与预热已移入 useCompile）----
  useEffect(() => {
    (async () => {
      const h = await fs.loadRootHandle();
      if (!h) return;
      const perm = await fs.queryPermission(h, 'readwrite');
      if (perm === 'granted') setRootDir(h);
      else setRestorePrompt(h);
    })();
  }, []);

  useEffect(() => {
    const settings = { ...editorSettings, syncScroll };
    try { localStorage.setItem('paperlite.editor-settings', JSON.stringify(settings)); } catch { /* ignore */ }
    const c = cmRef.current;
    if (c) {
      c.setOption('lineWrapping', settings.lineWrapping);
      c.getWrapperElement().style.fontSize = settings.fontSize + 'px';
      // Vim 键位按需动态加载 addon（cm5-vim，别名接回 codemirror 包），不进主包；
      // 关闭时立即回到默认键位
      if (settings.vimMode) Promise.all([import('cm5-vim'), import('codemirror/addon/dialog/dialog.css')])
        .then(() => { try { c.setOption('keyMap', 'vim'); } catch (e) { /* ignore */ } })
        .catch(() => { /* 加载失败维持默认键位 */ });
      else c.setOption('keyMap', 'default');
      c.refresh();
    }
  }, [editorSettings, syncScroll, cmReady]);


  useEffect(() => {
    window.__plInject = (name, content) => {
      const info = infoFor(name);
      const nt = makeTab({ name, path: t('app.memPath') + ' ' + name, kind: info.kind, text: content, modeSpec: info.mode, saved: content });
      setTabs(ts => ts.concat([nt])); setActiveId(nt.id); setActiveValue(content);
      return nt.id;
    };
    window.__plTabs = () => tabsRef.current.map(t => ({ id: t.id, name: t.name, kind: t.kind, dirty: t.dirty }));
  }, []);

  // ---- 编辑器联动：脏标记与 activeValue 归工作区 hook，这里只负责让旧诊断失效 ----
  const onDocChange = useCallback((doc, value) => {
    retireErrors();
    // Compile diagnostics describe the old source. Keep PDF/log artifacts, but retire markers.
    setCompileResult(r => r ? { ...r, errors: [] } : r);
    setPreviewMode(mode => mode === 'log' ? 'rich' : mode);
    applyDocChange(doc, value);
  }, [applyDocChange]);

  useEffect(() => {
    if (activeTab && activeTab.doc) {
      const v = activeTab.doc.getValue();
      setActiveValue(prev => (prev === v ? prev : v));
    } else setActiveValue('');
    setCompileResult(null); setDismissedIssues(null); setPreviewMode('rich');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  useEffect(() => { try { localStorage.setItem(LS_MODE, preferredViewMode); } catch (e) { /* ignore */ } }, [preferredViewMode]);

  // 分栏宽度防抖落盘：拖动过程中不写 localStorage
  useEffect(() => {
    const t = setTimeout(() => { try { localStorage.setItem(LS_LAYOUT, JSON.stringify(layoutSize)); } catch (e) { /* ignore */ } }, 300);
    return () => clearTimeout(t);
  }, [layoutSize]);

  // 窗口收窄时收回侧栏宽度，并让 CodeMirror 按新列宽重排
  useEffect(() => {
    const onResize = () => {
      const layout = document.getElementById('layout');
      if (!layout) return;
      const max = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, layout.clientWidth - PANES_KEEP));
      setLayoutSize(p => (p.sidebar <= max ? p : { ...p, sidebar: max }));
      const c = cmRef.current; if (c) c.refresh();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const newFolder = async () => {
    try {
      const dir = rootDir || await fs.pickDirectory();
      if (!rootDir) { setRootDir(dir); setRestorePrompt(null); await fs.saveRootHandle(dir); }
      setSideTab('files');
      const name = (await showPrompt(t('ft.newDirPrompt')))?.trim();
      if (!name) return;
      if (!validName(name)) { alert(t('app.badFileName')); return; }
      for await (const [existing] of dir.entries()) if (existing === name) { alert(t('file.exists', { name })); return; }
      await fs.createDirectory(dir, name);
      setTreeKey(n => n + 1);
      flash(t('app.created', { name }));
    } catch (e) { if (e.name !== 'AbortError') alert(t('ft.createFailed', { msg: e.message })); }
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
    if (line == null) return;
    setSidebarOpen(false);
    if (viewMode === 'preview') setViewMode('split');
    syncSuppRef.current = Date.now() + 1000;

    const doScroll = () => {
      const c = cm();
      if (!c) return;
      c.refresh();
      const maxLine = Math.max(0, c.lineCount() - 1);
      const targetLine = Math.min(Math.max(0, line), maxLine);
      c.setCursor({ line: targetLine, ch: 0 });
      c.scrollIntoView({ line: targetLine, ch: 0 }, 120);
      c.focus();
      try {
        c.addLineClass(targetLine, 'background', 'jump-flash');
        setTimeout(() => c.removeLineClass(targetLine, 'background', 'jump-flash'), 1600);
      } catch (e) { /* ignore */ }
    };

    doScroll();
    requestAnimationFrame(doScroll);
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

  // ---- 预览点击回跳：data-off 是源码绝对偏移（等长抹除后仍与文档一一对应）----
  const handleJumpOff = useCallback((off) => {
    const c = cm();
    if (!c || typeof off !== 'number' || off < 0) return;
    let line = null;
    try { line = c.posFromIndex(Math.min(off, c.getValue().length)).line; } catch (e) { line = null; }
    if (line != null) jumpToLine(line);
  }, [jumpToLine]);

  // ---- 项目内搜索：跨打开标签（实时内容）+ 文件夹扫描（.tex/.bib/.md/.txt）----
  const [gSearch, setGSearch] = useState({ query: '', regex: false, matchCase: false, wholeWord: false, result: null, busy: false });
  const runGlobalSearch = useCallback(({ query, regex, matchCase, wholeWord }) => {
    setGSearch(s => ({ ...s, busy: true }));
    const tabsList = tabsRef.current
      .filter(x => x.doc)
      .map(x => ({ path: tabPath(x), name: x.name, text: x.id === activeId ? activeValue : x.doc.getValue() }));
    const disk = [
      ...folderIndex.texFiles.map(f => ({ path: f.path, text: f.source })),
      ...folderIndex.bibFiles.map(f => ({ path: f.path, text: f.source })),
      ...folderIndex.textFiles.map(f => ({ path: f.path, text: f.source })),
    ];
    const result = searchInFiles(collectSearchFiles(tabsList, disk), { query, regex, matchCase, wholeWord });
    setGSearch(s => ({ ...s, busy: false, result }));
  }, [folderIndex, activeValue, activeId, tabPath]);
  const openSearchResult = useCallback(async (path, line) => {
    setSidebarOpen(false);
    const tab = tabsRef.current.find(x => tabPath(x) === path);
    if (tab) { setActiveId(tab.id); jumpToLine(line); return; }   // jumpToLine 的 rAF 兜住换文档时序
    const entry = [...folderIndex.texFiles, ...folderIndex.bibFiles, ...folderIndex.textFiles].find(f => f.path === path);
    if (entry?.handle) {
      const opened = await openFileTab(entry.handle, entry.path, rootDir);
      if (opened) requestAnimationFrame(() => jumpToLine(line));
    }
  }, [folderIndex, rootDir, openFileTab, tabPath, jumpToLine]);

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

  const loadTemplate = async (key) => {
    const t = tabsRef.current.filter(x => x.id === activeId)[0];
    const useDraft = t && (t.kind === 'draft' || t.kind === 'tex');
    if (!await showConfirm(useDraft ? tr(getLang(), 'app.tplReplace') : tr(getLang(), 'app.tplNewTab'))) return;
    const text = samples[key] || '';
    if (useDraft && t.doc) {
      t.doc.setValue(text);
      setActiveValue(text);
      setTabs(ts => ts.map(x => x.id === t.id ? { ...x, dirty: text !== x.saved } : x));
    } else {
      const nt = makeTab({ name: tr(getLang(), 'app.draftName'), path: tr(getLang(), 'app.draftPath'), kind: 'draft', text, modeSpec: 'stex', saved: text });
      setTabs(ts => ts.concat([nt])); setActiveId(nt.id); setActiveValue(text);
    }
  };

  // ---- 编译 ----


  // ---- 预览渲染 ----
  const deferred = useDeferredValue(activeValue);
  const latexResult = useMemo(() => {
    if (!isTexLike) return null;
    const t0 = performance.now();
    let r;
    try { r = renderLatex(deferred, {}); }
    catch (e) { r = { html: '<div class="render-error">' + tr(getLang(), 'app.renderErr') + String(e && e.message || e) + '</div>', meta: {}, warnings: [{ msg: String(e && e.message || e), line: null }], diagrams: [], stats: countOf(deferred), headings: [] }; }
    lastRenderMs = performance.now() - t0;
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferred, isTexLike, lang]);

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

  // 静态检查吃滞后值 + 防抖：每键全量 lint 会把长文输入堵成卡顿
  const [lintValue, setLintValue] = useState(deferred);
  useEffect(() => {
    const timer = setTimeout(() => setLintValue(deferred), 250);
    return () => clearTimeout(timer);
  }, [deferred]);
  const diagnostics = useMemo(() => (isTexLike ? lintLaTeX(lintValue) : []), [lintValue, isTexLike, lang]);
  const allIssues = collectIssues(
    diagnostics,
    deferred === activeValue ? (latexResult?.warnings || []) : [],
    currentCompileErrors(compileResult, activeTab?.id, activeValue)
  );
  // 忽略按「问题说了什么 + 那一行的内容」记忆：改别处不该让刚清空的噪音整批复活
  const fpOf = useCallback(d => issueFingerprint(d, line => {
    try { return activeTab?.doc?.getLine(line) || ''; } catch (e) { return ''; }
  }), [activeTab?.doc]);
  const dismissed = dismissedIssues?.tabId === activeTab?.id ? dismissedIssues.fps : [];
  const visibleIssues = allIssues.filter(d => !dismissed.includes(fpOf(d)));
  const dismissIssues = ids => setDismissedIssues({
    tabId: activeTab?.id,
    fps: [...new Set([...dismissed, ...visibleIssues.filter(d => ids.includes(d.id)).map(fpOf)])]
  });
  const hiddenCount = allIssues.length - visibleIssues.length;
  // 未改动过的示例论文：状态栏给一枚标记，免得用户以为这是自己的稿子
  const isPristineDemo = activeTab?.kind === 'draft' && !activeTab.dirty && activeValue === samples.demo;
  const engineStatusText = useMemo(() => {
    if (engine !== 'builtin') return engine;
    const key = { idle: 'app.engineIdle', loading: 'app.engineLoading', warming: 'app.engineWarming', busy: 'app.engineBusy', error: 'app.engineError', ready: 'app.engineReady' }[builtinStatus];
    return t('app.builtinEngine') + (key ? ' · ' + t(key) : '');
  }, [engine, builtinStatus, t]);

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
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 's') { e.preventDefault(); if (!e.target.closest?.('.CodeMirror')) saveActiveAuto(); }
      if (mod && e.altKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); newFile(); }
      // 编译与导出走键盘：写作时不该为了出稿去菜单里找
      if (mod && e.key === 'Enter') { e.preventDefault(); doCompile(); }
      if (mod && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault(); // 不接管就会把整个应用外壳打印出去，而矢量 PDF 唯一路径正是打印
        if (compileResult?.ok && compileResult.tabId === activeTab?.id) downloadCurrentPdf();
        else exportPdfPrint();
      }
      if (mod && (e.key === '1' || e.key === '2' || e.key === '3')) {
        e.preventDefault();
        setViewMode(e.key === '1' ? 'edit' : e.key === '2' ? 'split' : 'preview');
      }
      // 查找/替换统一走编辑器内面板：焦点在不在编辑器里都同一个入口
      if (mod && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        reqFind(e.shiftKey ? 'replace' : 'find');
      }
      // VSCode 习惯的 Ctrl+H：浏览器把它留给了「历史记录」，抢得到就生效，抢不到仍可用 Ctrl+Shift+F
      if (mod && !e.altKey && (e.key === 'h' || e.key === 'H')) {
        e.preventDefault();
        reqFind('replace');
      }
      // 沉浸模式退出：Esc（补全菜单或对话框开着时不退出——那些 Esc 有自己的语义）
      if (e.key === 'Escape' && zen && !document.querySelector('dialog[open], .CodeMirror-hints')) { e.preventDefault(); setZen(false); }
      const editorFocused = e.target.closest?.('.CodeMirror');
      if (editorFocused && (e.ctrlKey || e.metaKey) && e.key === 'b' && (isTexLike || isMd)) { e.preventDefault(); quickInsert(cm(), 'tB', null, { markdown: isMd }); }
      if (editorFocused && (e.ctrlKey || e.metaKey) && e.key === 'i' && (isTexLike || isMd)) { e.preventDefault(); quickInsert(cm(), 'tI', null, { markdown: isMd }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---- 分栏拖拽：左把手调侧栏宽度，右把手调编辑/预览占比 ----
  // 指针捕获 + body.dragging 遮罩：甩快、越过 PDF iframe 或移出窗口时事件不丢
  const dragDivider = (e, edge) => {
    if (e.button !== 0) return;
    const layout = document.getElementById('layout');
    const ec = document.getElementById('editorCol');
    if (!layout || !ec) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const rect = layout.getBoundingClientRect();
    const sidebarEl = document.getElementById('sidebar');
    const sidebarW = sidebarEl ? sidebarEl.offsetWidth : 0;
    const ecLeft = ec.getBoundingClientRect().left - rect.left;
    // 编辑/预览两条把手之间可分配的宽度（侧栏与把手都是固定的）
    const free = Math.max(1, rect.width - sidebarW - 2 * DIVIDER_W);
    const maxSidebar = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, rect.width - PANES_KEEP));
    const move = (ev) => {
      const x = ev.clientX - rect.left - DIVIDER_W / 2;
      if (edge === 'left') setLayoutSize(p => ({ ...p, sidebar: Math.min(maxSidebar, Math.max(SIDEBAR_MIN, x)) }));
      else setLayoutSize(p => ({ ...p, split: Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, (x - ecLeft) / free * 100)) }));
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      if (handle.hasPointerCapture?.(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      document.body.classList.remove('dragging');
      const c = cmRef.current; if (c) c.refresh();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    document.body.classList.add('dragging');
    try { handle.setPointerCapture(e.pointerId); } catch (err) { /* 捕获失败由遮罩兜底 */ }
  };

  // 双击复位、方向键微调：把手可聚焦，不用鼠标也能改宽度
  const resetDivider = (edge) => setLayoutSize(p => (edge === 'left' ? { ...p, sidebar: SIDEBAR_DEFAULT } : { ...p, split: SPLIT_DEFAULT }));
  const nudgeDivider = (e, edge) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    if (edge === 'left') setLayoutSize(p => ({ ...p, sidebar: clampNum(p.sidebar + dir * 16, SIDEBAR_MIN, SIDEBAR_MAX, p.sidebar) }));
    else setLayoutSize(p => ({ ...p, split: clampNum(p.split + dir * 2, SPLIT_MIN, SPLIT_MAX, p.split) }));
  };

  const setZoomClamped = (d) => setZoom(z => Math.min(1.6, Math.max(0.5, +(z + d).toFixed(2))));

  // ---- LLM 上下文构建（桌面与移动端共用，见 workspace/chatContext.js） ----
  const buildContext = useCallback(
    (scope, query, channel) => buildLLMContext({ cm: () => cmRef.current, doc: valueRef.current }, scope, query, channel),
    []);
  buildContext.cm = () => cmRef.current;

  // ---- AI 修复（串行队列：勾选/全部 → 逐条发送，单条含超时+退避重试，随时可停止）----
  const MAX_FIX_PER_RUN = 40;
  const FIX_TIMEOUT_MS = 90_000;
  const FIX_MAX_RETRY = 2;

  const toggleSel = useCallback((id) => {
    setSelIds(prev => {
      if (fixRun && fixRun.active) return prev; // 修复进行中锁定选择，避免队列与勾选错位
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }, [fixRun]);

  const toggleSelAll = useCallback((on) => {
    if (fixRun && fixRun.active) return;
    setSelIds(on ? new Set(visibleIssues.map(d => d.id)) : new Set());
  }, [fixRun, visibleIssues]);

  const startFix = async (requested) => {
    if (fixRun && fixRun.active) return;              // 并发守卫：一轮没跑完不再起第二轮
    const L = getLang();
    const channel = channels.filter(c => c.id === activeChannelId)[0];
    if (!channel) { setSettingsOpen(true); alert(tr(L, 'app.needChannel')); return; }
    if (!isTexLike) { flash(tr(L, 'app.onlyTexAiFix')); return; }

    // 勾选优先，未勾选则修全部
    const pool = requested && requested.length ? requested : visibleIssues;
    if (!pool.length) { flash(tr(L, 'app.noFixable')); return; }
    const issues = pool.slice(0, MAX_FIX_PER_RUN);
    if (pool.length > issues.length) flash(tr(L, 'app.aiFixTooMany', { n: MAX_FIX_PER_RUN }));

    const lines = activeValue.split('\n');
    const tasks = issues.map((d, i) => ({ id: d.id, index: i, meta: d, prompt: aiFixIssuePrompt({ issues: [d], lines }) }));
    const taskById = {};
    tasks.forEach(t => { taskById[t.id] = t; });

    const ctrl = new AbortController();
    fixCtrlRef.current = ctrl;
    const per = {};
    issues.forEach(d => { per[d.id] = { status: 'queued' }; });
    setFixRun({ active: true, total: tasks.length, done: 0, per });
    setChatOpen(true); setPanelOpen(false);

    // 每条各自占用一对气泡；按 fixId 定位，别的消息插入也不会串台
    const ensureBubble = (task) => setChatMessages(ms => {
      if (ms.some(m => m.fixId === task.id)) return ms;
      const d = task.meta;
      const label = tr(L, 'app.fixIssueN', {
        n: task.index + 1, total: tasks.length,
        line: d.line != null ? d.line + 1 : '?', msg: d.msg
      });
      return ms.concat([{ role: 'user', content: label }, { role: 'assistant', content: '', reasoning: '', fixId: task.id }]);
    });
    const patchMsg = (id, fn) => setChatMessages(ms => ms.map(m => m.fixId === id ? fn(m) : m));

    try {
      const results = await runFixQueue({
        tasks,
        signal: ctrl.signal,
        maxRetry: FIX_MAX_RETRY,
        baseDelay: 800,
        invoke: (task, { signal }) => llm.chat(channel, [{ role: 'user', content: task.prompt }], {
          stream: true, signal, timeoutMs: FIX_TIMEOUT_MS,
          onDelta: (c) => patchMsg(task.id, m => ({ ...m, content: m.content + c })),
          onReasoning: (c) => patchMsg(task.id, m => ({ ...m, reasoning: (m.reasoning || '') + c })),
        }),
        onUpdate: (id, patch) => {
          if (patch.status === 'fixing' || patch.status === 'retrying') ensureBubble(taskById[id]);
          if (patch.status === 'failed') patchMsg(id, m => ({ ...m, content: (m.content ? m.content + '\n\n' : '') + tr(L, 'app.aiFixFailed', { msg: patch.error || '' }) }));
          if (patch.status === 'cancelled') patchMsg(id, m => m.content ? m : { ...m, content: tr(L, 'app.aiFixCancelled') });
          setFixRun(prev => {
            if (!prev) return prev;
            const next = { ...prev.per, [id]: patch };
            const done = Object.values(next).filter(s => s.status === 'done' || s.status === 'failed' || s.status === 'cancelled').length;
            return { ...prev, per: next, done };
          });
        }
      });
      let ok = 0, fail = 0, cancel = 0;
      for (const id in results) {
        const s = results[id].status;
        if (s === 'done') ok++; else if (s === 'failed') fail++; else if (s === 'cancelled') cancel++;
      }
      flash(tr(L, 'app.aiFixSummary', { ok, fail, cancel }));
    } finally {
      fixCtrlRef.current = null;
      setFixRun(prev => prev ? { ...prev, active: false } : prev);
    }
  };

  const stopFix = () => {
    if (fixCtrlRef.current) fixCtrlRef.current.abort();
  };

  const aiBusy = !!(fixRun && fixRun.active);

  // ---- AI 修复（单问题：编辑器诊断红橙点点击，预填提示词到对话输入框）----
  const aiFixIssue = (issue, list) => {
    const L = getLang();
    const channel = channels.filter(c => c.id === activeChannelId)[0];
    if (!channel) { setSettingsOpen(true); alert(tr(L, 'app.needChannel')); return; }
    if (!isTexLike) { flash(tr(L, 'app.onlyTexAiFix')); return; }
    const all = (list && list.length ? list : [issue]);
    setChatOpen(true); setPanelOpen(false);
    setChatInject({ text: aiFixIssuePrompt({ issues: all, lines: activeValue.split('\n') }), n: Date.now() });
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
  const downloadCurrentPdf = async () => {
    const result = compileResult;
    if (!result?.ok || result.tabId !== activeTab?.id) return;
    if (result.staleNow ? result.staleNow() : result.source !== activeTab.doc.getValue()) {
      if (!await showConfirm(t('prev.downloadStale'))) return;
    }
    return downloadCompiled(result);
  };

  const SNIP = makeSnippets(t);
  const stats = previewResult && previewResult.stats ? previewResult.stats : countOf(activeValue);
  const wordText = (stats.cjk ? t('st.chars', { n: stats.cjk }) : '') + (stats.cjk && stats.words - stats.cjk > 0 ? ' + ' : '') + (stats.words - stats.cjk > 0 ? t('st.words', { n: stats.words - stats.cjk }) : '');
  const issueCount = visibleIssues.length;
  const hasEditor = !!activeTab?.doc;
  const channelCount = channels.length;
  const currentSaveState = saveState(activeTab);
  const tourSteps = useMemo(() => tourStepsFor({ compact, viewMode, hasEditor, richPreview: !!previewResult && previewMode === 'rich', texDocument: isTexLike }), [compact, viewMode, hasEditor, previewResult, previewMode, isTexLike]);

  return (
    <LangContext.Provider value={lang}>
      <Toolbar
        compact={compact} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen(o => !o)}
        texDocument={isTexLike}
        actions={{
          newFolder, upload: uploadFiles, copy: makeCopy, canCopy: !!activeTab?.doc,
          history: () => setFileDialog('history'), wordCount: () => setFileDialog('wordCount'),
          submit: () => setFileDialog('submit'), settings: () => setFileDialog('settings'),
          sourceZip: exportProject, packaging, pdfAvailable: isTexLike || isMd,
          exportSource: () => downloadFile(activeTab.name, activeTab.doc.getValue(), 'text/plain;charset=utf-8'),
          newFile, loadTemplate, openFile: openSingleFile, openFolder, save: saveActiveAuto,
          gSearch: () => { setSideTab('search'); setSidebarOpen(true); },
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
            else if (op === 'selectAll') c.execCommand(op);
            else if (op === 'find' || op === 'replace') { reqFind(op); return; }
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
                const targetDoc = activeTab.doc;
                const from = targetDoc.getCursor('from'), to = targetDoc.getCursor('to');
                const dir = activeTab.parentDir || rootDir;
                inp.type = 'file'; inp.accept = isMd ? 'image/*,application/pdf,.pdf' : 'image/png,image/jpeg,image/svg+xml,application/pdf,.pdf,.svg';
                inp.onchange = async () => {
                  const f = inp.files && inp.files[0];
                  if (!f) return;
                  await insertImageFile({ file: f, targetDoc, from, to, isMd, dir, tabsRef, setTabs, onTreeChanged: () => setTreeKey(n => n + 1), t, alertBox: alert });
                };
                inp.click();
                return;
              }
              case 'tCiteSearch': {
                if (!isTexLike) { flash(t('cite.onlyTex')); return; }
                setCiteOpen(true);
                return;
              }
              default: if (SNIP[id]) insert(SNIP[id]);
            }
          }
        }}
        viewMode={viewMode} setViewMode={setViewMode} latexOk={isTexLike || isMd}
        markdown={isMd} documentKey={activeId}
        labels={refCompletion.labels.map(l => l.key)}
        engines={engines} engine={engine} setEngine={setEngine} compiling={compiling} onCompile={doCompile} onCancelCompile={doCancelCompile} builtinStatus={builtinStatus}
        downloadPdf={compileResult?.ok && compileResult.tabId === activeTab?.id ? downloadCurrentPdf : null}
        channelCount={channelCount} onOpenChat={() => { setChatOpen(o => !o); setPanelOpen(false); }} onOpenSettings={() => setSettingsOpen(true)}
        onAiFix={() => startFix(visibleIssues)}
        syncScroll={syncScroll} setSyncScroll={setSyncScroll}
        zen={zen} setZen={setZen}
        typewriter={editorSettings.typewriter === true}
        setTypewriter={v => setEditorSettings(s => ({ ...s, typewriter: !!v }))}
        snippets={snippets}
        onInsertSnippet={content => insert(content)}
        onManageSnippets={() => setFileDialog('snippets')}
        zoom={zoom} onZoom={setZoomClamped}
        onHelp={openHelp}
        lang={lang} setLang={setLang}
        theme={theme} setTheme={setTheme}
      />

      <main id="layout" data-mode={viewMode} data-sidebar-open={compact && sidebarOpen} style={{ '--sidebar-w': layoutSize.sidebar + 'px', '--g-edit': String(layoutSize.split), '--g-prev': String(100 - layoutSize.split) }}>
        {compact && sidebarOpen && <button className="sidebar-backdrop" aria-label={t('side.close')} onClick={() => setSidebarOpen(false)} />}
        <div id="sidebar">
          <div className="side-tabs">
            <button className={sideTab === 'files' ? 'on' : ''} title={t('side.files')} onClick={() => setSideTab('files')}>{lang === 'zh' ? '文' : '▤'}</button>
            <button className={sideTab === 'outline' ? 'on' : ''} title={t('side.outline')} onClick={() => setSideTab('outline')}>{lang === 'zh' ? '纲' : '≣'}</button>
            <button className={sideTab === 'search' ? 'on' : ''} title={t('side.search')} onClick={() => setSideTab('search')}>{lang === 'zh' ? '搜' : '⌕'}</button>
            <button className={sideTab === 'issues' ? 'on' : ''} title={t('side.issues')} onClick={() => setSideTab('issues')}>{'⚠\uFE0E'}{issueCount ? <em>{issueCount}</em> : null}</button>
            <button title={t('m.history')} aria-label={t('m.history')} disabled={!activeTab?.doc} onClick={() => setFileDialog('history')}>↶</button>
          </div>
          <div className="side-body">
            {sideTab === 'files' && (rootDir ? (
              <FileTree root={rootDir} onOpenFile={openFileTab} onCloseFolder={closeFolder} refreshKey={treeKey} />
            ) : (
              <div className="side-pad side-empty">
                {restorePrompt && <button className="btn sm" onClick={restoreFolder}>{t('side.restore', { name: restorePrompt.name })}</button>}
                <button className="btn primary sm" onClick={openFolder}>{t('side.openFolder')}</button>
                <button className="btn sm" onClick={newFile}>{t('side.newDraft')}</button>
                <p className="hint">{t('side.noFolder1')}</p>
                <p className="hint">{t('side.noFolder2')}</p>
              </div>
            ))}
            {sideTab === 'outline' && <OutlinePanel kind={outlineKind} headings={outlineItems} onJump={jumpToHeading} />}
            {sideTab === 'search' && (
              <GlobalSearchPanel state={gSearch} setState={setGSearch} onSearch={runGlobalSearch} onOpen={openSearchResult} hasFolder={!!rootDir} />
            )}
            {sideTab === 'issues' && (
              <DiagnosticsPanel
                issues={visibleIssues}
                dismissedCount={allIssues.length - visibleIssues.length}
                onRestore={() => setDismissedIssues(null)}
                onDismiss={d => dismissIssues([d.id])}
                onClear={() => dismissIssues(visibleIssues.map(d => d.id))}
                onJump={(d) => jumpToLine(d.line)}
                onAiFix={() => startFix(selIds.size ? visibleIssues.filter(d => selIds.has(d.id)) : visibleIssues)}
                aiBusy={aiBusy}
                selected={selIds}
                onToggle={toggleSel}
                onToggleAll={toggleSelAll}
                fixRun={fixRun}
                onStop={stopFix}
              />
            )}
          </div>
        </div>

        {viewMode !== 'preview' && (
          <div id="sideDivider" className="divider" role="separator" aria-orientation="vertical" tabIndex={0}
            aria-valuenow={Math.round(layoutSize.sidebar)} aria-valuemin={SIDEBAR_MIN} aria-valuemax={SIDEBAR_MAX}
            title={lang === 'zh' ? '拖动调整侧栏宽度 · 双击复位' : 'Drag to resize sidebar · double-click to reset'}
            onPointerDown={e => dragDivider(e, 'left')} onDoubleClick={() => resetDivider('left')} onKeyDown={e => nudgeDivider(e, 'left')}></div>
        )}

        <section id="editorCol">
          <TabsBar tabs={tabs} activeId={activeId} onActivate={id => setActiveId(id)} onClose={closeTab} />
          {hasEditor ? (
            <EditorPane
              doc={activeTab.doc}
              onChange={onDocChange}
              onInit={(c) => { cmRef.current = c; setCmReady(x => x + 1); }}
              onScrollRatio={handleScrollRatio}
              onSave={saveActiveAuto}
              diagnostics={visibleIssues}
              onFixIssue={aiFixIssue}
              findReq={findReq}
              spellcheck={editorSettings.spellcheck && (isTexLike || isMd)}
              grammarCheck={editorSettings.grammarCheck && (isTexLike || isMd)}
              typewriter={editorSettings.typewriter === true}
              refCompletion={refCompletion}
              completion={{ texLike: isTexLike, pool: completionPool, userCommands }}
              onForwardSync={forwardSyncToPdf}
              onImageFile={(file, targetDoc, from, to) => insertImageFile({
                file, targetDoc, from, to, isMd,
                dir: (tabsRef.current.filter(x => x.id === activeId)[0] || {}).parentDir || rootDir,
                tabsRef, setTabs, onTreeChanged: () => setTreeKey(n => n + 1), t, alertBox: alert,
              })}
            />
          ) : (
            <div className="binary-note">
              <div>{activeTab.name}</div>
              <div className="hint">{t(activeTab.kind === 'image' ? 'prev.imageNote' : 'file.assetNote')}</div>
            </div>
          )}
        </section>

        {viewMode === 'split' && (
          <div id="divider" className="divider" role="separator" aria-orientation="vertical" tabIndex={0}
            aria-valuenow={Math.round(layoutSize.split)} aria-valuemin={SPLIT_MIN} aria-valuemax={SPLIT_MAX}
            title={lang === 'zh' ? '拖动调整编辑/预览宽度 · 双击复位' : 'Drag to resize split · double-click to reset'}
            onPointerDown={e => dragDivider(e, 'right')} onDoubleClick={() => resetDivider('right')} onKeyDown={e => nudgeDivider(e, 'right')}></div>
        )}

        {viewMode !== 'edit' && (
          activeTab && activeTab.kind === 'pdf' ? (
            <PdfViewer key={activeTab.id} url={activeTab.imageUrl} title={activeTab.name} lang={lang}
              onDownload={async () => downloadFile(activeTab.name, activeTab.uploadedFile || await (await fetch(activeTab.imageUrl)).blob())} />
          ) : activeTab && (activeTab.kind === 'image' || isSvg) ? (
            <section id="previewPane">
              <div id="previewBar"><span className="pb-title">{t('prev.title')}</span></div>
              <div id="previewScroll"><div id="preview"><div id="paper" className="paper image-view" style={{ zoom }}>
                <img src={svgPreviewUrl || activeTab.imageUrl} alt={activeTab.name} style={{ maxWidth: '100%' }} />
              </div></div></div>
            </section>
          ) : previewMode === 'pdf' && compileResult?.ok && compileResult.tabId === activeTab?.id ? (
            <PdfViewer ref={pdfViewerRef} url={compileResult.pdfUrl} title={activeTab.name + ' · PDF'} lang={lang}
              stale={pdfIsStale} compiling={compiling} onCompile={doCompile}
              onBackSync={backSyncToSource}
              onDownload={downloadCurrentPdf} onClose={() => setPreviewMode('rich')} />
          ) : previewMode === 'log' && compileResult ? (
            <section id="previewPane">
              <div id="previewBar">
                <span className="pb-title bad">✕ {compileResult.engine} {t('prev.compileFail')}</span>
                <span className="pb-spacer"></span>
                <button className="btn sm" onClick={doCompile} disabled={compiling}>{compiling ? t('prev.compiling') : t('prev.retry')}</button>
                <button className="btn sm" onClick={() => { navigator.clipboard?.writeText(compileResult.log || ''); flash(t('prev.logCopied')); }}>{t('prev.copyLog')}</button>
                <button className="btn sm" onClick={() => setLogFull(f => !f)} aria-expanded={logFull}>{logFull ? t('prev.logTail') : t('prev.logFull')}</button>
                <button className="btn sm" onClick={() => setPreviewMode('rich')}>{t('prev.back')}</button>
              </div>
              <div id="previewScroll">
                <div className="compile-log">
                  {visibleIssues.filter(d => d.src === 'compile').map((e, i) => (
                    <div key={i} className={'diag-item error' + (e.line == null ? ' no-line' : '')}
                      aria-disabled={e.line == null} title={e.line == null ? t('diag.noLine') : t('diag.jump')}
                      onClick={() => e.line != null && jumpToLine(e.line)}>
                      <span className="diag-sev">✖</span>
                      <span className="diag-msg">{e.msg}</span>
                      {e.line != null && <span className="diag-line">{t('diag.line', { n: e.line + 1 })}</span>}
                    </div>
                  ))}
                  {(() => {
                    const all = (compileResult.log || '').split('\n');
                    const shown = logFull || all.length <= 120 ? all : all.slice(-120);
                    return <>
                      {!logFull && all.length > 120 && <div className="log-note">{t('prev.logTruncated', { n: all.length })}</div>}
                      <pre>{shown.join('\n')}</pre>
                    </>;
                  })()}
                </div>
              </div>
            </section>
          ) : previewResult ? (
            <PreviewPane
              result={previewResult}
              assetDir={activeTab?.parentDir} assetTabs={tabs}
              selection={selection}
              onSelectNode={(did, sidx) => { setSelection({ did, sel: { type: 'node', sidx } }); setPanelOpen(true); setChatOpen(false); }}
              onSelMermaid={(block, id, cur) => { setSelection({ did: 0, sel: { type: 'mermaid', block, id, cur } }); setPanelOpen(true); setChatOpen(false); }}
              onSelectTable={(id) => { setSelection({ did: 0, sel: { type: 'table', id } }); setPanelOpen(true); setChatOpen(false); }}
              onJumpOff={handleJumpOff}
              onScrollRatio={handleScrollRatio}
              zoom={zoom} onZoom={setZoomClamped}
              panelOpen={panelOpen} onTogglePanel={() => { setPanelOpen(o => !o); setChatOpen(false); }}
              syncScroll={syncScroll} onSyncToggle={setSyncScroll}
              engines={engines} engine={engine} setEngine={setEngine} compiling={compiling} onCompile={doCompile} onCancelCompile={doCancelCompile} builtinStatus={builtinStatus}
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
        <span className="st-path">{activeTab ? (activeTab.kind === 'draft' ? t('app.draftPath') : (activeTab.path || activeTab.name)) : ''}</span>
        {currentSaveState && <div className={'save-status ' + currentSaveState}>
          <span role="status" title={activeTab.saveError || t('save.' + currentSaveState + '.tip')}>{t('save.' + currentSaveState)}</span>
          {currentSaveState !== 'diskSaved' && <button className="btn sm" disabled={activeTab.saving} onClick={() => currentSaveState === 'failed' ? saveActiveAuto() : activeTab.kind === 'draft' ? saveTabAs(activeTab) : saveActiveAuto()}>
            {t(currentSaveState === 'failed' ? 'save.retry' : activeTab.kind === 'draft' || !activeTab.handle ? 'save.toFile' : 'm.save')}
          </button>}
        </div>}
        {isPristineDemo && <span className="st-chip" title={t('st.sampleTip')}>{t('st.sample')}</span>}
        {isTexLike && mainDoc && mainDoc.path !== tabPath(activeTab) && (
          <span className="st-chip" title={t('st.mainDocTip')}>⌂ {mainDoc.name || mainDoc.path}</span>
        )}
        <span className="sep">·</span>
        <span className="st-detail">{wordText}</span>
        <span className="sep">·</span>
        <span className="st-detail">{isTexLike || isMd ? lastRenderMs.toFixed(0) + ' ms' : t('st.textMode')}</span>
        <span className="sep">·</span>
        <button className={'st-warn' + (issueCount ? ' has' : '')} onClick={() => { setSideTab('issues'); if (compact) setSidebarOpen(true); }}>
          {issueCount ? t('st.issues', { n: issueCount }) : hiddenCount ? t('diag.hidden', { n: hiddenCount }) : t('st.noIssues')}
        </button>
        <span className="grow"></span>
        {/* 引擎与预热状态原来只藏在下拉框的 option 文本里，这里常驻一份 */}
        <span className={'st-engine' + (engine === 'builtin' && builtinStatus === 'error' ? ' bad' : '')} title={t('st.engineTip')}>
          {t('st.engine')} {engineStatusText}
        </span>
        {flashMsg && <span className={'st-flash' + (currentSaveState === 'failed' ? ' bad' : '')}>{flashMsg}</span>}
        <span className="hint">{t('st.hint')}</span>
      </footer>

      {viewMode !== 'edit' && isTexLike && cmReady >= 0 && (
        <StylePanel open={panelOpen && !chatOpen && selection.sel?.type !== 'table'} onClose={() => setPanelOpen(false)} result={latexResult} cm={cmRef.current} selection={selection} setSelection={setSelection} />
      )}
      {viewMode !== 'edit' && isTexLike && cmReady >= 0 && (
        <TablePanel open={panelOpen && !chatOpen && selection.sel?.type === 'table'} onClose={() => setPanelOpen(false)} result={latexResult} cm={cmRef.current} selection={selection} />
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
        onBeforeApply={() => snapshot(tr(getLang(), 'hist.beforeAi'), 'manual', true)}
        messages={chatMessages}
        setMessages={setChatMessages}
        externalBusy={aiBusy}
      />

      <DialogHost />
      {citeOpen && <CiteDialog onClose={() => setCiteOpen(false)} onInsert={insertCitation} />}
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        channels={channels}
        setChannels={setChannels}
        activeChannelId={activeChannelId}
        setActiveChannelId={setActiveChannelId}
      />

      {fileDialog === 'history' && activeTab.doc && <HistoryDialog key={activeId} name={activeTab.name} current={activeTab.doc.getValue()} versions={readHistory(historyKey)}
        onExportLegacy={activeTab.kind === 'draft' && readHistory('["","draft"]').length ? () => downloadFile('paperlite-legacy-draft-history.json', JSON.stringify(readHistory('["","draft"]'), null, 2), 'application/json') : null}
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
        mainDoc={pinnedMainDoc} mainDocOptions={mainDocOptions} onMainDoc={setPinnedMainDoc}
        snippets={snippets} onSnippets={setSnippets}
        onSource={exportProject} busy={packaging} pdfAvailable={isTexLike || isMd} compiledPdf={!!compileResult?.ok}
        onPdf={compileResult?.ok ? downloadCurrentPdf : exportPdfPrint}
      />}

      {helpOpen === 'keys' && (
        <div className="modal-mask" onClick={e => { if (e.target === e.currentTarget) setHelpOpen(null); }}>
          <div className="modal help-modal" role="dialog" aria-modal="true" aria-label={t('help.keys')} onClick={e => e.stopPropagation()}>
            <div className="modal-h">{t('help.keys')} <button className="btn sm" onClick={() => setHelpOpen(null)}>✕</button></div>
            <div className="modal-body">
              <table className="keys-table">
                <tbody>
                  {[['Ctrl+S', t('help.k1')],
                    ['Ctrl+Alt+N', t('help.k6')],
                    ['Ctrl+F', t('help.k10')],
                    ['Ctrl+H / Ctrl+Shift+F', t('help.k11')],
                    ['Enter / Shift+Enter', t('help.k12')],
                    ['Alt+Enter / Esc', t('help.k13')],
                    ['Ctrl+Enter', t('help.k7')],
                    ['Ctrl+P', t('help.k8')],
                    ['Ctrl+1 / 2 / 3', t('help.k9')],
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

      {helpOpen === 'feedback' && (
        <div className="modal-mask" onClick={e => { if (e.target === e.currentTarget) setHelpOpen(null); }}>
          <div className="modal help-modal" role="dialog" aria-modal="true" aria-label={t('help.feedback')} onClick={e => e.stopPropagation()}>
            <div className="modal-h">{t('help.feedback')} <button className="btn sm" onClick={() => setHelpOpen(null)}>✕</button></div>
            <div className="modal-body">
              <div className="feedback-intro">{t('help.fbIntro')}</div>
              <ul className="about-list feedback-list">
                <li>{t('help.fbTip1')}</li>
                <li>{t('help.fbTip2')}</li>
                <li>{t('help.fbTip3')}</li>
              </ul>
              <div className="about-repo">
                <a href="https://github.com/Ikaros-521/PaperLite/issues" target="_blank" rel="noopener noreferrer">{t('help.fbLink')}</a>
              </div>
            </div>
          </div>
        </div>
      )}

      {helpOpen === 'about' && (
        <div className="modal-mask" onClick={e => { if (e.target === e.currentTarget) setHelpOpen(null); }}>
          <div className="modal help-modal" role="dialog" aria-modal="true" aria-label={t('help.about')} onClick={e => e.stopPropagation()}>
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
          folderSupported={fs.supported()}
          onStart={() => { dismissWelcome(true); setTourStage('tour'); }}
          onNewDraft={() => {
            let n = 1;
            let name = t('app.newFileDefault', { n: '' });
            while (tabsRef.current.some(tab => tab.name === name)) name = t('app.newFileDefault', { n: ++n });
            const text = samples.blank;
            const tab = makeTab({ name, kind: 'draft', text, modeSpec: 'stex', saved: text });
            setTabs(ts => ts.concat(tab)); setActiveId(tab.id); setActiveValue(text);
            dismissWelcome(true); setTourStage(null); setViewMode(compact ? 'edit' : 'split');
          }}
          onOpenFolder={() => { dismissWelcome(true); setTourStage(null); openFolder(); }}
          onClose={noAuto => { dismissWelcome(noAuto); setTourStage(null); }}
        />
      )}

      {tourStage === 'tour' && (
        <TourGuide steps={tourSteps} onClose={() => { markTourDone(); setTourStage(null); }} />
      )}
    </LangContext.Provider>
  );
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

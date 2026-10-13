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

const LS_KEY = 'paperlite.doc.v2';
const LS_MODE = 'paperlite.viewmode.v2';
let lastRenderMs = 0;
let tabSeq = 0;

const SNIPPETS = {
  tEq: '\n\\begin{equation}\n  \n\\end{equation}\n',
  tList: '\n\\begin{itemize}\n  \\item \n\\end{itemize}\n',
  tEnum: '\n\\begin{enumerate}\n  \\item \n\\end{enumerate}\n',
  tTable: '\n\\begin{table}[h]\n\\centering\n\\begin{tabular}{lcc}\n\\toprule\n列一 & 列二 & 列三 \\\\\n\\midrule\nA & B & C \\\\\n\\bottomrule\n\\end{tabular}\n\\caption{表标题}\n\\label{tab:mytab}\n\\end{table}\n',
  tFlow: '\n\\begin{tikzpicture}[node distance=1.5cm]\n  \\node[rectangle, rounded corners=6pt, fill=blue!15, draw=blue!60!black] (a) {开始};\n  \\node[rectangle, rounded corners=6pt, fill=teal!12, draw=teal!70!black, right of=a, node distance=3cm] (b) {处理步骤};\n  \\node[diamond, fill=yellow!25, draw=orange!80!black, right of=b, node distance=3cm] (c) {判断?};\n  \\node[rectangle, rounded corners=10pt, fill=green!12, draw=green!50!black, below of=b, node distance=2cm] (d) {结束};\n  \\draw[-stealth, thick] (a) -- (b);\n  \\draw[-stealth, thick] (b) -- (c);\n  \\draw[-stealth, thick] (c) -- node[above, font=\\\\small]{是} (d);\n\\end{tikzpicture}\n',
  tMermaid: '\n\\begin{mermaid}\nflowchart LR\n  A[开始] --> B{条件?}\n  B -- 是 --> C[处理]\n  B -- 否 --> D[结束]\n\\end{mermaid}\n',
  tBib: '\\cite{key}'
};

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
  // ---- 多标签 ----
  const [tabs, setTabs] = useState(() => {
    let saved = '';
    try { saved = localStorage.getItem(LS_KEY) || ''; } catch (e) { /* ignore */ }
    const text = saved.trim() ? saved : samples.demo;
    return [makeTab({ name: '草稿.tex', path: '(浏览器草稿)', kind: 'draft', text, modeSpec: 'stex', saved: text })];
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
      flash('已打开文件夹：' + h.name);
    } catch (e) { if (e && e.name !== 'AbortError') alert('打开文件夹失败：' + (e.message || e)); }
  };
  const closeFolder = async () => { setRootDir(null); setRestorePrompt(null); await fs.clearRootHandle(); };
  const restoreFolder = async () => {
    if (!restorePrompt) return;
    const perm = await fs.requestPermission(restorePrompt, 'readwrite');
    if (perm === 'granted') { setRootDir(restorePrompt); setRestorePrompt(null); setSideTab('files'); }
  };

  // ---- 打开文件 ----
  const openFileTab = useCallback(async (fileHandle, path, parentDir) => {
    const name = fileHandle.name || (path ? path.split('/').pop() : '未命名');
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
    } catch (e) { alert('无法打开 ' + name + '：' + (e.message || e)); return null; }
  }, []);

  useEffect(() => {
    window.__plInject = (name, content) => {
      const info = infoFor(name);
      const t = makeTab({ name, path: '(内存) ' + name, kind: info.kind, text: content, modeSpec: info.mode, saved: content });
      setTabs(ts => ts.concat([t])); setActiveId(t.id); setActiveValue(content);
      return t.id;
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

  // ---- 保存 ----
  const saveActive = useCallback(async () => {
    const t = tabsRef.current.filter(x => x.id === activeId)[0];
    if (!t) return;
    if (t.kind === 'draft') {
      try { localStorage.setItem(LS_KEY, t.doc ? t.doc.getValue() : ''); } catch (e) { /* ignore */ }
      setTabs(ts => ts.map(x => x.id === t.id ? { ...x, saved: x.doc.getValue(), dirty: false } : x));
      flash('草稿已保存到浏览器');
      return;
    }
    if (!t.handle) { flash('此标签不可写'); return; }
    try {
      await fs.writeFileText(t.handle, t.doc.getValue());
      setTabs(ts => ts.map(x => x.id === t.id ? { ...x, saved: x.doc.getValue(), dirty: false } : x));
      flash('已保存：' + t.name);
    } catch (e) { alert('保存失败：' + (e.message || e)); }
  }, [activeId, flash]);

  // ---- 关闭标签 ----
  const closeTab = useCallback((id) => {
    const t = tabsRef.current.filter(x => x.id === id)[0];
    if (t && t.dirty && !window.confirm(`「${t.name}」有未保存的修改，关闭将丢失。继续？`)) return;
    if (t && t.imageUrl) URL.revokeObjectURL(t.imageUrl);
    setTabs(ts => {
      const rest = ts.filter(x => x.id !== id);
      if (!rest.length) {
        const text = samples.blank;
        const nt = makeTab({ name: '草稿.tex', path: '(浏览器草稿)', kind: 'draft', text, modeSpec: 'stex', saved: text });
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
      alert('当前浏览器不支持直接打开文件（需 Chrome / Edge）。可改用「打开文件夹」。');
      return;
    }
    try {
      const [h] = await window.showOpenFilePicker({ multiple: false });
      await openFileTab(h, h.name, null);
    } catch (e) { if (e && e.name !== 'AbortError') alert('打开失败：' + (e.message || e)); }
  };

  const loadTemplate = (key) => {
    const t = tabsRef.current.filter(x => x.id === activeId)[0];
    const useDraft = t && (t.kind === 'draft' || t.kind === 'tex');
    if (!window.confirm(useDraft ? '载入模板将替换当前内容（可先导出 .tex 备份）。继续？' : '模板将载入到新的草稿标签。继续？')) return;
    const text = samples[key] || '';
    if (useDraft && t.doc) {
      t.doc.setValue(text);
      setActiveValue(text);
      setTabs(ts => ts.map(x => x.id === t.id ? { ...x, saved: text, dirty: false } : x));
    } else {
      const nt = makeTab({ name: '草稿.tex', path: '(浏览器草稿)', kind: 'draft', text, modeSpec: 'stex', saved: text });
      setTabs(ts => ts.concat([nt])); setActiveId(nt.id); setActiveValue(text);
    }
  };

  // ---- 编译 ----
  const doCompile = async () => {
    if (compiling) return;
    if (!isTexLike) { flash('仅 .tex 文件可编译'); return; }
    if (!engines.length) {
      alert('未检测到本机 TeX 引擎。\n\n请安装 MiKTeX 或 TeX Live（加入 PATH），并通过 node server.mjs 启动本应用后重试。');
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
        flash(engine + ' 编译成功');
      } else {
        setCompileResult({ ok: false, log: j.log || '', errors: j.errors || [], error: j.error || '编译失败', engine });
        setPreviewMode('log');
      }
    } catch (e) {
      alert('编译请求失败：' + (e.message || e) + '\n（需通过 node server.mjs 访问）');
    } finally { setCompiling(false); }
  };

  // ---- 预览渲染 ----
  const deferred = useDeferredValue(activeValue);
  const latexResult = useMemo(() => {
    if (!isTexLike) return null;
    const t0 = performance.now();
    let r;
    try { r = renderLatex(deferred, {}); }
    catch (e) { r = { html: '<div class="render-error">渲染器异常：' + String(e && e.message || e) + '</div>', meta: {}, warnings: [String(e)], diagrams: [], stats: countOf(deferred), headings: [] }; }
    lastRenderMs = performance.now() - t0;
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferred, isTexLike]);

  const mdResult = useMemo(() => {
    if (!isMd) return null;
    const t0 = performance.now();
    let r;
    try { r = renderMarkdownFull(deferred); }
    catch (e) { r = { html: '<div class="render-error">Markdown 渲染异常：' + String(e && e.message || e) + '</div>', headings: [] }; }
    lastRenderMs = performance.now() - t0;
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferred, isMd]);

  const diagnostics = useMemo(() => (isTexLike ? lintLaTeX(deferred) : []), [deferred, isTexLike]);

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
    const trunc = (t) => t.length > limit ? t.slice(0, Math.floor(limit * 0.7)) + '\n\n……（中略）……\n\n' + t.slice(-Math.floor(limit * 0.3)) : t;
    if (scope === 'selection') {
      const sel = c ? c.getSelection() : '';
      return { text: sel || '', note: sel ? '📎 上下文：选区' : '📎 上下文：选区（空）' };
    }
    if (scope === 'paragraph') {
      if (!c) return { text: '', note: '' };
      const cur = c.getCursor();
      let a = cur.line, b = cur.line;
      const n = c.lineCount();
      while (a > 0 && (c.getLine(a - 1) || '').trim()) a--;
      while (b < n - 1 && (c.getLine(b + 1) || '').trim()) b++;
      const text = rangeText(c, a, b);
      return { text: trunc(text), note: `📎 上下文：光标段落（${a + 1}-${b + 1} 行）` };
    }
    if (scope === 'retrieve') {
      if (channel && channel.embedModel) {
        const chunks = await llm.retrieve(channel, query, doc, 6);
        if (chunks && chunks.length) {
          return { text: chunks.join('\n\n——\n\n').slice(0, limit), note: `📎 上下文：检索增强（top ${chunks.length} 段）` };
        }
      }
      return { text: trunc(doc), note: '📎 上下文：全文（检索模型不可用，已回退）' };
    }
    return { text: trunc(doc), note: '📎 上下文：全文' + (doc.length > limit ? '（已截断）' : '') };
  }, []);
  buildContext.cm = () => cmRef.current;

  // ---- AI 修复 ----
  const aiFix = async () => {
    const channel = channels.filter(c => c.id === activeChannelId)[0];
    if (!channel) { setSettingsOpen(true); alert('请先添加并选择 AI 渠道。'); return; }
    if (!isTexLike) { flash('仅 .tex 文件支持 AI 修复'); return; }
    const issues = [
      ...(compileResult && compileResult.errors ? compileResult.errors.map(e => ({ line: e.line, msg: e.msg })) : []),
      ...diagnostics
    ].slice(0, 20);
    if (!issues.length) { flash('当前没有可修复的问题'); return; }
    setAiBusy(true);
    setChatOpen(true); setPanelOpen(false);
    const prompt = '请修复以下 LaTeX 文档中的语法问题，输出修复后的【完整文档】于 ```latex 代码块中，并用一两句话说明修改点。\n\n' +
      '问题清单：\n' + issues.map(d => `- 第 ${d.line != null ? d.line + 1 : '?'} 行：${d.msg}`).join('\n') +
      '\n\n文档：\n```latex\n' + activeValue.slice(0, channel.contextLimit || 24000) + '\n```';
    setChatMessages(ms => ms.concat([{ role: 'user', content: '(AI 修复请求) 已附问题清单与文档', ctxNote: `🛠 ${issues.length} 个问题` }, { role: 'assistant', content: '', reasoning: '' }]));
    try {
      const r = await llm.chat(channel, [{ role: 'user', content: prompt }], { temperature: 0.2 });
      setChatMessages(ms => ms.map((m, i) => i === ms.length - 1 ? { ...m, content: r.content, reasoning: r.reasoning || '' } : m));
    } catch (e) {
      setChatMessages(ms => ms.map((m, i) => i === ms.length - 1 && !m.content ? { ...m, content: '⚠ 修复请求失败：' + (e.message || e) } : m));
    } finally { setAiBusy(false); }
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

  const stats = previewResult && previewResult.stats ? previewResult.stats : countOf(activeValue);
  const wordText = (stats.cjk ? stats.cjk + ' 字' : '') + (stats.cjk && stats.words - stats.cjk > 0 ? ' + ' : '') + (stats.words - stats.cjk > 0 ? (stats.words - stats.cjk) + ' words' : '');
  const renderWarnCount = previewResult && previewResult.warnings ? previewResult.warnings.length : 0;
  const issueCount = diagnostics.length + renderWarnCount + (compileResult && compileResult.errors ? compileResult.errors.length : 0);
  const hasEditor = activeTab && activeTab.kind !== 'image';
  const channelCount = channels.length;

  return (
    <>
      <Toolbar
        actions={{
          loadTemplate, openFile: openSingleFile, openFolder, save: saveActive,
          exportTex: () => {
            if (isTexLike) exportTexFile(activeValue, ((activeTab.name || 'paper').replace(/\.(tex|md)$/i, '')) + '.tex');
            else downloadFile(activeTab.name, activeValue, 'text/plain;charset=utf-8');
          },
          exportPdf: exportPdfPrint,
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
                  r.onload = () => insert('\n\\begin{figure}[h]\n\\centering\n\\includegraphics[width=0.7\\textwidth]{' + r.result + '}\n\\caption{图片说明}\n\\label{fig:img}\n\\end{figure}\n');
                  r.readAsDataURL(f);
                };
                inp.click();
                return;
              }
              default: if (SNIPPETS[id]) insert(SNIPPETS[id]);
            }
          }
        }}
        viewMode={viewMode} setViewMode={setViewMode} latexOk={isTexLike || isMd}
        engines={engines} engine={engine} setEngine={setEngine} compiling={compiling} onCompile={doCompile}
        channelCount={channelCount} onOpenChat={() => { setChatOpen(o => !o); setPanelOpen(false); }} onOpenSettings={() => setSettingsOpen(true)}
      />

      <main id="layout" data-mode={viewMode} style={{ '--split': splitPct + '%' }}>
        <div id="sidebar">
          <div className="side-tabs">
            <button className={sideTab === 'files' ? 'on' : ''} title="文件" onClick={() => setSideTab('files')} disabled={!rootDir && !restorePrompt}>📁</button>
            <button className={sideTab === 'outline' ? 'on' : ''} title="大纲" onClick={() => setSideTab('outline')}>☰</button>
            <button className={sideTab === 'issues' ? 'on' : ''} title="问题" onClick={() => setSideTab('issues')}>⚠{issueCount ? <em>{issueCount}</em> : null}</button>
          </div>
          <div className="side-body">
            {sideTab === 'files' && (
              restorePrompt && !rootDir ? (
                <div className="side-pad">
                  <button className="btn sm" onClick={restoreFolder}>🔓 恢复上次文件夹（{restorePrompt.name}）</button>
                </div>
              ) : rootDir ? <FileTree root={rootDir} onOpenFile={openFileTab} onCloseFolder={closeFolder} refreshKey={treeKey} />
                : <div className="side-pad hint">未打开文件夹<br />点顶栏「📂 打开文件夹」</div>
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
            />
          ) : (
            <div className="binary-note">
              <div>🖼 {activeTab.name}</div>
              <div className="hint">图片文件不提供文本编辑，请看右侧预览。</div>
            </div>
          )}
        </section>

        {viewMode === 'split' && <div id="divider" title="拖动调整分栏" onMouseDown={dragDivider}></div>}

        {viewMode !== 'edit' && (
          activeTab && activeTab.kind === 'image' ? (
            <section id="previewPane">
              <div id="previewBar"><span className="pb-title">预览</span></div>
              <div id="previewScroll"><div id="preview"><div id="paper" className="paper image-view" style={{ zoom }}>
                <img src={activeTab.imageUrl} alt={activeTab.name} style={{ maxWidth: '100%' }} />
              </div></div></div>
            </section>
          ) : previewMode === 'pdf' && compileResult && compileResult.ok ? (
            <section id="previewPane">
              <div id="previewBar">
                <span className="pb-title">✅ {compileResult.engine} 编译成功</span>
                <span className="pb-spacer"></span>
                <button className="btn sm" onClick={() => downloadCompiled(compileResult)}>⬇ 下载 PDF</button>
                <button className="btn sm" onClick={() => window.open(compileResult.pdfUrl, '_blank')}>新窗口</button>
                <button className="btn sm" onClick={() => setPreviewMode('rich')}>✕ 关闭</button>
              </div>
              <div className="pdf-host"><iframe src={compileResult.pdfUrl} title="PDF" /></div>
            </section>
          ) : previewMode === 'log' && compileResult ? (
            <section id="previewPane">
              <div id="previewBar">
                <span className="pb-title bad">❌ {compileResult.engine} 编译失败</span>
                <span className="pb-spacer"></span>
                <button className="btn sm" onClick={() => setPreviewMode('rich')}>返回预览</button>
              </div>
              <div id="previewScroll">
                <div className="compile-log">
                  {(compileResult.errors || []).map((e, i) => (
                    <div key={i} className="diag-item error" onClick={() => e.line != null && jumpToLine(e.line)}>
                      <span className="diag-sev">✖</span>
                      <span className="diag-msg">{e.msg}</span>
                      {e.line != null && <span className="diag-line">第 {e.line + 1} 行</span>}
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
              <div id="previewBar"><span className="pb-title">预览</span></div>
              <div id="previewScroll"><div id="preview"><div id="paper" className="paper">
                <div className="code-placeholder">
                  <div className="cp-icon">{infoFor(activeTab ? activeTab.name : '').icon}</div>
                  <div className="cp-name">{activeTab ? activeTab.name : ''}</div>
                  <div className="cp-line">代码/文本文件：直接在左侧编辑即可（Ctrl+S 保存回磁盘）</div>
                  <div className="cp-line hint">行数：{activeValue ? activeValue.split('\n').length : 0} · 大小：{fmtSize(activeValue)}</div>
                  <div className="cp-line hint">切到 .tex / .md 文件即可实时预览与查看大纲</div>
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
        <span>{isTexLike || isMd ? lastRenderMs.toFixed(0) + ' ms' : '文本模式'}</span>
        <span className="sep">·</span>
        <span className={'st-warn' + (issueCount ? ' has' : '')} onClick={() => setSideTab('issues')}>
          {issueCount ? '⚠ ' + issueCount : '✓ 无问题'}
        </span>
        <span className="grow"></span>
        {flashMsg && <span className="st-flash">{flashMsg}</span>}
        <span className="hint">Ctrl+S 保存 · 状态栏点「⚠」看问题</span>
      </footer>

      {viewMode !== 'edit' && isTexLike && cmReady >= 0 && (
        <StylePanel open={panelOpen && !chatOpen} result={latexResult} cm={cmRef.current} selection={selection} setSelection={setSelection} />
      )}

      <ChatPanel
        open={chatOpen}
        onClose={() => setChatOpen(false)}
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
    </>
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

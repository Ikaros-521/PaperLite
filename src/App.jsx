import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from 'codemirror';
import Toolbar from './components/Toolbar.jsx';
import EditorPane from './components/EditorPane.jsx';
import PreviewPane from './components/PreviewPane.jsx';
import StylePanel from './components/StylePanel.jsx';
import FileTree from './components/FileTree.jsx';
import TabsBar from './components/TabsBar.jsx';
import { renderLatex } from './engines/latex.js';
import { renderMarkdown } from './engines/markdown.js';
import { samples } from './engines/samples.js';
import { downloadFile, exportTex as exportTexFile, exportPDF, PRINT_CSS } from './exporter.js';
import { infoFor } from './fileTypes.js';
import * as fs from './fs.js';

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
  if (text !== undefined && text !== null) {
    t.doc = new CodeMirror.Doc(text, modeSpec);
  }
  return t;
}

export default function App() {
  // ---- 多标签状态 ----
  const [tabs, setTabs] = useState(() => {
    let saved = '';
    try { saved = localStorage.getItem(LS_KEY) || ''; } catch (e) { /* ignore */ }
    const text = saved.trim() ? saved : samples.demo;
    return [makeTab({ name: '草稿.tex', path: '(浏览器草稿)', kind: 'draft', text, modeSpec: 'stex', saved: text })];
  });
  const [activeId, setActiveId] = useState(() => 1);
  const [activeValue, setActiveValue] = useState(() => {
    try { const s = localStorage.getItem(LS_KEY); if (s && s.trim()) return s; } catch (e) { /* ignore */ }
    return samples.demo;
  });

  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem(LS_MODE) || 'split'; } catch (e) { return 'split'; }
  });
  const [splitPct, setSplitPct] = useState(52);
  const [zoom, setZoom] = useState(1);
  const [syncScroll, setSyncScroll] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [selection, setSelection] = useState({ did: 0, sel: null });
  const [savedFlash, setSavedFlash] = useState(false);
  const [flashMsg, setFlashMsg] = useState('');
  const [cmReady, setCmReady] = useState(0);
  const [rootDir, setRootDir] = useState(null);
  const [restorePrompt, setRestorePrompt] = useState(null); // 待授权恢复的根句柄
  const [treeKey, setTreeKey] = useState(0);

  const cmRef = useRef(null);
  const ratioRef = useRef({ edit: 0, preview: 0 });
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const activeTab = tabs.filter(t => t.id === activeId)[0] || tabs[0];
  const activeKind = activeTab ? activeTab.kind : 'tex';
  const isTexLike = activeKind === 'tex' || activeKind === 'draft';
  const isMd = activeKind === 'md';

  const flash = useCallback((msg) => {
    setFlashMsg(msg);
    setTimeout(() => setFlashMsg(''), 1400);
  }, []);

  // ---- 启动时恢复上次文件夹（需重新授权则提示） ----
  useEffect(() => {
    (async () => {
      const h = await fs.loadRootHandle();
      if (!h) return;
      const perm = await fs.queryPermission(h, 'readwrite');
      if (perm === 'granted') setRootDir(h);
      else setRestorePrompt(h);
    })();
  }, []);

  // ---- 文件夹操作 ----
  const openFolder = async () => {
    try {
      const h = await fs.pickDirectory();
      setRootDir(h);
      setRestorePrompt(null);
      await fs.saveRootHandle(h);
      flash('已打开文件夹：' + h.name);
    } catch (e) {
      if (e && e.name !== 'AbortError') alert('打开文件夹失败：' + (e.message || e));
    }
  };
  const closeFolder = async () => {
    setRootDir(null);
    setRestorePrompt(null);
    await fs.clearRootHandle();
  };
  const restoreFolder = async () => {
    if (!restorePrompt) return;
    const perm = await fs.requestPermission(restorePrompt, 'readwrite');
    if (perm === 'granted') { setRootDir(restorePrompt); setRestorePrompt(null); }
  };

  // ---- 打开文件为标签 ----
  const openFileTab = useCallback(async (fileHandle, path, parentDir) => {
    const name = fileHandle.name || (path ? path.split('/').pop() : '未命名');
    const info = infoFor(name);
    // 已打开则直接激活
    const exist = tabsRef.current.filter(t => t.handle === fileHandle)[0];
    if (exist) { setActiveId(exist.id); return exist; }
    try {
      if (info.kind === 'image') {
        const url = await fs.fileBlobUrl(fileHandle);
        const t = makeTab({ name, path, kind: 'image', handle: fileHandle, imageUrl: url });
        setTabs(ts => ts.concat([t]));
        setActiveId(t.id);
        setActiveValue('');
        return t;
      }
      const text = await fs.readFileText(fileHandle);
      const t = makeTab({ name, path, kind: info.kind, handle: fileHandle, parentDir, text, modeSpec: info.mode, saved: text });
      setTabs(ts => ts.concat([t]));
      setActiveId(t.id);
      setActiveValue(text);
      return t;
    } catch (e) {
      alert('无法打开 ' + name + '：' + (e.message || e));
      return null;
    }
  }, []);

  // 注入式标签（测试/嵌入用）
  useEffect(() => {
    window.__plInject = (name, content) => {
      const info = infoFor(name);
      const t = makeTab({ name, path: '(内存) ' + name, kind: info.kind, text: content, modeSpec: info.mode, saved: content });
      setTabs(ts => ts.concat([t]));
      setActiveId(t.id);
      setActiveValue(content);
      return t.id;
    };
    window.__plTabs = () => tabsRef.current.map(t => ({ id: t.id, name: t.name, kind: t.kind, dirty: t.dirty }));
  }, []);

  // ---- 编辑器联动 ----
  const onDocChange = useCallback((doc, value) => {
    setActiveValue(value);
    setTabs(ts => ts.map(t => t.doc === doc ? { ...t, dirty: value !== t.saved } : t));
  }, []);

  // 切换标签时同步 activeValue
  useEffect(() => {
    if (activeTab && activeTab.doc) {
      const v = activeTab.doc.getValue();
      setActiveValue(prev => (prev === v ? prev : v));
    } else if (activeTab && activeTab.kind === 'image') {
      setActiveValue('');
    }
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
  const insert = (text) => {
    const c = cm(); if (!c) return;
    c.replaceSelection(text, 'around');
    c.focus();
  };
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
    const useDraft = t && (t.kind === 'draft');
    if (!window.confirm(useDraft ? '载入模板将替换当前草稿（可先导出 .tex 备份）。继续？' : '模板将载入到新的草稿标签。继续？')) return;
    const text = samples[key] || '';
    if (useDraft && t.doc) {
      t.doc.setValue(text);
      setActiveValue(text);
      setTabs(ts => ts.map(x => x.id === t.id ? { ...x, saved: text, dirty: false } : x));
    } else {
      const nt = makeTab({ name: '草稿.tex', path: '(浏览器草稿)', kind: 'draft', text, modeSpec: 'stex', saved: text });
      setTabs(ts => ts.concat([nt]));
      setActiveId(nt.id);
      setActiveValue(text);
    }
  };

  // ---- 导出 ----
  const docName = () => (activeTab && activeTab.name) ? activeTab.name.replace(/[\\{}$%]/g, '').replace(/\s+/g, '_').slice(0, 40) + '.tex' : 'paper.tex';

  const exportPdf = () => {
    const paper = document.getElementById('paper');
    if (!paper) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = paper.innerHTML;
    tmp.querySelectorAll('.dgrid-tools').forEach(el => el.remove());
    tmp.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
    exportPDF(tmp.innerHTML, (isTexLike && latexResult) ? latexResult.meta : {});
  };

  const exportTex = () => {
    if (isTexLike || isMd) exportTexDownload();
    else downloadFile(activeTab.name, activeValue, 'text/plain;charset=utf-8');
  };
  const exportTexDownload = () => {
    const name = (activeTab.name || 'paper').replace(/\.(tex|md)$/i, '');
    exportTexFile(activeValue, name + '.tex');
  };

  const tool = (id) => {
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
  };

  // ---- 预览渲染 ----
  const deferred = useDeferredValue(activeValue);
  const latexResult = useMemo(() => {
    if (!isTexLike) return null;
    const t0 = performance.now();
    let r;
    try { r = renderLatex(deferred, {}); }
    catch (e) {
      r = { html: '<div class="render-error">渲染器异常：' + String(e && e.message || e) + '</div>', meta: {}, warnings: [String(e)], diagrams: [], stats: { cjk: 0, words: 0 } };
    }
    lastRenderMs = performance.now() - t0;
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferred, isTexLike]);

  const mdHtml = useMemo(() => {
    if (!isMd) return null;
    const t0 = performance.now();
    let r;
    try { r = renderMarkdown(deferred); }
    catch (e) { r = '<div class="render-error">Markdown 渲染异常：' + String(e && e.message || e) + '</div>'; }
    lastRenderMs = performance.now() - t0;
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferred, isMd]);

  const previewResult = isTexLike ? latexResult : isMd ? { html: mdHtml, isMd: true, meta: { ctex: true }, warnings: [], diagrams: [], stats: countOf(deferred) } : null;

  // ---- 同步滚动 ----
  const handleScrollRatio = useCallback((ratio, from) => {
    ratioRef.current[from] = ratio;
    if (!syncScroll) return;
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
      setSplitPct(Math.min(80, Math.max(20, (ev.clientX - rect.left) / rect.width * 100)));
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

  const stats = previewResult && previewResult.stats ? previewResult.stats : countOf(activeValue);
  const wordText = (stats.cjk ? stats.cjk + ' 字' : '') + (stats.cjk && stats.words - stats.cjk > 0 ? ' + ' : '') + (stats.words - stats.cjk > 0 ? (stats.words - stats.cjk) + ' words' : '');
  const warnCount = previewResult && previewResult.warnings ? previewResult.warnings.length : 0;
  const showWorkspace = !!rootDir || !!restorePrompt;
  const hasEditor = activeTab && activeTab.kind !== 'image';

  return (
    <>
      <Toolbar
        actions={{ loadTemplate, openFile: openSingleFile, openFolder, save: saveActive, exportTex, exportPdf, tool }}
        viewMode={viewMode}
        setViewMode={setViewMode}
        latexOk={isTexLike || isMd}
      />

      <main id="layout" data-mode={viewMode} data-ws={showWorkspace ? 'on' : 'off'} style={{ '--split': splitPct + '%' }}>
        {showWorkspace && (
          restorePrompt && !rootDir
            ? (
              <div id="workspace" className="restore">
                <button className="btn sm" onClick={restoreFolder}>🔓 恢复上次文件夹（{restorePrompt.name}）</button>
                <button className="btn sm" onClick={() => setRestorePrompt(null)}>✕ 忽略</button>
              </div>
            )
            : <FileTree root={rootDir} onOpenFile={openFileTab} onCloseFolder={closeFolder} refreshKey={treeKey} />
        )}

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
            <div id="editorPane" className="binary-note">
              <div>🖼 {activeTab.name}</div>
              <div className="hint">图片文件不提供文本编辑，请看右侧预览。</div>
            </div>
          )}
        </section>

        {viewMode === 'split' && <div id="divider" title="拖动调整分栏" onMouseDown={dragDivider}></div>}

        {viewMode !== 'edit' && (
          activeTab && activeTab.kind === 'image' ? (
            <section id="previewPane">
              <div id="previewBar"><span className="pb-title">预览</span><span className="pb-spacer"></span>
                <span className="pb-zoom">
                  <button className="btn sm" onClick={() => setZoomClamped(-0.1)}>−</button>
                  <span>{Math.round(zoom * 100)}%</span>
                  <button className="btn sm" onClick={() => setZoomClamped(0.1)}>＋</button>
                </span>
              </div>
              <div id="previewScroll"><div id="preview"><div id="paper" className="paper image-view" style={{ zoom }}>
                <img src={activeTab.imageUrl} alt={activeTab.name} style={{ maxWidth: '100%' }} />
              </div></div></div>
            </section>
          ) : previewResult ? (
            <PreviewPane
              result={previewResult}
              selection={selection}
              onSelectNode={(did, sidx) => { setSelection({ did, sel: { type: 'node', sidx } }); setPanelOpen(true); }}
              onScrollRatio={handleScrollRatio}
              zoom={zoom}
              onZoom={setZoomClamped}
              panelOpen={panelOpen}
              onTogglePanel={() => setPanelOpen(o => !o)}
              syncScroll={syncScroll}
              onSyncToggle={setSyncScroll}
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
                  <div className="cp-line hint">切到 .tex / .md 文件即可实时预览</div>
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
        <span
          className={'st-warn' + (warnCount ? ' has' : '')}
          onClick={() => warnCount && previewResult && previewResult.warnings && alert(warnCount + ' 条渲染提示：\n\n· ' + previewResult.warnings.slice(0, 25).join('\n· '))}
        >{warnCount ? '⚠ ' + warnCount : '✓ 无警告'}</span>
        <span className="grow"></span>
        {flashMsg && <span className="st-flash">{flashMsg}</span>}
        <span className="hint">Ctrl+S 保存 · Ctrl+B/I 加粗斜体</span>
      </footer>

      {viewMode !== 'edit' && cmReady >= 0 && isTexLike && (
        <StylePanel open={panelOpen} result={latexResult} cm={cmRef.current} selection={selection} setSelection={setSelection} />
      )}
    </>
  );
}

function countOf(s) {
  const str = String(s || '');
  return { cjk: (str.match(/[\u4e00-\u9fff]/g) || []).length, words: (str.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9][A-Za-z0-9'’\-]*/g) || []).length + (str.match(/[\u4e00-\u9fff]/g) || []).length };
}

function fmtSize(s) {
  const bytes = new Blob([String(s || '')]).size;
  return bytes < 1024 ? bytes + ' B' : (bytes / 1024).toFixed(1) + ' KB';
}

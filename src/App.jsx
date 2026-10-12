import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import Toolbar from './components/Toolbar.jsx';
import EditorPane from './components/EditorPane.jsx';
import PreviewPane from './components/PreviewPane.jsx';
import StylePanel from './components/StylePanel.jsx';
import { renderLatex } from './engines/latex.js';
import { samples } from './engines/samples.js';
import { downloadFile, exportTex, exportPDF, PRINT_CSS } from './exporter.js';

const LS_KEY = 'paperlite.doc.v2';
const LS_MODE = 'paperlite.viewmode.v2';
let lastRenderMs = 0; // 渲染耗时（渲染期间可写的旁路变量）

const SNIPPETS = {
  tEq: '\n\\begin{equation}\n  \n\\end{equation}\n',
  tList: '\n\\begin{itemize}\n  \\item \n\\end{itemize}\n',
  tEnum: '\n\\begin{enumerate}\n  \\item \n\\end{enumerate}\n',
  tTable: '\n\\begin{table}[h]\n\\centering\n\\begin{tabular}{lcc}\n\\toprule\n列一 & 列二 & 列三 \\\\\n\\midrule\nA & B & C \\\\\n\\bottomrule\n\\end{tabular}\n\\caption{表标题}\n\\label{tab:mytab}\n\\end{table}\n',
  tFlow: '\n\\begin{tikzpicture}[node distance=1.5cm]\n  \\node[rectangle, rounded corners=6pt, fill=blue!15, draw=blue!60!black] (a) {开始};\n  \\node[rectangle, rounded corners=6pt, fill=teal!12, draw=teal!70!black, right of=a, node distance=3cm] (b) {处理步骤};\n  \\node[diamond, fill=yellow!25, draw=orange!80!black, right of=b, node distance=3cm] (c) {判断?};\n  \\node[rectangle, rounded corners=10pt, fill=green!12, draw=green!50!black, below of=b, node distance=2cm] (d) {结束};\n  \\draw[-stealth, thick] (a) -- (b);\n  \\draw[-stealth, thick] (b) -- (c);\n  \\draw[-stealth, thick] (c) -- node[above, font=\\\\small]{是} (d);\n\\end{tikzpicture}\n',
  tMermaid: '\n\\begin{mermaid}\nflowchart LR\n  A[开始] --> B{条件?}\n  B -- 是 --> C[处理]\n  B -- 否 --> D[结束]\n\\end{mermaid}\n',
  tBib: '\\cite{key}'
};

export default function App() {
  const [source, setSource] = useState(() => {
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved && saved.trim()) return saved;
    } catch (e) { /* ignore */ }
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
  const [cmReady, setCmReady] = useState(0);

  const cmRef = useRef(null);
  const ratioRef = useRef({ edit: 0, preview: 0 });

  // 低优先级预览（输入不卡顿）
  const deferred = useDeferredValue(source);
  const result = useMemo(() => {
    const t0 = performance.now();
    let r;
    try {
      r = renderLatex(deferred, {});
    } catch (e) {
      r = { html: '<div class="render-error">渲染器异常：' + String(e && e.message || e) + '</div>', meta: {}, warnings: [String(e)], diagrams: [], stats: { cjk: 0, words: 0 } };
    }
    lastRenderMs = performance.now() - t0;
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferred]);

  // 自动保存
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(LS_KEY, source); } catch (e) { /* ignore */ }
    }, 800);
    return () => clearTimeout(t);
  }, [source]);

  useEffect(() => { try { localStorage.setItem(LS_MODE, viewMode); } catch (e) { /* ignore */ } }, [viewMode]);

  const flashSaved = useCallback(() => {
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 900);
  }, []);

  // ---------- 编辑器辅助 ----------
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

  // ---------- 文件 ----------
  const openFile = (f) => {
    if (!f) return;
    if (/\.tex$|\.txt$|\.latex$/i.test(f.name)) {
      const r = new FileReader();
      r.onload = () => {
        const c = cm();
        if (c) c.setValue(String(r.result));
        else setSource(String(r.result));
      };
      r.readAsText(f, 'utf-8');
    } else if (/^image\//.test(f.type)) {
      const r = new FileReader();
      r.onload = () => insert('\n\\begin{figure}[h]\n\\centering\n\\includegraphics[width=0.7\\textwidth]{' + r.result + '}\n\\caption{图片说明}\n\\label{fig:img}\n\\end{figure}\n');
      r.readAsDataURL(f);
    } else alert('暂支持 .tex / .txt / 图片文件');
  };

  const loadTemplate = (key) => {
    if (!window.confirm('载入模板将替换当前内容（可先导出 .tex 备份）。继续？')) return;
    const c = cm();
    if (c) c.setValue(samples[key] || '');
    else setSource(samples[key] || '');
  };

  // ---------- 导出 ----------
  const docName = () => {
    const t = result && result.meta && result.meta.title ? result.meta.title.replace(/[\\{}$%]/g, '').replace(/\s+/g, '_').slice(0, 40) : '';
    return (t || 'paper') + '.tex';
  };

  const exportPdf = () => {
    const paper = document.getElementById('paper');
    if (!paper) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = paper.innerHTML;
    tmp.querySelectorAll('.dgrid-tools').forEach(el => el.remove());
    tmp.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
    exportPDF(tmp.innerHTML, result.meta);
  };

  const exportHtml = () => {
    const paper = document.getElementById('paper');
    if (!paper) return;
    const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
      .map(l => '<link rel="stylesheet" href="' + new URL(l.getAttribute('href'), location.href).href + '">').join('');
    downloadFile(docName().replace(/\.tex$/, '') + '.html',
      '<!DOCTYPE html><html><head><meta charset="utf-8">' + styles + '<style>' + PRINT_CSS + '</style></head><body class="print-body"><div class="paper">' + paper.innerHTML + '</div></body></html>',
      'text/html;charset=utf-8');
  };

  const tool = (id) => {
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
        inp.onchange = () => openFile(inp.files && inp.files[0]);
        inp.click();
        return;
      }
      default: if (SNIPPETS[id]) insert(SNIPPETS[id]);
    }
  };

  // ---------- 同步滚动（双向比例映射、防回声） ----------
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

  // ---------- 快捷键 ----------
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); flashSaved(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); wrap('\\textbf{', '}'); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'i') { e.preventDefault(); wrap('\\emph{', '}'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---------- 分栏拖拽 ----------
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

  const stats = (result && result.stats) || { cjk: 0, words: 0 };
  const wordText = (stats.cjk ? stats.cjk + ' 字' : '') + (stats.cjk && stats.words - stats.cjk > 0 ? ' + ' : '') + (stats.words - stats.cjk > 0 ? (stats.words - stats.cjk) + ' words' : '');
  const warnCount = (result.warnings || []).length;

  return (
    <>
      <Toolbar
        actions={{
          loadTemplate, openFile,
          exportTex: () => exportTex(source, docName()),
          exportHtml, exportPdf, tool
        }}
        viewMode={viewMode}
        setViewMode={setViewMode}
      />

      <main id="layout" data-mode={viewMode} style={{ '--split': splitPct + '%' }}>
        {viewMode !== 'preview' && (
          <EditorPane
            initial={source}
            onChange={setSource}
            onInit={(c) => { cmRef.current = c; setCmReady(x => x + 1); }}
            onScrollRatio={handleScrollRatio}
            onSave={flashSaved}
          />
        )}
        {viewMode === 'split' && <div id="divider" title="拖动调整分栏" onMouseDown={dragDivider}></div>}
        {viewMode !== 'edit' && (
          <PreviewPane
            result={result}
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
        )}
      </main>

      <footer id="statusbar">
        <span>{wordText}</span>
        <span className="sep">·</span>
        <span>{lastRenderMs.toFixed(0)} ms</span>
        <span className="sep">·</span>
        <span
          className={'st-warn' + (warnCount ? ' has' : '')}
          onClick={() => warnCount && alert(warnCount + ' 条渲染提示：\n\n· ' + result.warnings.slice(0, 25).join('\n· '))}
        >{warnCount ? '⚠ ' + warnCount : '✓ 无警告'}</span>
        <span className="grow"></span>
        <span className={'st-save-flash' + (savedFlash ? ' on' : '')}>已自动保存</span>
        <span className="hint">Ctrl+S 保存 · Ctrl+B/I 加粗斜体 · 改图样式请点预览中的图形</span>
      </footer>

      {viewMode !== 'edit' && cmReady >= 0 && (
        <StylePanel
          open={panelOpen}
          result={result}
          cm={cmRef.current}
          selection={selection}
          setSelection={setSelection}
        />
      )}
    </>
  );
}

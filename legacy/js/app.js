/* PaperLite · 主程序：编辑器 ↔ 预览 ↔ 样式面板 ↔ 导出 全部联动 */
(function (global) {
'use strict';

var PL = global.PaperLite = global.PaperLite || {};
var ed, lastResult = null, renderTimer = null, saveTimer = null;
var mermaidReady = false, mermaidLoading = false, mermaidSeq = 0;
var syncScroll = true;
var LS_KEY = 'paperlite.doc.v1';
var LS_MODE = 'paperlite.viewmode.v1';

var $ = function (id) { return document.getElementById(id); };

// ---------------- 启动 ----------------
function start() {
  if (!PL.latex || !PL.editor) { setTimeout(start, 60); return; }

  ed = PL.editor.init($('editorHost'), scheduleRender);
  ed.onSave = saveNow;

  // 恢复文档或载入模板
  var saved = null;
  try { saved = localStorage.getItem(LS_KEY); } catch (e) {}
  ed.setValue(saved && saved.trim() ? saved : PL.samples.demo);

  PL.stylepanel.init($('stylePanel'), function () { return ed; }, scheduleRender);

  bindToolbar();
  bindLayout();
  bindPreviewEvents();
  setViewMode(localStorage.getItem(LS_MODE) || 'split');

  if (!global.katex) setBanner('KaTeX 公式库未加载（离线缺文件？），公式将显示为红色原文。');
  renderNow();
}

// ---------------- 渲染循环 ----------------
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderNow, 300);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 800);
}

function saveNow() {
  try { localStorage.setItem(LS_KEY, ed.getValue()); flashStatus('已自动保存'); } catch (e) {}
}

function renderNow() {
  var t0 = performance.now();
  var src = ed.getValue();
  var res;
  try {
    res = PL.latex.render(src, {});
  } catch (e) {
    $('preview').innerHTML = '<div class="render-error">渲染器异常：' + esc(String(e && e.message || e)) + '</div>';
    return;
  }
  lastResult = res;
  var paper = $('paper');
  paper.className = 'paper' + (res.meta.twocolumn ? ' twocolumn' : '') + (res.meta.ctex ? ' ctex' : '');
  paper.innerHTML = res.html;

  processMermaid();
  addDiagramTools();
  PL.stylepanel.refresh(res);
  updateStatus(res, performance.now() - t0);
}

function processMermaid() {
  var blocks = $('paper').querySelectorAll('.mermaid-block[data-code]');
  if (!blocks.length) return;
  ensureMermaid(function (ok) {
    if (!ok) {
      Array.prototype.forEach.call(blocks, function (b) {
        b.innerHTML = '<div class="render-error">Mermaid 未加载，无法渲染此图</div>';
      });
      return;
    }
    Array.prototype.forEach.call(blocks, function (b) {
      var code = decodeURIComponent(b.getAttribute('data-code'));
      var id = 'mmd-' + (++mermaidSeq);
      global.mermaid.render(id, code).then(function (r) {
        b.innerHTML = r.svg;
        var svg = b.querySelector('svg');
        if (svg) { svg.style.maxWidth = '100%'; svg.removeAttribute('height'); }
      }).catch(function (err) {
        b.innerHTML = '<div class="render-error">Mermaid 语法错误：' + esc(String(err && err.message || err).slice(0, 160)) + '</div>';
      });
    });
  });
}

function ensureMermaid(cb) {
  if (mermaidReady) return cb(true);
  if (mermaidLoading) { setTimeout(function () { ensureMermaid(cb); }, 300); return; }
  mermaidLoading = true;
  loadScriptChain([
    'vendor/mermaid/mermaid.min.js',
    'https://registry.npmmirror.com/mermaid/10.9.3/files/dist/mermaid.min.js'
  ], function (ok) {
    if (ok && global.mermaid) {
      // loose 会放行 click 里的 javascript: 与 HTML 标签；strict + DOMPurify 才挡得住
      // 从网上下载的 .tex/.md 里的图源码。secure 补上 dompurifyConfig/htmlLabels：
      // 文档自带的 %%{init}%% 指令不该能改自己的消毒器配置
      global.mermaid.initialize({
        startOnLoad: false, securityLevel: 'strict', htmlLabels: false,
        fontFamily: 'Georgia, "Noto Serif SC", serif',
        secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'dompurifyConfig', 'htmlLabels'],
      });
      mermaidReady = true;
    }
    mermaidLoading = false;
    cb(!!(ok && global.mermaid));
  });
}

function loadScriptChain(urls, cb) {
  if (!urls.length) return cb(false);
  var s = document.createElement('script');
  s.src = urls[0];
  s.onload = function () { cb(true); };
  s.onerror = function () { s.remove(); loadScriptChain(urls.slice(1), cb); };
  document.head.appendChild(s);
}

// 每个图块上加浮动工具条（导出 SVG/PNG）
function addDiagramTools() {
  Array.prototype.forEach.call($('paper').querySelectorAll('.diagram'), function (d) {
    var bar = document.createElement('div');
    bar.className = 'dgrid-tools';
    var mk = function (label, fn) {
      var b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', function (e) { e.stopPropagation(); var svg = d.querySelector('svg'); if (svg) fn(svg, d); });
      return b;
    };
    bar.appendChild(mk('SVG', function (svg) { PL.exporter.exportSvg(svg, 'figure.svg'); }));
    bar.appendChild(mk('PNG', function (svg) { PL.exporter.exportPng(svg, 'figure.png', 2); }));
    d.appendChild(bar);
  });
}

function updateStatus(res, ms) {
  var s = res.stats;
  $('stWords').textContent = (s.cjk ? s.cjk + ' 字' : '') + (s.cjk && s.words - s.cjk > 0 ? ' + ' : '') + (s.words - s.cjk > 0 ? (s.words - s.cjk) + ' words' : '');
  $('stRender').textContent = ms.toFixed(0) + ' ms';
  var wn = res.warnings.length;
  var wb = $('stWarn');
  wb.textContent = wn ? '⚠ ' + wn : '✓ 无警告';
  wb.className = 'st-warn' + (wn ? ' has' : '');
  wb.onclick = function () {
    if (!wn) return;
    alert(wn + ' 条渲染提示：\n\n· ' + res.warnings.slice(0, 25).join('\n· '));
  };
}

function setBanner(msg) {
  var b = $('banner');
  b.textContent = msg; b.style.display = 'block';
}

// ---------------- 预览事件（点击选节点 / 图片缺失占位） ----------------
function bindPreviewEvents() {
  $('preview').addEventListener('click', function (e) {
    var g = e.target.closest ? e.target.closest('.tk-node, .tk-label') : null;
    if (g) {
      var sidx = g.getAttribute('data-sidx');
      var host = g.closest('.diagram');
      var did = host ? +(host.getAttribute('data-did') || 0) : 0;
      if (sidx !== null) PL.stylepanel.selectFromPreview(did, +sidx);
      if (!$('stylePanel').classList.contains('open')) toggleStylePanel(true);
      return;
    }
  });
  // 编辑器 ↔ 预览 同步滚动（比例映射）
  $('previewScroll').addEventListener('scroll', function () { if (!syncScroll) return; syncTo('preview'); });
  if (ed.kind === 'cm') {
    ed.cm.on('scroll', function () { if (syncScroll) syncTo('edit'); });
  } else {
    ed.ta.addEventListener('scroll', function () { if (syncScroll) syncTo('edit'); });
  }
  function syncTo(from) {
    var ps = $('previewScroll'), es = ed.kind === 'cm' ? ed.cm.getScrollerElement() : ed.ta;
    var src = from === 'edit' ? es : ps;
    var dst = from === 'edit' ? ps : es;
    var ratio = src.scrollTop / Math.max(1, src.scrollHeight - src.clientHeight);
    dst.scrollTop = ratio * (dst.scrollHeight - dst.clientHeight);
  }
}

// ---------------- 工具栏 ----------------
function bindToolbar() {
  var B = function (id, fn) { var el = $(id); if (el) el.addEventListener('click', fn); };

  B('btnPdf', function () {
    if (!lastResult) renderNow();
    // 剔除交互元素（悬浮导出按钮、选中高亮）后再打印
    var tmp = document.createElement('div');
    tmp.innerHTML = $('paper').innerHTML;
    Array.prototype.forEach.call(tmp.querySelectorAll('.dgrid-tools'), function (el) { el.remove(); });
    Array.prototype.forEach.call(tmp.querySelectorAll('.selected'), function (el) { el.classList.remove('selected'); });
    PL.exporter.exportPDF(tmp.innerHTML, lastResult.meta);
  });
  B('btnTex', function () { PL.exporter.exportTex(ed.getValue(), docName()); });
  B('btnHtml', function () {
    PL.exporter.downloadFile(docName().replace(/\.tex$/, '') + '.html',
      '<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="' + location.href.replace(/[^/]*$/, '') + 'vendor/katex/katex.min.css"><style>' + PL.exporter.PRINT_CSS + '</style></head><body class="print-body"><div class="paper">' + $('paper').innerHTML + '</div></body></html>',
      'text/html;charset=utf-8');
  });

  // 模板
  Array.prototype.forEach.call(document.querySelectorAll('[data-tpl]'), function (el) {
    el.addEventListener('click', function () {
      if (!confirm('载入模板将替换当前内容（可先导出 .tex 备份）。继续？')) return;
      ed.setValue(PL.samples[el.getAttribute('data-tpl')] || '');
      renderNow(); saveNow();
      $('tplMenu').classList.remove('open');
    });
  });
  B('tplDropdown', function () { $('tplMenu').classList.toggle('open'); });
  document.addEventListener('click', function (e) {
    if (!e.target.closest || !e.target.closest('#tplDropdown,#tplMenu')) $('tplMenu').classList.remove('open');
  });

  B('btnOpen', function () { $('fileInput').click(); });
  $('fileInput').addEventListener('change', function (e) {
    var f = e.target.files[0];
    if (f) readFile(f);
    e.target.value = '';
  });
  // 拖拽：.tex 载入 / 图片转 base64 插入
  var drop = $('editorPane');
  drop.addEventListener('dragover', function (e) { e.preventDefault(); });
  drop.addEventListener('drop', function (e) {
    e.preventDefault();
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readFile(f);
  });

  // 编辑插入类
  B('tSec', function () { insertLineCmd('\\section{', '}'); });
  B('tSub', function () { insertLineCmd('\\subsection{', '}'); });
  B('tB', function () { ed.wrap('\\textbf{', '}'); scheduleRender(); });
  B('tI', function () { ed.wrap('\\emph{', '}'); scheduleRender(); });
  B('tU', function () { ed.wrap('\\underline{', '}'); scheduleRender(); });
  B('tTt', function () { ed.wrap('\\texttt{', '}'); scheduleRender(); });
  B('tMath', function () { ed.wrap('$', '$'); scheduleRender(); });
  B('tEq', function () { ed.insert('\n\\begin{equation}\n  \n\\end{equation}\n'); scheduleRender(); });
  B('tList', function () { ed.insert('\n\\begin{itemize}\n  \\item \n\\end{itemize}\n'); scheduleRender(); });
  B('tEnum', function () { ed.insert('\n\\begin{enumerate}\n  \\item \n\\end{enumerate}\n'); scheduleRender(); });
  B('tTable', function () {
    ed.insert('\n\\begin{table}[h]\n\\centering\n\\begin{tabular}{lcc}\n\\toprule\n列一 & 列二 & 列三 \\\\\n\\midrule\nA & B & C \\\\\n\\bottomrule\n\\end{tabular}\n\\caption{表标题}\n\\label{tab:mytab}\n\\end{table}\n');
    scheduleRender();
  });
  B('tImg', function () {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = function () {
      var f = inp.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        ed.insert('\\includegraphics[width=0.7\\textwidth]{' + r.result + '}');
        scheduleRender();
      };
      r.readAsDataURL(f);
    };
    inp.click();
  });
  B('tFlow', function () {
    ed.insert('\n\\begin{tikzpicture}[node distance=1.5cm]\n  \\node[rectangle, rounded corners=6pt, fill=blue!15, draw=blue!60!black] (a) {开始};\n  \\node[rectangle, rounded corners=6pt, fill=teal!12, draw=teal!70!black, right of=a, node distance=3cm] (b) {处理步骤};\n  \\node[diamond, fill=yellow!25, draw=orange!80!black, right of=b, node distance=3cm] (c) {判断?};\n  \\node[rectangle, rounded corners=10pt, fill=green!12, draw=green!50!black, below of=b, node distance=2cm] (d) {结束};\n  \\draw[-stealth, thick] (a) -- (b);\n  \\draw[-stealth, thick] (b) -- (c);\n  \\draw[-stealth, thick] (c) -- node[above, font=\\\\small]{是} (d);\n\\end{tikzpicture}\n');
    scheduleRender();
  });
  B('tMermaid', function () {
    ed.insert('\n\\begin{mermaid}\nflowchart LR\n  A[开始] --> B{条件?}\n  B -- 是 --> C[处理]\n  B -- 否 --> D[结束]\n\\end{mermaid}\n');
    scheduleRender();
  });
  B('tBib', function () { ed.insert('\\cite{key}'); scheduleRender(); });
  B('tFn', function () { ed.wrap('\\footnote{', '}'); scheduleRender(); });

  // 视图与缩放
  Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (el) {
    el.addEventListener('click', function () { setViewMode(el.getAttribute('data-view')); });
  });
  B('btnPanel', function () { toggleStylePanel(); });
  B('zoomIn', function () { zoomBy(0.1); });
  B('zoomOut', function () { zoomBy(-0.1); });
  B('zoomFit', function () { setZoom(1); });
  B('btnSync', function () {
    syncScroll = !syncScroll;
    $('btnSync').classList.toggle('on', syncScroll);
  });
  B('btnRender', renderNow);
}

function insertLineCmd(pre, post) {
  if (ed.kind === 'cm') {
    var c = ed.cm, cur = c.getCursor();
    var line = c.getLine(cur.line) || '';
    var indent = (line.match(/^\s*/) || [''])[0];
    var sel = c.getSelection() || '';
    if (sel) { c.replaceSelection(pre + sel + post); }
    else {
      c.replaceRange(indent + pre + post, { line: cur.line, ch: 0 }, { line: cur.line, ch: line.length });
      c.setCursor({ line: cur.line, ch: (indent + pre).length });
    }
    c.focus();
  } else ed.insert(pre + post);
  scheduleRender();
}

function readFile(f) {
  if (/\.tex$|\.txt$|\.latex$/i.test(f.name)) {
    var r = new FileReader();
    r.onload = function () { ed.setValue(String(r.result)); renderNow(); saveNow(); };
    r.readAsText(f, 'utf-8');
  } else if (/^image\//.test(f.type)) {
    var r2 = new FileReader();
    r2.onload = function () {
      ed.insert('\n\\begin{figure}[h]\n\\centering\n\\includegraphics[width=0.7\\textwidth]{' + r2.result + '}\n\\caption{图片说明}\n\\label{fig:img}\n\\end{figure}\n');
      scheduleRender();
    };
    r2.readAsDataURL(f);
  } else alert('暂支持 .tex / .txt / 图片文件');
}

function docName() {
  var t = lastResult && lastResult.meta && lastResult.meta.title ? lastResult.meta.title.replace(/[\\{}$%]/g, '').replace(/\s+/g, '_').slice(0, 40) : '';
  return (t || 'paper') + '.tex';
}

// ---------------- 布局 ----------------
function setViewMode(mode) {
  var layout = $('layout');
  layout.setAttribute('data-mode', mode);
  Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (el) {
    el.classList.toggle('on', el.getAttribute('data-view') === mode);
  });
  try { localStorage.setItem(LS_MODE, mode); } catch (e) {}
  if (ed.kind === 'cm') setTimeout(function () { ed.cm.refresh(); }, 30);
}

function toggleStylePanel(force) {
  var p = $('stylePanel');
  p.classList.toggle('open', force === undefined ? !p.classList.contains('open') : force);
  $('btnPanel').classList.toggle('on', p.classList.contains('open'));
}

var zoom = 1;
function setZoom(z) {
  zoom = Math.min(1.6, Math.max(0.5, z));
  $('paper').style.zoom = zoom;
  $('zoomVal').textContent = Math.round(zoom * 100) + '%';
}
function zoomBy(d) { setZoom(zoom + d); }

function bindLayout() {
  setZoom(1);
  var div = $('divider'), dragging = false;
  div.addEventListener('mousedown', function (e) {
    dragging = true;
    document.body.classList.add('dragging');
    e.preventDefault();
  });
  document.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    var main = $('layout').getBoundingClientRect();
    var r = Math.min(80, Math.max(20, (e.clientX - main.left) / main.width * 100));
    $('layout').style.setProperty('--split', r + '%');
  });
  document.addEventListener('mouseup', function () {
    dragging = false;
    document.body.classList.remove('dragging');
    if (ed.kind === 'cm') ed.cm.refresh();
  });
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveNow(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); renderNow(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); ed.wrap('\\textbf{', '}'); scheduleRender(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'i') { e.preventDefault(); ed.wrap('\\emph{', '}'); scheduleRender(); }
  });
  window.addEventListener('resize', function () { if (ed.kind === 'cm') ed.cm.refresh(); });
}

function flashStatus(msg) {
  var el = $('stSaved');
  el.textContent = msg;
  el.classList.add('flash');
  setTimeout(function () { el.classList.remove('flash'); }, 900);
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

PL.app = { start: start };

})(typeof window !== 'undefined' ? window : globalThis);

/* PaperLite · 图样式可视化编辑面板
 *
 * 与预览中的 TikZ 图双向联动：
 *  - 点击图中的节点 / 面板中的样式 → 展示可编辑属性
 *  - 修改填充色/边框/文字/线宽/虚线/圆角/形状/字号 → 精确写回 LaTeX 源码并即时重渲染
 * 回写依据 tikz.js 记录的「原文档绝对偏移」（注释被等长抹除，偏移恒成立）。
 */
(function (global) {
'use strict';

var TIKZ, CM_API, RERENDER, LAST = null;
var state = { did: 0, sel: null };  // sel: {type:'node'|'style', key, sidx}
var rootEl = null;

var FONT_NAMES = { 8: '\\tiny', 9: '\\scriptsize', 10: '\\footnotesize', 11: '\\small', 13: '\\normalsize', 16: '\\large', 19: '\\Large', 22: '\\LARGE', 25: '\\huge', 29: '\\Huge' };
var DASH_KEYS = ['dashed', 'densely dashed', 'loosely dashed', 'dotted', 'densely dotted', 'loosely dotted'];
var LW_KEYS = ['ultra thin', 'very thin', 'thin', 'semithick', 'thick', 'very thick', 'ultra thick'];
var SHAPES = ['rectangle', 'circle', 'ellipse', 'diamond'];

function h(tag, attrs, children) {
  var el = document.createElement(tag);
  if (attrs) Object.keys(attrs).forEach(function (k) {
    if (k === 'class') el.className = attrs[k];
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), attrs[k]);
    else if (attrs[k] !== null && attrs[k] !== undefined) el.setAttribute(k, attrs[k]);
  });
  if (children && !Array.isArray(children)) children = [children];
  (children || []).forEach(function (c) {
    if (c === null || c === undefined) return;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return el;
}

function init(root, getCM, rerender) {
  rootEl = root;
  CM_API = getCM;   // () => CodeMirror 实例
  RERENDER = rerender;
  TIKZ = global.PaperLite.tikz;
  renderPanel();
}

function curDiagram() {
  if (!LAST || !LAST.diagrams.length) return null;
  return LAST.diagrams[Math.min(state.did, LAST.diagrams.length - 1)];
}

function refresh(result) {
  LAST = result;
  if (state.did >= result.diagrams.length) state.did = 0;
  renderPanel();
  highlightInPreview();
}

// ---------------- 面板渲染 ----------------
function renderPanel() {
  if (!rootEl) return;
  rootEl.innerHTML = '';
  var dg = curDiagram();
  var title = h('div', { class: 'sp-title' }, [h('span', { class: 'sp-icon' }, '🎨'), ' 图样式编辑']);
  rootEl.appendChild(title);

  if (!LAST || !LAST.diagrams.length) {
    rootEl.appendChild(h('div', { class: 'sp-empty' }, '文档中还没有 tikzpicture 流程图。', h('div', { class: 'sp-hint' }, '在编辑器工具栏点「流程图」插入一个试试。')));
    return;
  }

  // 图选择
  if (LAST.diagrams.length > 1) {
    var tabs = h('div', { class: 'sp-tabs' });
    LAST.diagrams.forEach(function (d, i) {
      tabs.appendChild(h('button', {
        class: 'sp-tab' + (i === state.did ? ' on' : ''),
        onclick: function () { state.did = i; state.sel = null; renderPanel(); highlightInPreview(); }
      }, '图 ' + (i + 1)));
    });
    rootEl.appendChild(tabs);
  }

  // 样式列表（tikzset）
  var styleRanges = (dg && dg.tikzsetRanges) || [];
  var secS = h('div', { class: 'sp-sec' }, h('div', { class: 'sp-sec-h' }, '样式（tikzset）'));
  if (!styleRanges.length) secS.appendChild(h('div', { class: 'sp-hint' }, '本文档还没有定义样式，可点击下方新建。'));
  styleRanges.forEach(function (sr) {
    var itp = TIKZ.interpret(TIKZ.parseOpts(cmRangeText(sr.start, sr.end)) || []);
    var sw = h('span', { class: 'sw', style: 'background:' + (itp.fill && itp.fill !== 'none' ? itp.fill : 'transparent') + ';border:1.5px solid ' + ((itp.draw && itp.draw !== 'none') ? itp.draw : '#ccc') });
    secS.appendChild(h('div', {
      class: 'sp-item' + (state.sel && state.sel.type === 'style' && state.sel.key === sr.name ? ' on' : ''),
      onclick: function () { state.sel = { type: 'style', key: sr.name }; renderPanel(); highlightInPreview(); }
    }, [sw, h('code', null, esc0(sr.name))]));
  });
  secS.appendChild(h('button', { class: 'sp-newstyle', onclick: addNewStyle }, '＋ 新建样式'));
  rootEl.appendChild(secS);

  // 节点列表
  var nodes = (dg && dg.nodes) || [];
  var secN = h('div', { class: 'sp-sec' }, h('div', { class: 'sp-sec-h' }, '节点（点击图可选中）'));
  if (!nodes.length) secN.appendChild(h('div', { class: 'sp-hint' }, '本图没有命名节点。'));
  nodes.forEach(function (nd) {
    var sw = h('span', { class: 'sw sw-sm', style: 'background:' + (nd.fill || 'transparent') + ';border:1.5px solid ' + (nd.drawOn ? nd.draw : '#ccc') });
    secN.appendChild(h('div', {
      class: 'sp-item' + (state.sel && state.sel.type === 'node' && state.sel.sidx === nd.sidx ? ' on' : ''),
      onclick: function () { state.sel = { type: 'node', sidx: nd.sidx }; renderPanel(); highlightInPreview(); }
    }, [sw, h('code', null, esc0(nd.name || '·')), h('span', { class: 'sp-ntext' }, esc0(nd.text.slice(0, 14)))]));
  });
  rootEl.appendChild(secN);

  // 属性编辑区
  if (state.sel) {
    var rec = getSelRecord();
    if (rec) rootEl.appendChild(buildForm(rec));
  }
}

function esc0(s) { var d = document.createElement('i'); d.textContent = s == null ? '' : s; return d.textContent; }

function getSelRecord() {
  var dg = curDiagram();
  if (!dg) return null;
  if (state.sel.type === 'node') {
    var nd = dg.nodes.filter(function (n) { return n.sidx === state.sel.sidx; })[0];
    if (!nd) return null;
    return { kind: 'node', node: nd,
      props: {
        fill: nd.fill, border: nd.drawOn, borderColor: nd.draw || '#000000',
        textColor: nd.textColor, lwPt: nd.lwPt, dashed: !!nd.dash,
        roundedPt: nd.roundedPt || 0, shape: nd.shape, fontpx: nd.fontpx
      } };
  }
  // style: 从源码读回当前定义
  var sr = (dg.tikzsetRanges || []).filter(function (s) { return s.name === state.sel.key; })[0];
  if (!sr) return null;
  var itp = TIKZ.interpret(TIKZ.parseOpts(cmRangeText(sr.start, sr.end) || ''));
  return { kind: 'style', range: sr,
    props: {
      fill: (itp.fill && itp.fill !== 'none') ? itp.fill : null,
      border: !(itp.draw === undefined || itp.draw === null || itp.draw === 'none'),
      borderColor: (itp.draw && itp.draw !== 'none') ? itp.draw : '#000000',
      textColor: itp.textColor, lwPt: itp.lineWidthPt || 0.4, dashed: !!itp.dash,
      roundedPt: itp.roundedPt || 0, shape: itp.shape || 'rectangle', fontpx: 13
    } };
}

// ---------------- 属性表单 ----------------
function buildForm(rec) {
  var p = rec.props;
  var box = h('div', { class: 'sp-form' });
  var head = rec.kind === 'style' ? '样式 “' + esc0(state.sel.key) + '”' : '节点 ' + esc0(rec.node.name || '');
  box.appendChild(h('div', { class: 'sp-form-h' }, head));

  var inputs = {};
  function row(label, ctrl) { box.appendChild(h('label', { class: 'sp-row' }, [h('span', { class: 'sp-lb' }, label), ctrl])); }
  function colorRow(label, key, initial, withNone) {
    var wrap = h('span', { class: 'sp-cw' });
    var cb = h('input', { type: 'checkbox' }); cb.checked = !!initial;
    var ci = h('input', { type: 'color', value: initial || '#ffffff' }); ci.disabled = !initial;
    cb.addEventListener('change', function () { ci.disabled = !cb.checked; });
    wrap.appendChild(cb); wrap.appendChild(ci);
    if (withNone) wrap.appendChild(h('span', { class: 'sp-mini' }, '启用'));
    inputs[key] = { cb: cb, ci: ci };
    row(label, wrap);
  }

  colorRow('填充色', 'fill', p.fill, true);
  colorRow('边框', 'border', p.border ? p.borderColor : null, true);
  colorRow('文字色', 'text', p.textColor, true);

  // 线宽
  var lwSel = h('select', null, [
    h('option', { value: '0.2' }, '极细'), h('option', { value: '0.4' }, '细(默认)'),
    h('option', { value: '0.8' }, '中'), h('option', { value: '1.2' }, '粗'), h('option', { value: '1.6' }, '特粗')
  ]);
  lwSel.value = String(p.lwPt || 0.4);
  if (lwSel.selectedIndex < 0) lwSel.value = '0.4';
  inputs.lw = lwSel;
  row('线宽', lwSel);

  var dashCb = h('input', { type: 'checkbox' }); dashCb.checked = p.dashed;
  inputs.dash = dashCb;
  row('虚线', dashCb);

  if (rec.kind === 'node' || true) {
    var shapeSel = h('select', null, SHAPES.map(function (s) { return h('option', { value: s }, { rectangle: '矩形', circle: '圆', ellipse: '椭圆', diamond: '菱形' }[s]); }));
    shapeSel.value = p.shape;
    if (shapeSel.selectedIndex < 0) shapeSel.value = 'rectangle';
    inputs.shape = shapeSel;
    row('形状', shapeSel);

    var rd = h('input', { type: 'number', min: '0', max: '30', step: '1', value: String(p.roundedPt || 0), style: 'width:70px' });
    inputs.round = rd;
    row('圆角(pt)', rd);
  }

  if (rec.kind === 'node') {
    var fs = h('select', null, Object.keys(FONT_NAMES).map(function (px) { return h('option', { value: px }, px + 'px'); }));
    fs.value = String(nearestFontPx(p.fontpx));
    if (fs.selectedIndex < 0) fs.value = '13';
    inputs.font = fs;
    row('字号', fs);
  }

  box.appendChild(h('button', {
    class: 'sp-apply',
    onclick: function () { apply(rec, inputs); }
  }, '✓ 应用到源码'));

  if (rec.kind === 'node') {
    box.appendChild(h('div', { class: 'sp-hint' }, '提示：给节点指定样式名（如 block）后，改样式可一次作用于全部同类节点。'));
  }
  return box;
}

function nearestFontPx(px) {
  var best = 13, bd = 1e9;
  Object.keys(FONT_NAMES).forEach(function (k) { var d = Math.abs(k - px); if (d < bd) { bd = d; best = +k; } });
  return best;
}

// ---------------- 应用修改（写回源码） ----------------
function apply(rec, inputs) {
  var cm = CM_API();
  var p = rec.props;
  var fillNow = inputs.fill.cb.checked ? inputs.fill.ci.value.toLowerCase() : 'none';
  var borderNow = inputs.border.cb.checked ? inputs.border.ci.value.toLowerCase() : null;
  var textNow = inputs.text.cb.checked ? inputs.text.ci.value.toLowerCase() : null;
  var lwNow = parseFloat(inputs.lw.value) || 0.4;
  var dashNow = inputs.dash.checked;
  var shapeNow = inputs.shape ? inputs.shape.value : null;
  var roundNow = inputs.round ? Math.max(0, parseFloat(inputs.round.value) || 0) : null;
  var fontNow = inputs.font ? +inputs.font.value : null;

  // 只回写发生变化的字段，避免把继承自样式的属性固化成内联选项
  var ch = {};
  var fill0 = p.fill ? p.fill.toLowerCase() : 'none';
  if (fillNow !== fill0) ch.fill = fillNow;
  var border0 = p.border ? String(p.borderColor).toLowerCase() : null;
  if (borderNow !== border0) { ch.border = !!borderNow; if (borderNow) ch.borderC = borderNow; }
  var text0 = p.textColor ? p.textColor.toLowerCase() : null;
  if (textNow !== text0) ch.text = textNow;
  if (Math.abs(lwNow - (p.lwPt || 0.4)) > 0.05) ch.lwPt = lwNow;
  if (dashNow !== !!p.dashed) ch.dashed = dashNow;
  if (shapeNow && shapeNow !== p.shape) ch.shape = shapeNow;
  if (roundNow !== null && Math.abs(roundNow - (p.roundedPt || 0)) > 0.4) ch.round = roundNow;
  if (fontNow && fontNow !== nearestFontPx(p.fontpx)) ch.fontPx = fontNow;

  var list;
  var from, to;
  if (rec.kind === 'style') {
    list = TIKZ.parseOpts(cmRangeText(rec.range.start, rec.range.end) || '');
    from = cm.posFromIndex(rec.range.start); to = cm.posFromIndex(rec.range.end);
  } else {
    var nd = rec.node;
    if (nd.optStart >= 0 && nd.optEnd > nd.optStart) {
      list = TIKZ.parseOpts(cm.getRange(cm.posFromIndex(nd.optStart), cm.posFromIndex(nd.optEnd)));
      from = cm.posFromIndex(nd.optStart); to = cm.posFromIndex(nd.optEnd);
    } else {
      list = [];
      from = cm.posFromIndex(nd.optInsert); to = from;
    }
  }

  mutateOpts(list, ch);

  var textOut = TIKZ.buildOpts(list);
  var noOpts = rec.kind === 'node' && rec.node.optStart < 0;
  cm.replaceRange(noOpts ? '[' + textOut + ']' : textOut, from, to);
  RERENDER();
}

function mutateOpts(list, ch) {
  var T = TIKZ;
  function setColor(k, hex) {
    var nm = T.nearestNamed(hex);
    T.setOpt(list, k, nm || T.colorToTikz(hex));
  }
  // 填充
  if (ch.fill === 'none') T.setOpt(list, 'fill', 'none');
  else if (ch.fill) setColor('fill', ch.fill);
  // 边框
  if (ch.border === false) T.setOpt(list, 'draw', 'none');
  else if (ch.border && ch.borderC) setColor('draw', ch.borderC);
  // 文字色
  if (ch.text) setColor('text', ch.text);
  else if (ch.text === undefined) { /* 未变更 */ }
  // 线宽
  if (ch.lwPt !== undefined) {
    T.delOptAny(list, LW_KEYS);
    if (Math.abs(ch.lwPt - 0.4) > 0.05) T.setOpt(list, 'line width', ch.lwPt + 'pt');
  }
  // 虚线
  if (ch.dashed !== undefined) {
    T.delOptAny(list, DASH_KEYS);
    if (ch.dashed) list.push({ k: 'dashed', v: null });
  }
  // 形状
  if (ch.shape) {
    T.delOptAny(list, SHAPES);
    if (ch.shape !== 'rectangle') list.push({ k: ch.shape, v: null });
  }
  // 圆角（仅矩形）
  if (ch.round !== undefined && ch.round !== null) {
    if (ch.round > 0) T.setOpt(list, 'rounded corners', ch.round + 'pt');
    else T.setOpt(list, 'rounded corners', null);
  }
  // 字号
  if (ch.fontPx) {
    var name = FONT_NAMES[nearestFontPx(ch.fontPx)];
    if (name === '\\normalsize') T.setOpt(list, 'font', null);
    else T.setOpt(list, 'font', name);
  }
}

function cmRangeText(start, end) {
  var cm = CM_API();
  try { return cm.getRange(cm.posFromIndex(start), cm.posFromIndex(end)); } catch (e) { return ''; }
}

function colorVal(hex) { return hex; }

// 新建样式：插入到导言区
function addNewStyle() {
  var cm = CM_API();
  var src = cm.getValue();
  var name = 'style1', n = 1;
  while (src.indexOf('/.style') >= 0 && src.indexOf(name + '/.style') >= 0) { n++; name = 'style' + n; }
  var def = name + '/.style={fill=yellow!30, draw=orange, rounded corners=4pt}';
  var insertAt;
  var mTikzset = src.lastIndexOf('\\tikzset');
  var mCls = src.match(/\\documentclass[^\n]*\n/);
  if (mTikzset >= 0) insertAt = mTikzset;
  else if (mCls) insertAt = mCls.index + mCls[0].length;
  else insertAt = 0;
  var pos = cm.posFromIndex(insertAt);
  cm.replaceRange('\\tikzset{' + def + '}\n', pos, pos);
  state.sel = { type: 'style', key: name };
  RERENDER();
}

// ---------------- 预览联动 ----------------
function selectFromPreview(did, sidx) {
  state.did = did;
  state.sel = { type: 'node', sidx: sidx };
  renderPanel();
  highlightInPreview();
}

function highlightInPreview() {
  var prev = document.getElementById('preview');
  if (!prev) return;
  Array.prototype.forEach.call(prev.querySelectorAll('.tk-node.selected, .tk-label.selected'), function (el) { el.classList.remove('selected'); });
  if (!state.sel || state.sel.type !== 'node') return;
  var sel = '[data-sidx="' + state.sel.sidx + '"]';
  Array.prototype.forEach.call(prev.querySelectorAll('.tk-node' + sel), function (el) {
    el.classList.add('selected');
    var svg = el.closest('svg');
    if (svg) svg.classList.add('has-sel');
  });
}

global.PaperLite = global.PaperLite || {};
global.PaperLite.stylepanel = { init: init, refresh: refresh, selectFromPreview: selectFromPreview };

})(typeof window !== 'undefined' ? window : globalThis);

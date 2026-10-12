/* PaperLite · 样式回写纯逻辑（面板 UI 与源码修改解耦）
 * 依据 tikz.js 记录的原文档偏移，把面板修改精确写回 CodeMirror 文档。
 */
import * as TIKZ from './engines/tikz.js';

export const FONT_NAMES = { 8: '\\tiny', 9: '\\scriptsize', 10: '\\footnotesize', 11: '\\small', 13: '\\normalsize', 16: '\\large', 19: '\\Large', 22: '\\LARGE', 25: '\\huge', 29: '\\Huge' };
export const DASH_KEYS = ['dashed', 'densely dashed', 'loosely dashed', 'dotted', 'densely dotted', 'loosely dotted'];
export const LW_KEYS = ['ultra thin', 'very thin', 'thin', 'semithick', 'thick', 'very thick', 'ultra thick'];
export const SHAPES = ['rectangle', 'circle', 'ellipse', 'diamond'];
export const SHAPE_NAMES = { rectangle: '矩形', circle: '圆', ellipse: '椭圆', diamond: '菱形' };
export const LW_OPTIONS = [
  { v: '0.2', label: '极细' }, { v: '0.4', label: '细(默认)' },
  { v: '0.8', label: '中' }, { v: '1.2', label: '粗' }, { v: '1.6', label: '特粗' }
];

export function nearestFontPx(px) {
  let best = 13, bd = 1e9;
  Object.keys(FONT_NAMES).forEach(k => { const d = Math.abs(k - px); if (d < bd) { bd = d; best = +k; } });
  return best;
}

function cmRangeText(cm, start, end) {
  try { return cm.getRange(cm.posFromIndex(start), cm.posFromIndex(end)); } catch (e) { return ''; }
}

// 由当前选择得到可编辑记录（节点或样式），props 为面板初始值
export function getRecord(cm, result, sel) {
  if (!cm || !result || !sel) return null;
  const dg = result.diagrams[Math.min(sel.did, Math.max(0, result.diagrams.length - 1))];
  if (!dg) return null;
  if (sel.type === 'node') {
    const nd = (dg.nodes || []).filter(n => n.sidx === sel.sidx)[0];
    if (!nd) return null;
    return {
      kind: 'node', node: nd,
      props: {
        fill: nd.fill, border: nd.drawOn, borderColor: nd.draw || '#000000',
        textColor: nd.textColor, lwPt: nd.lwPt, dashed: !!nd.dash,
        roundedPt: nd.roundedPt || 0, shape: nd.shape, fontpx: nd.fontpx
      }
    };
  }
  const sr = (dg.tikzsetRanges || []).filter(s => s.name === sel.key)[0];
  if (!sr) return null;
  const itp = TIKZ.interpret(TIKZ.parseOpts(cmRangeText(cm, sr.start, sr.end) || ''));
  return {
    kind: 'style', range: sr, name: sr.name,
    props: {
      fill: (itp.fill && itp.fill !== 'none') ? itp.fill : null,
      border: !(itp.draw === undefined || itp.draw === null || itp.draw === 'none'),
      borderColor: (itp.draw && itp.draw !== 'none') ? itp.draw : '#000000',
      textColor: itp.textColor, lwPt: itp.lineWidthPt || 0.4, dashed: !!itp.dash,
      roundedPt: itp.roundedPt || 0, shape: itp.shape || 'rectangle', fontpx: 13
    }
  };
}

// 表单值 → 仅回写变化字段（避免把样式继承固化成内联选项）
export function applyChanges(cm, rec, v) {
  const p = rec.props;
  const ch = {};
  const fillNow = v.fillOn ? String(v.fill).toLowerCase() : 'none';
  const fill0 = p.fill ? String(p.fill).toLowerCase() : 'none';
  if (fillNow !== fill0) ch.fill = fillNow;
  const borderNow = v.borderOn ? String(v.borderColor).toLowerCase() : null;
  const border0 = p.border ? String(p.borderColor).toLowerCase() : null;
  if (borderNow !== border0) { ch.border = !!v.borderOn; if (v.borderOn) ch.borderC = borderNow; }
  const textNow = v.textOn ? String(v.text).toLowerCase() : null;
  const text0 = p.textColor ? String(p.textColor).toLowerCase() : null;
  if (textNow !== text0) ch.text = textNow;
  if (Math.abs((+v.lwPt || 0.4) - (p.lwPt || 0.4)) > 0.05) ch.lwPt = +v.lwPt || 0.4;
  if (!!v.dashed !== !!p.dashed) ch.dashed = !!v.dashed;
  if (v.shape && v.shape !== p.shape) ch.shape = v.shape;
  if (v.round !== undefined && Math.abs(v.round - (p.roundedPt || 0)) > 0.4) ch.round = v.round;
  if (v.fontPx && +v.fontPx !== nearestFontPx(p.fontpx)) ch.fontPx = +v.fontPx;

  let list, from, to, wrap = false;
  if (rec.kind === 'style') {
    list = TIKZ.parseOpts(cmRangeText(cm, rec.range.start, rec.range.end) || '');
    from = cm.posFromIndex(rec.range.start);
    to = cm.posFromIndex(rec.range.end);
  } else {
    const nd = rec.node;
    if (nd.optStart >= 0 && nd.optEnd > nd.optStart) {
      list = TIKZ.parseOpts(cm.getRange(cm.posFromIndex(nd.optStart), cm.posFromIndex(nd.optEnd)));
      from = cm.posFromIndex(nd.optStart);
      to = cm.posFromIndex(nd.optEnd);
    } else {
      list = [];
      from = cm.posFromIndex(nd.optInsert);
      to = from;
      wrap = true;
    }
  }

  mutateOpts(list, ch);
  const textOut = TIKZ.buildOpts(list);
  cm.replaceRange(wrap ? '[' + textOut + ']' : textOut, from, to);
}

function mutateOpts(list, ch) {
  function setColor(k, hex) {
    const nm = TIKZ.nearestNamed(hex);
    TIKZ.setOpt(list, k, nm || TIKZ.colorToTikz(hex));
  }
  if (ch.fill === 'none') TIKZ.setOpt(list, 'fill', 'none');
  else if (ch.fill) setColor('fill', ch.fill);
  if (ch.border === false) TIKZ.setOpt(list, 'draw', 'none');
  else if (ch.border && ch.borderC) setColor('draw', ch.borderC);
  if (ch.text) setColor('text', ch.text);
  if (ch.lwPt !== undefined) {
    TIKZ.delOptAny(list, LW_KEYS);
    if (Math.abs(ch.lwPt - 0.4) > 0.05) TIKZ.setOpt(list, 'line width', ch.lwPt + 'pt');
  }
  if (ch.dashed !== undefined) {
    TIKZ.delOptAny(list, DASH_KEYS);
    if (ch.dashed) list.push({ k: 'dashed', v: null });
  }
  if (ch.shape) {
    TIKZ.delOptAny(list, SHAPES);
    if (ch.shape !== 'rectangle') list.push({ k: ch.shape, v: null });
  }
  if (ch.round !== undefined) {
    if (ch.round > 0) TIKZ.setOpt(list, 'rounded corners', ch.round + 'pt');
    else TIKZ.setOpt(list, 'rounded corners', null);
  }
  if (ch.fontPx) {
    const name = FONT_NAMES[nearestFontPx(ch.fontPx)];
    if (name === '\\normalsize') TIKZ.setOpt(list, 'font', null);
    else TIKZ.setOpt(list, 'font', name);
  }
}

// 新建样式：插入到导言区
export function addNewStyle(cm) {
  const src = cm.getValue();
  let name = 'style1', n = 1;
  while (src.indexOf(name + '/.style') >= 0) { n++; name = 'style' + n; }
  const def = name + '/.style={fill=yellow!30, draw=orange, rounded corners=4pt}';
  let insertAt;
  const mTikzset = src.lastIndexOf('\\tikzset');
  const mCls = src.match(/\\documentclass[^\n]*\n/);
  if (mTikzset >= 0) insertAt = mTikzset;
  else if (mCls) insertAt = mCls.index + mCls[0].length;
  else insertAt = 0;
  cm.replaceRange('\\tikzset{' + def + '}\n', cm.posFromIndex(insertAt), cm.posFromIndex(insertAt));
  return name;
}

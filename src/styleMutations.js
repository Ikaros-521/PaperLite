/* PaperLite · 样式回写纯逻辑（面板 UI 与源码修改解耦）
 * 依据 tikz.js 记录的原文档偏移，把面板修改精确写回 CodeMirror 文档。
 */
import * as TIKZ from './engines/tikz.js';

export const FONT_NAMES = { 8: '\\tiny', 9: '\\scriptsize', 10: '\\footnotesize', 11: '\\small', 13: '\\normalsize', 16: '\\large', 19: '\\Large', 22: '\\LARGE', 25: '\\huge', 29: '\\Huge' };
export const DASH_KEYS = ['dashed', 'densely dashed', 'loosely dashed', 'dotted', 'densely dotted', 'loosely dotted'];
export const LW_KEYS = ['ultra thin', 'very thin', 'thin', 'semithick', 'thick', 'very thick', 'ultra thick'];
export const SHAPES = ['rectangle', 'circle', 'ellipse', 'diamond'];
// 显示名走 i18n 字典（shape.* / lw.*），此处存 key
export const SHAPE_NAMES = { rectangle: 'shape.rectangle', circle: 'shape.circle', ellipse: 'shape.ellipse', diamond: 'shape.diamond' };
export const LW_OPTIONS = [
  { v: '0.2', key: 'lw.0.2' }, { v: '0.4', key: 'lw.0.4' },
  { v: '0.8', key: 'lw.0.8' }, { v: '1.2', key: 'lw.1.2' }, { v: '1.6', key: 'lw.1.6' }
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
        roundedPt: nd.roundedPt || 0, shape: nd.shape, fontpx: nd.fontpx,
        posX: nd.posCm.x, posY: nd.posCm.y, wcm: nd.sizeCm.w, hcm: nd.sizeCm.h,
        placed: !!nd.placed, minWcm: nd.declaredMinWcm || 0, minHcm: nd.declaredMinHcm || 0
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

  // 布局：位置（写 at 绝对坐标）与最小宽高（写 minimum width/height）
  if (rec.kind === 'node') {
    if (v.posX !== undefined && !isNaN(+v.posX) && !isNaN(+v.posY) &&
        (Math.abs(+v.posX - p.posX) > 0.015 || Math.abs(+v.posY - p.posY) > 0.015)) {
      ch.at = { x: +(+v.posX).toFixed(2), y: +(+v.posY).toFixed(2) };
    }
    if (v.wcm !== undefined && !isNaN(+v.wcm) && Math.abs(+v.wcm - p.wcm) > 0.015) ch.minWcm = Math.max(0, +v.wcm);
    if (v.hcm !== undefined && !isNaN(+v.hcm) && Math.abs(+v.hcm - p.hcm) > 0.015) ch.minHcm = Math.max(0, +v.hcm);
  }

  let list, from, to, wrap = false;
  if (rec.kind === 'style') {
    list = TIKZ.parseOpts(cmRangeText(cm, rec.range.start, rec.range.end) || '');
    from = cm.posFromIndex(rec.range.start);
    to = cm.posFromIndex(rec.range.end);
  } else {
    const nd = rec.node;
    // 先回写 at 区间（位于选项之后，先改不影响选项偏移），再回写选项
    if (ch.at) {
      const atText = 'at (' + ch.at.x + 'cm,' + ch.at.y + 'cm)';
      if (nd.atStart >= 0 && nd.atEnd > nd.atStart) {
        cm.replaceRange(atText, cm.posFromIndex(nd.atStart), cm.posFromIndex(nd.atEnd));
      } else if (nd.atInsert >= 0) {
        cm.replaceRange(' ' + atText, cm.posFromIndex(nd.atInsert), cm.posFromIndex(nd.atInsert));
      }
    }
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
  // operation 包裹：整次应用合为单个撤销步骤（面板「↶ 撤销」一次即可完整恢复）
  cm.operation(function () {
    cm.replaceRange(wrap ? '[' + textOut + ']' : textOut, from, to);
  });
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
  if (ch.minWcm !== undefined || ch.minHcm !== undefined) {
    TIKZ.delOptAny(list, ['minimum size']); // 显式宽/高会与 minimum size 叠加取最大，先移除
    if (ch.minWcm !== undefined) {
      if (ch.minWcm > 0) TIKZ.setOpt(list, 'minimum width', ch.minWcm + 'cm');
      else TIKZ.setOpt(list, 'minimum width', null);
    }
    if (ch.minHcm !== undefined) {
      if (ch.minHcm > 0) TIKZ.setOpt(list, 'minimum height', ch.minHcm + 'cm');
      else TIKZ.setOpt(list, 'minimum height', null);
    }
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

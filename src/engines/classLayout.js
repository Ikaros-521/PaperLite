/* PaperLite · 排版语法：\documentclass[options]{class} → 版式描述符
 *
 * 网页预览是近似排版，只能忠实呈现「类 + 选项」里影响版式的那几个维度：
 * 栏数、基准字号、纸面宽度、标题带形态、页眉。其余选项（peerreview、comsoc 的
 * 字体微调等）解析出来但不呈现，交给真实编译。
 * 未识别的文档类不报错，退化为 article 形态的默认版式。
 */

// 屏幕近似排版用的字号缩放：以现有 12pt 观感为 1，双栏下不线性缩到 8pt 那么小
const SCALE_PT = { 8: 0.74, 9: 0.82, 10: 0.9, 11: 0.96, 12: 1, 14: 1.1, 16: 1.2, 17: 1.26, 18: 1.32, 20: 1.42 };

// 96dpi 下的纸面宽度（含 #paper 自身内边距）
const PAGE_W = { a4paper: 794, a5paper: 559, b5paper: 621, letterpaper: 830, legalpaper: 830, executivepaper: 750, '10inch': 960, '11inch': 1056, '12inch': 1152 };

const FAMILIES = [
  { id: 'ieee', re: /^(IEEEtran|IEEEconf|IEEEJS|IEEEicmc)$/i },
  { id: 'ctex', re: /^ctex/ },
  { id: 'elegant', re: /^elegant/i },
  { id: 'koma', re: /^scr|^komascript/ },
  { id: 'beamer', re: /^beamer$/i },
  { id: 'standard', re: /^(article|report|book|letter|minimal|proc|amsart|amsbook|amsproc)$/ }
];

// 影响版式的模式选项（IEEEtran）
const IEEE_MODES = { journal: 'journal', conference: 'conference', technote: 'technote', draft: 'draft', draftcls: 'draft', draftclsmobile: 'draft', comsoc: 'comsoc', peerreview: 'peerreview', peerreviewca: 'peerreview', peerreviewdraft: 'peerreview' };

function familyOf(cls) {
  for (const f of FAMILIES) if (f.re.test(cls)) return f.id;
  return 'other';
}

// 从导言区取 \documentclass 的类名与选项（顶层只出现一次；多次由 linter 报）
function readDocumentclass(preamble) {
  const m = preamble.match(/\\documentclass\s*(\[[^\]]*\])?\s*\{([^{}]*)\}/);
  if (!m) return null;
  const options = (m[1] ? m[1].slice(1, -1) : '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return { cls: m[2].trim(), options };
}

function resolveLayout(cls, options) {
  const family = familyOf(cls);
  const list = options.filter(o => !o.includes('='));
  const has = (o) => list.indexOf(o) >= 0;

  let mode = null;
  for (const o of list) if (family === 'ieee' && IEEE_MODES[o]) mode = IEEE_MODES[o];

  // 尺寸：取最后一个显式给出的 pt 选项（LaTeX 也是后者覆盖前者）
  let basePt = 12;
  for (const o of list) {
    const mt = /^(\d+)pt$/.exec(o);
    if (mt) basePt = +mt[1];
  }
  if (family === 'ieee' && basePt === 12 && !list.some(o => /^\d+pt$/.test(o))) basePt = 10; // IEEEtran 默认 10pt

  // 纸张
  let page = null;
  for (const o of list) if (PAGE_W[o]) page = o;
  if (!page) page = family === 'ieee' ? 'letterpaper' : 'a4paper';

  // 栏数：IEEEtran 的 journal/conference/comsoc 默认双栏
  let columns = family === 'ieee' && mode !== 'technote' && mode !== 'draft' ? 2 : 1;
  if (has('twocolumn')) columns = 2;
  if (has('onecolumn')) columns = 1;

  // 标题带跨栏：只有 IEEEtran 这类用 \twocolumn[标题区] 的期刊模板如此
  const spanHead = family === 'ieee' && columns === 2;

  const conflicts = [];
  if (has('twocolumn') && has('onecolumn')) conflicts.push({ a: 'twocolumn', b: 'onecolumn' });
  const modes = list.filter(o => family === 'ieee' && IEEE_MODES[o]);
  if (new Set(modes.map(o => IEEE_MODES[o])).size > 1) conflicts.push({ a: modes[0], b: modes[modes.length - 1] });

  const classes = [
    'cls-' + family,
    'cls-' + cls.toLowerCase().replace(/[^a-z0-9-]/g, ''),
    mode ? 'mode-' + mode : '',
    columns === 2 ? (spanHead ? 'cols-span' : 'twocolumn') : ''
  ].filter(Boolean).join(' ');

  const scale = SCALE_PT[basePt] || 1;
  return {
    cls,
    family,
    mode,
    columns,
    spanHead,
    basePt,
    scale,
    page,
    heads: family === 'ieee',
    authorLayout: family === 'ieee' ? (mode === 'conference' ? 'columns' : 'stack') : 'plain',
    conflicts,
    classes,
    vars: {
      '--doc-scale': String(scale),
      '--doc-page-w': (PAGE_W[page] || 830) + 'px',
      // IEEE 双栏的栏间距按真实版式收紧，普通双栏沿用原观感
      '--doc-col-gap': (family === 'ieee' ? 26 : 34) + 'px'
    }
  };
}

const FALLBACK = { cls: '', family: 'other', mode: null, columns: 1, spanHead: false, basePt: 12, scale: 1, page: null, heads: false, authorLayout: 'plain', conflicts: [], classes: '', vars: {} };

export { readDocumentclass, resolveLayout, FALLBACK };

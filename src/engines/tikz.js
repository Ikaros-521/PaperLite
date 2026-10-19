/* PaperLite · TikZ 子集渲染引擎 v2
 *
 * 覆盖论文流程图/架构图常用语法，输出 SVG 字符串（无 DOM 依赖，可在 Node 中测试）。
 * 每个节点记录其在原文档中的选项区间（绝对偏移），供样式面板回写源码。
 */


var CM = 96 / 2.54;
var PT = 96 / 72;
var FONT_FAMILY = 'Georgia, "Times New Roman", "Noto Serif SC", "SimSun", serif';

var COLORS = {
  red: '#ff0000', green: '#00ff00', blue: '#0000ff', cyan: '#00ffff', magenta: '#ff00ff',
  yellow: '#ffff00', black: '#000000', white: '#ffffff', gray: '#808080', grey: '#808080',
  darkgray: '#404040', darkgrey: '#404040', lightgray: '#bfbfbf', lightgrey: '#bfbfbf',
  brown: '#c08040', lime: '#b3ff00', olive: '#808000', orange: '#ff8000', pink: '#ffbfbf',
  purple: '#bf00bf', teal: '#008080', violet: '#800080'
};

var FONT_SIZE = {
  tiny: 8, scriptsize: 9, footnotesize: 10, small: 11, normalsize: 13,
  large: 16, Large: 19, LARGE: 22, huge: 25, Huge: 29
};

var LINE_WIDTH = { 'ultra thin': 0.1, 'very thin': 0.2, thin: 0.4, semithick: 0.6, thick: 0.8, 'very thick': 1.2, 'ultra thick': 1.6 };
var ARROW_KEYS = { '->': [0, 1], '<-': [1, 0], '<->': [1, 1], '-stealth': [0, 1], 'stealth-': [1, 0], '-Stealth': [0, 1], 'Stealth-': [1, 0], '-Latex': [0, 1], 'Latex-': [1, 0], '-latex': [0, 1], 'latex-': [1, 0], '-to': [0, 1], 'to-': [1, 0], '->>': [0, 1], '<<-': [1, 0] };

var DIRS = { right: [1, 0], left: [-1, 0], above: [0, -1], below: [0, 1],
  'above right': [0.7071, -0.7071], 'above left': [-0.7071, -0.7071],
  'below right': [0.7071, 0.7071], 'below left': [-0.7071, 0.7071] };

// ---------------- 字符工具 ----------------
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function f(x) { return (Math.round(x * 10) / 10).toString(); }
function skipWs(s, i) { while (i < s.length && /\s/.test(s.charAt(i))) i++; return i; }

function braceEnd(s, i) {
  var d = 0;
  for (; i < s.length; i++) {
    var c = s.charAt(i);
    if (c === '\\') { i++; continue; }
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return i; }
  }
  return -1;
}
function bracketEnd(s, i) {
  var d = 0;
  for (; i < s.length; i++) {
    var c = s.charAt(i);
    if (c === '\\') { i++; continue; }
    if (c === '{') d++;
    else if (c === '}') d--;
    else if (c === ']' && d <= 0) return i;
  }
  return -1;
}
function splitTop(s, sep) {
  var out = [], cur = '', d = 0, i, c;
  for (i = 0; i < s.length; i++) {
    c = s.charAt(i);
    if (c === '\\') { cur += c + (s.charAt(i + 1) || ''); i++; continue; }
    if (c === '{' || c === '[') d++;
    else if (c === '}' || c === ']') d--;
    if (c === sep && d === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}
function topEq(s) {
  var d = 0, i, c;
  for (i = 0; i < s.length; i++) {
    c = s.charAt(i);
    if (c === '\\') { i++; continue; }
    if (c === '{' || c === '[') d++;
    else if (c === '}' || c === ']') d--;
    else if (c === '=' && d === 0) return i;
  }
  return -1;
}
function parseOpts(str) {
  var items = [];
  splitTop(str || '', ',').forEach(function (t) {
    t = t.replace(/^\s+|\s+$/g, '');
    if (!t) return;
    var e = topEq(t);
    if (e < 0) items.push({ k: t, v: null, raw: t });
    else items.push({ k: t.slice(0, e).replace(/^\s+|\s+$/g, ''), v: t.slice(e + 1).replace(/^\s+|\s+$/g, ''), raw: t });
  });
  return items;
}
function buildOpts(list) {
  return list.map(function (it) { return it.v === null || it.v === undefined ? it.k : it.k + '=' + it.v; }).join(', ');
}
function setOpt(list, k, v) {
  for (var i = 0; i < list.length; i++) {
    if (list[i].k === k) { if (v === null) list.splice(i, 1); else list[i].v = v; return; }
  }
  if (v !== null) list.push({ k: k, v: v });
}
function delOptAny(list, keys) { for (var i = list.length - 1; i >= 0; i--) if (keys.indexOf(list[i].k) >= 0) list.splice(i, 1); }

// ---------------- 颜色 ----------------
function hex2rgb(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function rgb2hex(r, g, b) {
  function q(x) { x = Math.max(0, Math.min(255, Math.round(x))); var s = x.toString(16); return s.length < 2 ? '0' + s : s; }
  return '#' + q(r) + q(g) + q(b);
}
function namedColor(n) { return COLORS[String(n).toLowerCase()] || null; }

function parseColor(spec) {
  if (spec === null || spec === undefined) return null;
  spec = String(spec).replace(/^\{|\}$/g, '').replace(/^\s+|\s+$/g, '');
  if (!spec || spec === 'none') return 'none';
  if (/^#[0-9a-fA-F]{6}$/.test(spec)) return spec.toLowerCase();
  var m = spec.match(/^rgb,?\s*(\d+):\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) { var b = +m[1] || 255; return rgb2hex(+m[2] * 255 / b, +m[3] * 255 / b, +m[4] * 255 / b); }
  m = spec.match(/^rgb\s*\{([\d.\s,]+)\}/);
  if (m) { var p = m[1].split(','); return rgb2hex(+p[0] * 255, +p[1] * 255, +p[2] * 255); }
  var parts = spec.split('!');
  if (parts.length === 1) return namedColor(parts[0]);
  var cur = namedColor(parts[0]); if (!cur) return null;
  var i = 1;
  while (i < parts.length) {
    var pct = parseFloat(parts[i]); if (isNaN(pct)) break;
    i++;
    var nxt = '#ffffff';
    if (i < parts.length && isNaN(parseFloat(parts[i]))) { nxt = namedColor(parts[i]) || '#ffffff'; i++; }
    var a = hex2rgb(cur), b2 = hex2rgb(nxt);
    cur = rgb2hex(a[0] * pct / 100 + b2[0] * (100 - pct) / 100, a[1] * pct / 100 + b2[1] * (100 - pct) / 100, a[2] * pct / 100 + b2[2] * (100 - pct) / 100);
  }
  return cur;
}
function colorToTikz(hex) {
  var c = hex2rgb(hex);
  return '{rgb,255:' + c[0] + ',' + c[1] + ',' + c[2] + '}';
}
function nearestNamed(hex) { // 若与预置色一致则返回名字（源码更可读）
  for (var k in COLORS) if (COLORS[k].toLowerCase() === String(hex).toLowerCase()) return k;
  return null;
}

// ---------------- 长度 ----------------
function parseLen(v, defUnit) {
  if (v === null || v === undefined) return NaN;
  // 容忍前后空白：node `at (1, 2)` 逗号后带空格是常见写法，不 trim 会得到 NaN、节点静默消失
  var m = String(v).replace(/^\{|\}$/g, '').trim().match(/^(-?[\d.]+)\s*(cm|mm|pt|bp|in|em|ex)?$/);
  if (!m) return NaN;
  var n = parseFloat(m[1]), u = m[2] || defUnit || 'cm';
  if (u === 'cm') return n * CM;
  if (u === 'mm') return n * CM / 10;
  if (u === 'pt' || u === 'bp') return n * PT;
  if (u === 'in') return n * 96;
  if (u === 'em') return n * 13;
  if (u === 'ex') return n * 6.5;
  return n * CM;
}

// ---------------- 文本测量 ----------------
var measCtx = null;
function measure(text, fontpx, bold) {
  if (measCtx === null) {
    try {
      if (typeof document !== 'undefined' && document.createElement) {
        var cv = document.createElement('canvas');
        measCtx = cv.getContext ? cv.getContext('2d') : false;
      } else measCtx = false;
    } catch (e) { measCtx = false; }
  }
  if (measCtx) {
    measCtx.font = (bold ? '700 ' : '400 ') + fontpx + 'px ' + FONT_FAMILY;
    return measCtx.measureText(text).width;
  }
  var w = 0;
  for (var i = 0; i < text.length; i++) w += text.charCodeAt(i) > 255 ? fontpx : fontpx * 0.55;
  return w;
}
function wrapText(text, maxW, fontpx, bold) {
  var lines = String(text || '').split(/\\\\/).map(function (l) { return l.replace(/^\s+|\s+$/g, ''); });
  if (!maxW) return lines;
  var out = [];
  lines.forEach(function (ln) {
    if (!ln || measure(ln, fontpx, bold) <= maxW) { out.push(ln); return; }
    var cur = '';
    for (var i = 0; i < ln.length; i++) {
      if (measure(cur + ln.charAt(i), fontpx, bold) > maxW && cur) {
        var cjk = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ln.charAt(i));
        if (!cjk) {
          var sp = cur.lastIndexOf(' ');
          if (sp > 0) { out.push(cur.slice(0, sp + 1).replace(/\s+$/, '')); cur = cur.slice(sp + 1) + ln.charAt(i); continue; }
        }
        out.push(cur); cur = ln.charAt(i);
      } else cur += ln.charAt(i);
    }
    if (cur) out.push(cur);
  });
  return out;
}

// ---------------- 选项解释 ----------------
function expandOpts(items, styles, depth) {
  var res = [];
  (items || []).forEach(function (it) {
    if (it.v === null && styles && styles[it.k] && (depth || 0) < 6) res = res.concat(expandOpts(styles[it.k], styles, (depth || 0) + 1));
    else res.push(it);
  });
  return res;
}

function readFont(fontVal, base) {
  var size = base || 13, bold = false, italic = false;
  var re = /\\(tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge|bfseries|itshape)/g, m;
  while ((m = re.exec(String(fontVal || '')))) {
    if (FONT_SIZE[m[1]] !== undefined) size = FONT_SIZE[m[1]];
    else if (m[1] === 'bfseries') bold = true;
    else italic = true;
  }
  return { size: size, bold: bold, italic: italic };
}

var SHAPES = ['rectangle', 'circle', 'ellipse', 'diamond', 'trapezium'];
var DASH_KEYS = ['dashed', 'densely dashed', 'loosely dashed', 'dotted', 'densely dotted', 'loosely dotted'];
var DASH_MAP = { 'dashed': 'dashed', 'densely dashed': 'dense', 'loosely dashed': 'loose', 'dotted': 'dotted', 'densely dotted': 'densedot', 'loosely dotted': 'loose' };
var LW_KEYS = ['ultra thin', 'very thin', 'thin', 'semithick', 'thick', 'very thick', 'ultra thick'];

function interpret(list) {
  var o = {
    shape: null, fill: null, draw: undefined, textColor: null,
    lineWidthPt: null, dash: null, roundedPt: null,
    minW: 0, minH: 0, minSize: 0, textWidthPx: null, align: null,
    fontVal: '', innerSepPt: null, nodeDistanceCm: null, opacity: null,
    arrowStart: false, arrowEnd: false, pos: null, labelPlace: null, scale: null,
    bendDeg: null, bendDir: null, outAng: null, inAng: null
  };
  (list || []).forEach(function (it) {
    var k = it.k, v = it.v;
    if (ARROW_KEYS[k]) { o.arrowStart = o.arrowStart || !!ARROW_KEYS[k][0]; o.arrowEnd = o.arrowEnd || !!ARROW_KEYS[k][1]; return; }
    if (SHAPES.indexOf(k) >= 0) { o.shape = (k === 'trapezium') ? 'rectangle' : k; return; }
    if (DASH_MAP[k]) { o.dash = DASH_MAP[k]; return; }
    if (LW_KEYS.indexOf(k) >= 0) { o.lineWidthPt = LINE_WIDTH[k]; return; }
    if (DIRS[k] && v === null) { o.labelPlace = o.labelPlace || k; return; }
    switch (k) {
      case 'fill': o.fill = parseColor(v); return;
      case 'draw': o.draw = (v === undefined || v === null || v === '') ? '#000000' : parseColor(v); if (v === 'none') o.draw = 'none'; return;
      case 'text': o.textColor = parseColor(v); return;
      case 'line width': o.lineWidthPt = parseLen(v, 'pt') / PT; return;
      case 'rounded corners': o.roundedPt = v ? parseLen(v, 'pt') / PT : 4; o.shape = o.shape || 'rectangle'; return;
      case 'minimum width': o.minW = parseLen(v, 'cm'); return;
      case 'minimum height': o.minH = parseLen(v, 'cm'); return;
      case 'minimum size': o.minSize = parseLen(v, 'cm'); return;
      case 'text width': o.textWidthPx = parseLen(v, 'cm'); o.align = o.align || 'left'; return;
      case 'align': o.align = v; return;
      case 'font': o.fontVal = v || ''; return;
      case 'inner sep': o.innerSepPt = parseLen(v, 'pt') / PT; return;
      case 'node distance': o.nodeDistanceCm = parseLen(v, 'cm') / CM; return;
      case 'opacity': o.opacity = parseFloat(v); return;
      case 'scale': o.scale = parseFloat(v); return;
      case 'pos': o.pos = parseFloat(v); return;
      case 'midway': o.pos = 0.5; return;
      case 'near start': o.pos = 0.25; return;
      case 'near end': o.pos = 0.75; return;
      case 'bend left': o.bendDeg = v ? +v : 30; o.bendDir = 'left'; return;
      case 'bend right': o.bendDeg = v ? +v : 30; o.bendDir = 'right'; return;
      case 'out': o.outAng = +v; return;
      case 'in': o.inAng = +v; return;
      case 'double': o.dbl = true; return;
      case 'above': case 'below': case 'left': case 'right':
      case 'above left': case 'above right': case 'below left': case 'below right':
        o.labelPlace = o.labelPlace || k; return;
    }
  });
  return o;
}

// 定位: right of=A | right=2cm of A
function extractPlacement(list) {
  for (var i = 0; i < list.length; i++) {
    var k = list[i].k, v = list[i].v;
    if (DIRS[k]) {
      if (v && /\bof\b/.test(v)) {
        var m = v.match(/^([\d.]+\s*(?:cm|mm|pt|in|bp)?)?\s*of\s+(.+)$/);
        if (m) return { dir: DIRS[k], distCm: m[1] ? parseLen(m[1], 'cm') / CM : null, ref: m[2].trim() };
      }
      continue;
    }
    var lg = k.match(/^(right|left|above|below|above right|above left|below right|below left)\s+of$/);
    if (lg && v) return { dir: DIRS[lg[1]], distCm: null, ref: v.trim() };
  }
  return null;
}

// ---------------- 语句拆分 ----------------
function splitStatements(s) {
  var out = [], d = 0, start = 0, i, c;
  for (i = 0; i < s.length; i++) {
    c = s.charAt(i);
    if (c === '\\') { i++; continue; }
    if (c === '{') { d++; continue; }
    if (c === '}') { d--; continue; }
    if (c === ';' && d === 0) { out.push({ text: s.slice(start, i), start: start }); start = i + 1; }
  }
  if (start < s.length) out.push({ text: s.slice(start), start: start });
  return out.filter(function (o) { return o.text.replace(/\s/g, ''); });
}

// 顶层分割并保留每段在原串中的区间
function splitTopIdx(s, sep) {
  var out = [], cur = '', d = 0, start = 0, i, c;
  for (i = 0; i < s.length; i++) {
    c = s.charAt(i);
    if (c === '\\') { cur += c + (s.charAt(i + 1) || ''); i++; continue; }
    if (c === '{' || c === '[') d++;
    else if (c === '}' || c === ']') d--;
    if (c === sep && d === 0) { out.push({ text: cur, start: start, end: i }); cur = ''; start = i + 1; }
    else cur += c;
  }
  out.push({ text: cur, start: start, end: s.length });
  return out;
}

// \tikzset 内容解析；out 记录 {name, start, end}（花括号内容在 str 内的绝对区间）
function parseTikzsetBody(str, styles, out) {
  splitTopIdx(str, ',').forEach(function (seg) {
    var lead = seg.text.length - seg.text.replace(/^\s+/, '').length;
    var part = seg.text.replace(/^\s+|\s+$/g, '');
    if (!part) return;
    var m = part.match(/^(.+?)\/\.?\s*style\s*=\s*([\s\S]+)$/);
    if (!m) return;
    var name = m[1].replace(/^\s+|\s+$/g, '');
    var def = m[2].replace(/^\s+|\s+$/g, '');
    var defOff = part.indexOf(def);
    var cStart = 0, cEnd = def.length;
    if (def.charAt(0) === '{') {
      var e = braceEnd(def, 0);
      if (e > 0) { def = def.slice(1, e); cStart = 1; cEnd = e; }
    } else if (def.charAt(0) === '[') {
      var e2 = def.lastIndexOf(']');
      if (e2 > 0) { def = def.slice(1, e2); cStart = 1; cEnd = e2; }
    }
    styles[name] = parseOpts(def);
    if (out) out.push({ name: name, start: seg.start + lead + defOff + cStart, end: seg.start + lead + defOff + cEnd });
  });
}

function expandTextMacros(t, macros) {
  t = String(t || '');
  t = t.replace(/\\strut|\\centering|\\raggedright|\\small|\\footnotesize|\\large|\\Large|\\bfseries|\\itshape|\\ttfamily|\\normalsize/g, '');
  if (macros) {
    Object.keys(macros).forEach(function (name) {
      t = t.replace(new RegExp('\\\\' + name + '(?![A-Za-z])', 'g'), macros[name].body);
    });
  }
  t = t.replace(/\\textbf\{([^}]*)\}/g, '$1').replace(/\\emph\{([^}]*)\}/g, '$1');
  t = t.replace(/\{\}/g, ''); // LaTeX 空组（如 \model{} 展开后残留）
  return mathToUnicode(t);
}

// 节点/标签中的 $...$ 轻量数学 → Unicode 近似（SVG text 无法承载 KaTeX HTML）
var GREEK = { alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω' };
var SUP = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', n: 'ⁿ', i: 'ⁱ' };
var SUB = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', n: 'ₙ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', x: 'ₓ', t: 'ₜ' };

function mathToUnicode(t) {
  return String(t).replace(/\$([^$]+)\$/g, function (_, m) {
    m = m.replace(/\\mathbf\{([A-Za-z0-9]+)\}/g, function (__, s) {
      return s.split('').map(function (c) {
        var map = { A: '𝐀', B: '𝐁', C: '𝐂', D: '𝐃', E: '𝐄', F: '𝐅', G: '𝐆', H: '𝐇', I: '𝐈', J: '𝐉', K: '𝐊', L: '𝐋', M: '𝐌', N: '𝐍', O: '𝐎', P: '𝐏', Q: '𝐐', R: '𝐑', S: '𝐒', T: '𝐓', U: '𝐔', V: '𝐕', W: '𝐖', X: '𝐗', Y: '𝐘', Z: '𝐙', a: '𝐚', b: '𝐛', c: '𝐜', d: '𝐝', e: '𝐞', f: '𝐟', g: '𝐠', h: '𝐡', i: '𝐢', j: '𝐣', k: '𝐤', l: '𝐥', m: '𝐦', n: '𝐧', o: '𝐨', p: '𝐩', q: '𝐪', r: '𝐫', s: '𝐬', t: '𝐭', u: '𝐮', v: '𝐯', w: '𝐰', x: '𝐱', y: '𝐲', z: '𝐳' };
        return map[c] || c;
      }).join('');
    });
    m = m.replace(/\\(alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Phi|Psi|Omega)\b/g, function (__, g) { return GREEK[g] || ''; });
    m = m.replace(/\^\{([^}]+)\}|\^(\w)/g, function (__, a, b) {
      var s = a || b, out = '';
      for (var i = 0; i < s.length; i++) out += SUP[s.charAt(i)] || s.charAt(i);
      return out;
    });
    m = m.replace(/_\{([^}]+)\}|_(\w)/g, function (__, a, b) {
      var s = a || b, out = '';
      for (var i = 0; i < s.length; i++) out += SUB[s.charAt(i)] || s.charAt(i);
      return out;
    });
    m = m.replace(/\\(?:frac)\{(\w)\}\{(\w)\}/g, '$1/$2').replace(/\\times\b/g, '×').replace(/\\leq\b/g, '≤').replace(/\\geq\b/g, '≥').replace(/\\neq\b/g, '≠').replace(/\\approx\b/g, '≈').replace(/\\rightarrow|\bto\b/g, '→').replace(/\\left|\\right|\\,|\\;|\\!/g, '');
    m = m.replace(/\\/g, '');
    return m;
  });
}

// ---------------- 路径 token ----------------
function tokenizePath(spec) {
  var toks = [], s = spec, i = 0;
  function paren(j) {
    var d = 0;
    for (var k = j; k < s.length; k++) {
      if (s.charAt(k) === '\\') { k++; continue; }
      if (s.charAt(k) === '(') d++;
      else if (s.charAt(k) === ')') { d--; if (d === 0) return k; }
    }
    return -1;
  }
  while (i < s.length) {
    i = skipWs(s, i);
    if (i >= s.length) break;
    var c = s.charAt(i);
    if (c === '(') {
      var e = paren(i);
      if (e < 0) { i++; continue; }
      toks.push({ t: 'pt', v: s.slice(i + 1, e) }); i = e + 1; continue;
    }
    if (s.startsWith('--', i)) { toks.push({ t: '--' }); i += 2; continue; }
    if (s.startsWith('|-', i)) { toks.push({ t: '|-' }); i += 2; continue; }
    if (s.startsWith('-|', i)) { toks.push({ t: '-|' }); i += 2; continue; }
    var w = s.slice(i).match(/^(to|edge|node|coordinate|rectangle|cycle|graph)\b/);
    if (w) {
      var word = w[1]; i += word.length;
      var tok = { t: word };
      i = skipWs(s, i);
      if (s.charAt(i) === '[') {
        var be = bracketEnd(s, i);
        if (be > 0) { tok.opts = s.slice(i + 1, be); i = be + 1; i = skipWs(s, i); }
      }
      if (word === 'node' || word === 'coordinate') {
        if (s.charAt(i) === '(') {
          var pe = paren(i);
          if (pe > 0) { tok.name = s.slice(i + 1, pe); i = pe + 1; i = skipWs(s, i); }
        }
        if (s.charAt(i) === '{') {
          var br = braceEnd(s, i);
          if (br > 0) { tok.text = s.slice(i + 1, br); i = br + 1; }
        }
      }
      toks.push(tok); continue;
    }
    i++;
  }
  return toks;
}

// ---------------- 主渲染 ----------------
function render(picBody, picOpts, base, ctx) {
  var warnings = [];
  function warn(m) { if (warnings.length < 40 && m) warnings.push(m); }
  ctx = ctx || {};
  var styles = {};
  Object.keys(ctx.styles || {}).forEach(function (k) { styles[k] = ctx.styles[k]; });
  if (!ctx.tikzsetRanges) ctx.tikzsetRanges = [];

  var picList = parseOpts(picOpts || '');
  var picInterp = interpret(picList);
  var scale = picInterp.scale && picInterp.scale > 0 ? picInterp.scale : 1;
  var globalDistCm = 1.2;
  picList.forEach(function (it) { if (it.k === 'node distance' && it.v) globalDistCm = parseLen(it.v, 'cm') / CM; });

  var svgNodes = [], svgEdges = [], svgLabels = [], markers = {}, markerSvg = [];
  var nodes = [], byName = {};
  var bboxes = []; // [x1,y1,x2,y2]

  function markBox(x1, y1, x2, y2) { bboxes.push([x1, y1, x2, y2]); }

  function mkMarker(color) {
    var key = color || '#000';
    if (!markers[key]) {
      var id = 'arw' + markerSvg.length;
      markers[key] = id;
      markerSvg.push('<marker id="' + id + '" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="strokeWidth"><path d="M0,0 L10,5 L0,10 L2.6,5 Z" fill="' + key + '"/></marker>');
    }
    return markers[key];
  }
  function dashAttr(kind) {
    var map = { dashed: '7,5', dense: '3,3', loose: '12,7', dotted: '2,4', densedot: '1,3' };
    return map[kind] ? ' stroke-dasharray="' + map[kind] + '"' : '';
  }

  function resolvePoint(tok) {
    tok = String(tok).replace(/\s+/g, '');
    if (/^-?[\d.]/.test(tok) && tok.indexOf(',') > 0) {
      var xy = tok.split(',');
      return { x: parseLen(xy[0], 'cm') * scale, y: -parseLen(xy[1], 'cm') * scale };
    }
    var di = tok.lastIndexOf('.');
    if (di > 0) {
      var nm = tok.slice(0, di), an = tok.slice(di + 1);
      var nd = byName[nm];
      if (nd) { var ap = anchorPoint(nd, an); if (ap) return ap; }
    }
    var n2 = byName[tok];
    if (n2) return { x: n2.cx, y: n2.cy, node: n2 };
    warn('无法解析坐标/节点: ' + tok);
    return null;
  }

  function anchorPoint(nd, an) {
    var w2 = nd.w / 2, h2 = nd.h / 2;
    var map = { north: [0, -h2], south: [0, h2], east: [w2, 0], west: [-w2, 0],
      'north east': [w2, -h2], 'north west': [-w2, -h2], 'south east': [w2, h2], 'south west': [-w2, h2], center: [0, 0] };
    if (map[an]) return { x: nd.cx + map[an][0], y: nd.cy + map[an][1] };
    if (/^\d+(\.\d+)?$/.test(an)) {
      var a = +an * Math.PI / 180;
      return borderPoint(nd, { x: nd.cx + Math.cos(a) * 1000, y: nd.cy - Math.sin(a) * 1000 });
    }
    return null;
  }

  function borderPoint(nd, toward) {
    var tx = toward.x - nd.cx, ty = toward.y - nd.cy;
    if (!tx && !ty) return { x: nd.cx, y: nd.cy };
    var hw = nd.w / 2, hh = nd.h / 2;
    if (nd.shape === 'circle' || nd.shape === 'ellipse') {
      var a = Math.atan2(ty / hh, tx / hw);
      return { x: nd.cx + Math.cos(a) * hw, y: nd.cy + Math.sin(a) * hh };
    }
    var sx = tx >= 0 ? 1 : -1, sy = ty >= 0 ? 1 : -1;
    if (Math.abs(tx) * hh > Math.abs(ty) * hw) {
      return { x: nd.cx + sx * hw, y: nd.cy + sy * Math.abs(ty) * hw / Math.abs(tx) };
    }
    return { x: nd.cx + sx * Math.abs(tx) * hh / Math.abs(ty), y: nd.cy + sy * hh };
  }

  var stmts = splitStatements(picBody);

  stmts.forEach(function (stmt, sidx) {
    var t = stmt.text.replace(/^\s+/, '');
    var abs = base + stmt.start;

    // ---- \tikzset ----
    if (/^\\tikzset\s*\{/.test(t)) {
      var bi = t.indexOf('{');
      var be = braceEnd(t, bi);
      if (be > 0) {
        var regs = [];
        parseTikzsetBody(t.slice(bi + 1, be), styles, regs);
        regs.forEach(function (r) {
          ctx.tikzsetRanges.push({ name: r.name, start: abs + bi + 1 + r.start, end: abs + bi + 1 + r.end });
        });
      }
      return;
    }

    // ---- \node / \coordinate ----
    var mNode = t.match(/^\\(node|coordinate)\b/);
    if (mNode) {
      var isCoord = mNode[1] === 'coordinate';
      var rest = t.slice(mNode[0].length);
      var stmtAbs = base + stmt.start + (stmt.text.match(/^\s+/) || [''])[0].length; // t 的绝对起点
      var i = skipWs(rest, 0);
      var optStr = null, optStart = -1, optEnd = -1;
      var optInsert = stmtAbs + mNode[0].length + i; // 可插入 [..] 的位置（\node 之后）
      if (rest.charAt(i) === '[') {
        var oe = bracketEnd(rest, i);
        if (oe > 0) {
          optStr = rest.slice(i + 1, oe);
          optStart = optInsert + 1; optEnd = optStart + optStr.length;
        }
        i = (oe > 0 ? oe : i) + 1;
      }
      i = skipWs(rest, i);
      var name = null;
      if (rest.charAt(i) === '(') {
        var pe = rest.indexOf(')', i);
        if (pe > 0) { name = rest.slice(i + 1, pe).replace(/\s/g, ''); i = pe + 1; }
      }
      i = skipWs(rest, i);
      var atTok = null, atStart = -1, atEnd = -1;
      var atInsert = stmtAbs + mNode[0].length + i; // 无 at 时可插入 " at (...)" 的位置
      if (/^at[\s(]/.test(rest.slice(i))) {
        atStart = stmtAbs + mNode[0].length + i;
        var afterAt = skipWs(rest, i + 2);
        if (rest.charAt(afterAt) === '(') {
          var ae = rest.indexOf(')', afterAt);
          if (ae > 0) { atTok = rest.slice(afterAt + 1, ae); i = ae + 1; atEnd = stmtAbs + mNode[0].length + i; }
        } else i = afterAt;
      }
      i = skipWs(rest, i);
      var textStr = '';
      if (rest.charAt(i) === '{') {
        var te = braceEnd(rest, i);
        if (te > 0) textStr = rest.slice(i + 1, te);
      }

      var list = optStr ? parseOpts(optStr) : [];
      var place = extractPlacement(list);
      var expanded = expandOpts(list, styles, 0);
      if (styles['every node']) expanded = styles['every node'].concat(expanded);
      var itp = interpret(expanded);
      var styleNames = list.filter(function (x) { return x.v === null && styles[x.k]; }).map(function (x) { return x.k; });
      var distCm = itp.nodeDistanceCm || globalDistCm;

      var cx = 0, cy = 0, placed = false;
      if (atTok) {
        var co = atTok.split(',');
        if (co.length >= 2) { cx = parseLen(co[0], 'cm') * scale; cy = -parseLen(co[1], 'cm') * scale; placed = true; }
      } else if (place) {
        var ref = byName[place.ref];
        if (ref) {
          var dd = (place.distCm !== null ? place.distCm : distCm) * CM * scale;
          cx = ref.cx + place.dir[0] * dd; cy = ref.cy + place.dir[1] * dd; placed = true;
        } else warn('定位失败: 找不到节点 ' + place.ref);
      }

      var fname = readFont(itp.fontVal, 13);
      var clean = expandTextMacros(textStr, ctx.macros);
      var lines = wrapText(clean, itp.textWidthPx, fname.size, fname.bold);
      var lh = fname.size * 1.32;
      var tw = 0; lines.forEach(function (l) { tw = Math.max(tw, measure(l, fname.size, fname.bold)); });
      var th = lines.length * lh;
      var innerSep = itp.innerSepPt !== null ? itp.innerSepPt * PT : fname.size * 0.55;
      var minW = Math.max(itp.minW, itp.minSize), minH = Math.max(itp.minH, itp.minSize);
      var shape = itp.shape || 'rectangle';
      var w, h;
      if (shape === 'circle') { var dia = Math.max(tw + innerSep * 2, th + innerSep * 2, minW, minH); w = h = dia; }
      else if (shape === 'ellipse') { w = Math.max((tw + innerSep * 2) * 1.4, minW); h = Math.max((th + innerSep * 2) * 1.35, minH); }
      else if (shape === 'diamond') { w = Math.max((tw + innerSep * 2) * 1.9, minW); h = Math.max((th + innerSep * 2) * 1.9, minH); }
      else { w = Math.max(tw + innerSep * 2, minW); h = Math.max(th + innerSep * 2, minH); }

      var node = {
        sidx: sidx, name: name, cx: cx, cy: cy, w: w, h: h, shape: shape,
        fill: itp.fill, draw: itp.draw, textColor: itp.textColor,
        lw: (itp.lineWidthPt || 0.4) * PT, dash: itp.dash,
        rounded: shape === 'rectangle' ? (itp.roundedPt !== null && itp.roundedPt !== undefined ? itp.roundedPt * PT : 0) : 0,
        lines: lines, fontpx: fname.size, bold: fname.bold, align: itp.align || 'center',
        innerSep: innerSep, opacity: itp.opacity, isCoord: isCoord,
        optStart: optStart, optEnd: optEnd, optInsert: optInsert,
        atStart: atStart, atEnd: atEnd, atInsert: atInsert, placed: placed,
        declaredMinW: itp.minW || itp.minSize || 0, declaredMinH: itp.minH || itp.minSize || 0
      };
      if (name) byName[name] = node;
      nodes.push(node);
      if (isCoord) return;

      var fillV = node.fill || 'none';
      var strokeV = (node.draw === undefined || node.draw === null) ? 'none' : (node.draw || '#000000');
      var common = 'fill="' + fillV + '" stroke="' + strokeV + '" stroke-width="' + node.lw.toFixed(2) + '"' +
        (node.dash ? dashAttr(node.dash) : '') + (node.opacity != null ? ' opacity="' + node.opacity + '"' : '');
      var x0 = cx - w / 2, y0 = cy - h / 2;
      var shapeSvg;
      if (shape === 'circle') shapeSvg = '<circle cx="' + f(cx) + '" cy="' + f(cy) + '" r="' + f(w / 2) + '" ' + common + '/>';
      else if (shape === 'ellipse') shapeSvg = '<ellipse cx="' + f(cx) + '" cy="' + f(cy) + '" rx="' + f(w / 2) + '" ry="' + f(h / 2) + '" ' + common + '/>';
      else if (shape === 'diamond') shapeSvg = '<polygon points="' + f(cx) + ',' + f(y0) + ' ' + f(cx + w / 2) + ',' + f(cy) + ' ' + f(cx) + ',' + f(cy + h / 2) + ' ' + f(cx - w / 2) + ',' + f(cy) + '" ' + common + '/>';
      else shapeSvg = '<rect x="' + f(x0) + '" y="' + f(y0) + '" width="' + f(w) + '" height="' + f(h) + '"' + (node.rounded ? ' rx="' + f(node.rounded) + '" ry="' + f(node.rounded) + '"' : '') + ' ' + common + '/>';
      var da = ' data-sidx="' + sidx + '"' + (name ? ' data-node="' + esc(name) + '"' : '');
      svgNodes.push('<g class="tk-node"' + da + '>' + shapeSvg +
        nodeText(lines, fname.size, fname.bold, node.align, cx, cy, w, innerSep, node.textColor, da) + '</g>');
      markBox(x0, y0, cx + w / 2, cy + h / 2);
      return;
    }

    // ---- \draw / \path / \fill / \filldraw ----
    var mDraw = t.match(/^\\(draw|path|fill|filldraw)\b/);
    if (mDraw) {
      var kind = mDraw[1];
      var drest = t.slice(mDraw[0].length);
      var di = skipWs(drest, 0);
      var doptStr = null;
      if (drest.charAt(di) === '[') {
        var doe = bracketEnd(drest, di);
        if (doe > 0) { doptStr = drest.slice(di + 1, doe); di = doe + 1; }
      }
      var dexp = expandOpts(doptStr ? parseOpts(doptStr) : [], styles, 0);
      var ditp = interpret(dexp);
      var strokeC = (ditp.draw === 'none') ? null : (ditp.draw || '#000000');
      if ((kind === 'fill' || kind === 'filldraw') && ditp.fill === null) ditp.fill = '#f2f2f2';
      if (kind === 'fill' && ditp.draw === undefined) strokeC = null;
      var lw = (ditp.lineWidthPt || 0.4) * PT;

      var toks = tokenizePath(drest.slice(di));
      var segs = [];
      var labelBuffer = [];
      var lastEntry = null;   // {p, nodeRef}
      var pendingConn = '--';
      var pendingTo = null;   // {opts, interp}

      function newSeg(a, b, kindS, extra) {
        var seg = { from: a.p, to: b.p, fromEntry: a, toEntry: b, kind: kindS, labels: labelBuffer.splice(0), extra: extra || {} };
        segs.push(seg);
      }

      for (var ti = 0; ti < toks.length; ti++) {
        var tk = toks[ti];
        if (tk.t === 'pt') {
          var np = resolvePoint(tk.v);
          if (!np) { pendingConn = '--'; pendingTo = null; continue; }
          var entry = { p: np, nodeRef: np.node || null };
          if (!lastEntry) { lastEntry = entry; continue; }
          if (pendingTo) {
            var pi = pendingTo.interp || {};
            var src = pi.bendDeg != null ? pi : (pi.outAng != null || pi.inAng != null) ? pi : ditp;
            var bi2 = { kind: 'line' };
            if (src.bendDeg != null) bi2 = { kind: 'bend', deg: src.bendDeg, dir: src.bendDir || 'left' };
            else if (src.outAng != null || src.inAng != null) bi2 = { kind: 'outin', out: src.outAng || 0, inn: src.inAng || 0 };
            newSeg(lastEntry, entry, bi2.kind, bi2);
            segs[segs.length - 1].segInterp = pendingTo.interp;
          } else {
            newSeg(lastEntry, entry, pendingConn === 'rect' ? 'rect' : pendingConn);
          }
          pendingConn = '--'; pendingTo = null;
          lastEntry = entry;
        } else if (tk.t === '--' || tk.t === '|-' || tk.t === '-|') {
          pendingConn = tk.t;
        } else if (tk.t === 'to' || tk.t === 'edge') {
          var toOpts = tk.opts ? parseOpts(tk.opts) : [];
          pendingTo = { opts: tk.opts || '', interp: interpret(expandOpts(toOpts, styles, 0)) };
        } else if (tk.t === 'node') {
          var lo = expandOpts(parseOpts(tk.opts || ''), styles, 0);
          var li = interpret(lo);
          labelBuffer.push({ text: expandTextMacros(tk.text || '', ctx.macros), interp: li, font: readFont(li.fontVal, 12) });
        } else if (tk.t === 'rectangle') {
          pendingConn = 'rect';
        }
      }

      // 端点吸附到节点边框
      segs.forEach(function (sg) {
        if (sg.kind === 'rect') return;
        var a = sg.from, b = sg.to;
        if (sg.fromEntry && sg.fromEntry.nodeRef && sg.toEntry && sg.toEntry.nodeRef === sg.fromEntry.nodeRef) { /* 自环: 保持 */ }
        else if (sg.fromEntry && sg.fromEntry.nodeRef) a = borderPoint(sg.fromEntry.nodeRef, b);
        if (sg.toEntry && sg.toEntry.nodeRef) b = borderPoint(sg.toEntry.nodeRef, a);
        sg.from = a; sg.to = b;
      });

      // 曲线控制点
      segs.forEach(function (sg) {
        if (sg.kind === 'bend') {
          var dx = sg.to.x - sg.from.x, dy = sg.to.y - sg.from.y;
          var len = Math.hypot(dx, dy) || 1;
          var lift = len * Math.tan((sg.extra.deg / 2) * Math.PI / 360); // 控制点偏移=2×矢高
          var nx = dy / len, ny = -dx / len;
          if (sg.extra.dir === 'right') { nx = -nx; ny = -ny; }
          sg.cp = { x: sg.from.x + dx / 2 + nx * lift, y: sg.from.y + dy / 2 + ny * lift };
        } else if (sg.kind === 'outin') {
          var len2 = Math.hypot(sg.to.x - sg.from.x, sg.to.y - sg.from.y) * 0.42;
          var o = (sg.extra.out || 0) * Math.PI / 180, inn = (sg.extra.inn || 0) * Math.PI / 180;
          sg.cp1 = { x: sg.from.x + len2 * Math.cos(o), y: sg.from.y - len2 * Math.sin(o) };
          sg.cp2 = { x: sg.to.x + len2 * Math.cos(Math.PI - inn), y: sg.to.y - len2 * Math.sin(Math.PI - inn) };
        }
      });

      var endArrow = ditp.arrowEnd, startArrow = ditp.arrowStart;

      segs.forEach(function (sg, si) {
        var a = sg.from, b = sg.to;
        var segStroke = strokeC, segLw = lw, segDash = ditp.dash;
        var sArrow = startArrow, eArrow = endArrow;
        if (sg.segInterp) {
          if (sg.segInterp.draw && sg.segInterp.draw !== 'none') segStroke = sg.segInterp.draw;
          if (sg.segInterp.lineWidthPt) segLw = sg.segInterp.lineWidthPt * PT;
          if (sg.segInterp.dash) segDash = sg.segInterp.dash;
          if (sg.segInterp.arrowEnd) eArrow = true;
          if (sg.segInterp.arrowStart) sArrow = true;
        }
        if (segStroke === null) { segStroke = '#000'; segLw = 0; }

        if (sg.kind === 'rect') {
          var rx = Math.min(a.x, b.x), ry = Math.min(a.y, b.y);
          svgEdges.push('<rect class="tk-edge" x="' + f(rx) + '" y="' + f(ry) + '" width="' + f(Math.abs(b.x - a.x)) + '" height="' + f(Math.abs(b.y - a.y)) + '" fill="' + (ditp.fill && ditp.fill !== 'none' ? ditp.fill : 'none') + '" stroke="' + (strokeC || '#000') + '" stroke-width="' + lw.toFixed(2) + '"' + (ditp.dash ? dashAttr(ditp.dash) : '') + '/>');
          markBox(rx, ry, Math.max(a.x, b.x), Math.max(a.y, b.y));
          return;
        }

        var d;
        if (sg.kind === 'bend') d = 'M ' + f(a.x) + ' ' + f(a.y) + ' Q ' + f(sg.cp.x) + ' ' + f(sg.cp.y) + ' ' + f(b.x) + ' ' + f(b.y);
        else if (sg.kind === 'outin') d = 'M ' + f(a.x) + ' ' + f(a.y) + ' C ' + f(sg.cp1.x) + ' ' + f(sg.cp1.y) + ' ' + f(sg.cp2.x) + ' ' + f(sg.cp2.y) + ' ' + f(b.x) + ' ' + f(b.y);
        else if (sg.kind === '|-') d = 'M ' + f(a.x) + ' ' + f(a.y) + ' L ' + f(a.x) + ' ' + f(b.y) + ' L ' + f(b.x) + ' ' + f(b.y);
        else if (sg.kind === '-|') d = 'M ' + f(a.x) + ' ' + f(a.y) + ' L ' + f(b.x) + ' ' + f(a.y) + ' L ' + f(b.x) + ' ' + f(b.y);
        else d = 'M ' + f(a.x) + ' ' + f(a.y) + ' L ' + f(b.x) + ' ' + f(b.y);

        var mkE = eArrow ? ' marker-end="url(#' + mkMarker(segStroke) + ')"' : '';
        var mkS = sArrow ? ' marker-start="url(#' + mkMarker(segStroke) + ')"' : '';
        svgEdges.push('<path class="tk-edge" d="' + d + '" fill="none" stroke="' + segStroke + '" stroke-width="' + segLw.toFixed(2) + '"' + (segDash ? dashAttr(segDash) : '') + mkE + mkS + '/>');
        markBox(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
        if (sg.cp) markBox(sg.cp.x, sg.cp.y, sg.cp.x, sg.cp.y);
        if (sg.cp1) markBox(sg.cp1.x, sg.cp1.y, sg.cp1.x, sg.cp1.y);
        if (sg.cp2) markBox(sg.cp2.x, sg.cp2.y, sg.cp2.x, sg.cp2.y);

        sg.labels.forEach(function (lb) {
          var pos = lb.interp.pos == null ? 0.5 : lb.interp.pos;
          var pt = pointOnSeg(sg, pos);
          var off = labelOffset(lb.interp.labelPlace, lb.font.size);
          var lx = pt.x + off.x, ly = pt.y + off.y;
          svgLabels.push('<text class="tk-elabel" x="' + f(lx) + '" y="' + f(ly) + '" text-anchor="middle" font-size="' + lb.font.size + '" stroke="#ffffff" stroke-width="3.5" paint-order="stroke" fill="' + (lb.interp.textColor || segStroke || '#333') + '">' + esc(lb.text) + '</text>');
          markBox(lx - lb.text.length * lb.font.size * 0.4, ly - lb.font.size, lx + lb.text.length * lb.font.size * 0.4, ly + 4);
        });
      });
      return;
    }

    if (/^\\(useasboundingbox|clip|scope|end\{|begin\{)/.test(t)) return;
    if (/^\\pgf/.test(t)) return;
    warn('TikZ 语句暂不支持: ' + t.slice(0, 50).replace(/\n/g, ' '));
  });

  var visNodes = nodes.filter(function (n) { return !n.isCoord; });
  if (!visNodes.length && !svgEdges.length) {
    return { svg: null, nodes: [], warnings: warnings.concat(['tikzpicture 中没有可渲染的节点或线条']) };
  }

  // ---- bbox ----
  var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  bboxes.forEach(function (b) {
    if (!isFinite(b[0])) return;
    minX = Math.min(minX, b[0]); minY = Math.min(minY, b[1]);
    maxX = Math.max(maxX, b[2]); maxY = Math.max(maxY, b[3]);
  });
  if (minX > maxX) { minX = 0; minY = 0; maxX = 200; maxY = 80; }
  var pad = 8;

  var svg = '<svg xmlns="http://www.w3.org/2000/svg" class="tk-svg" viewBox="' + f(minX - pad) + ' ' + f(minY - pad) + ' ' + f(maxX - minX + pad * 2) + ' ' + f(maxY - minY + pad * 2) + '" width="' + f(Math.min(maxX - minX + pad * 2, 860)) + '" style="max-width:100%;height:auto;font-family:' + FONT_FAMILY.replace(/"/g, '&quot;') + '">' +
    '<defs>' + markerSvg.join('') + '</defs>' +
    svgEdges.join('') + svgNodes.join('') + svgLabels.join('') + '</svg>';

  var panelNodes = visNodes.map(function (n) {
    return {
      sidx: n.sidx, name: n.name, text: n.lines.join(' / '),
      optStart: n.optStart, optEnd: n.optEnd, optInsert: n.optInsert, styles: n.styles,
      atStart: n.atStart, atEnd: n.atEnd, atInsert: n.atInsert, placed: n.placed,
      posCm: { x: +(n.cx / CM).toFixed(2), y: +(-n.cy / CM).toFixed(2) },
      sizeCm: { w: +(n.w / CM).toFixed(2), h: +(n.h / CM).toFixed(2) },
      declaredMinWcm: +((n.declaredMinW || 0) / CM).toFixed(2),
      declaredMinHcm: +((n.declaredMinH || 0) / CM).toFixed(2),
      fill: n.fill && n.fill !== 'none' ? n.fill : null,
      drawOn: !(n.draw === undefined || n.draw === null || n.draw === 'none'),
      draw: (n.draw && n.draw !== 'none') ? n.draw : '#000000',
      textColor: n.textColor, lwPt: +(n.lw / PT).toFixed(2), dash: n.dash || null,
      roundedPt: n.rounded ? +(n.rounded / PT).toFixed(1) : 0, shape: n.shape, fontpx: n.fontpx
    };
  });

  return { svg: svg, nodes: panelNodes, warnings: warnings };

  // ---- 内部工具 ----
  function nodeText(lines, fontpx, bold, align, cx, cy, w, innerSep, textColor, dataAttrs) {
    var lh = fontpx * 1.32;
    var n = lines.length;
    var y0 = cy - ((n - 1) * lh) / 2 + fontpx * 0.36;
    var anchor = 'middle', x = cx;
    if (align === 'left') { anchor = 'start'; x = cx - w / 2 + innerSep; }
    if (align === 'right') { anchor = 'end'; x = cx + w / 2 - innerSep; }
    var spans = lines.map(function (ln, i) {
      return '<tspan x="' + f(x) + '" dy="' + (i === 0 ? 0 : f(lh)) + '">' + esc(ln) + '</tspan>';
    }).join('');
    return '<text class="tk-label"' + dataAttrs + ' x="' + f(x) + '" y="' + f(y0) + '" text-anchor="' + anchor + '" font-size="' + fontpx + '" fill="' + (textColor || '#111') + '" font-weight="' + (bold ? '700' : '400') + '">' + spans + '</text>';
  }
  function labelOffset(place, fs) {
    var d = fs * 0.9 + 3;
    switch (place) {
      case 'above': return { x: 0, y: -d * 0.6 - 2 };
      case 'below': return { x: 0, y: d * 0.6 + fs * 0.5 };
      case 'left': return { x: -d, y: fs * 0.3 };
      case 'right': return { x: d, y: fs * 0.3 };
      case 'above left': return { x: -d, y: -d * 0.5 };
      case 'above right': return { x: d, y: -d * 0.5 };
      case 'below left': return { x: -d, y: d * 0.5 + fs * 0.3 };
      case 'below right': return { x: d, y: d * 0.5 + fs * 0.3 };
      default: return { x: 0, y: -3 };
    }
  }
  function pointOnSeg(sg, t) {
    var u = 1 - t;
    if (sg.kind === 'bend' && sg.cp) return { x: u * u * sg.from.x + 2 * u * t * sg.cp.x + t * t * sg.to.x, y: u * u * sg.from.y + 2 * u * t * sg.cp.y + t * t * sg.to.y };
    if (sg.kind === 'outin' && sg.cp1) return { x: u * u * u * sg.from.x + 3 * u * u * t * sg.cp1.x + 3 * u * t * t * sg.cp2.x + t * t * t * sg.to.x, y: u * u * u * sg.from.y + 3 * u * u * t * sg.cp1.y + 3 * u * t * t * sg.cp2.y + t * t * t * sg.to.y };
    if (sg.kind === '|-') return t < 0.5 ? { x: sg.from.x, y: sg.from.y + (sg.to.y - sg.from.y) * t * 2 } : { x: sg.from.x + (sg.to.x - sg.from.x) * (t - 0.5) * 2, y: sg.to.y };
    if (sg.kind === '-|') return t < 0.5 ? { x: sg.from.x + (sg.to.x - sg.from.x) * t * 2, y: sg.from.y } : { x: sg.to.x, y: sg.from.y + (sg.to.y - sg.from.y) * (t - 0.5) * 2 };
    return { x: sg.from.x + (sg.to.x - sg.from.x) * t, y: sg.from.y + (sg.to.y - sg.from.y) * t };
  }
}



export { render, parseOpts, buildOpts, setOpt, delOptAny, parseTikzsetBody, parseColor, colorToTikz, nearestNamed, interpret, SHAPES, DASH_KEYS, FONT_FAMILY, CM };

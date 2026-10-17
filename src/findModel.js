/**
 * 查找/替换的纯计算层：把查询串编译成正则、在整篇文本里收集匹配并映射回行列、
 * 展开替换串中的分组引用。这里不碰 CodeMirror，所以能脱离浏览器跑单测。
 */

/* 匹配上限：面板要显示总数并逐个跳转，再多就只是拖慢输入了 */
export const MAX_MATCHES = 5000;

/* 零宽匹配（如 ^、\b*）会让 exec 原地不动，收集时跳过 */
const SLASHED = /^\/([\s\S]+)\/([dgimsuy]*)$/;
const PLACEHOLDER = /\$(\$|&|`|'|\d{1,2}|<[^<>]*>|\{[^{}]*\})/g;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* 全词边界用 \p{L}\p{N} 而不是 \b：\b 只认 ASCII，中文词会被判成处处是边界 */
function withWordBoundary(source) {
  return `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
}

function flagSet(userFlags) {
  const set = new Set(['g']);
  for (const c of userFlags) if (c !== 'i' && c !== 'g' && c !== 'y') set.add(c);
  return set;
}

/** 编译查询串。返回 { pattern } 或 { pattern: null, error }；空查询返回 pattern:null 且不报错。 */
export function buildPattern(query, { regex = false, wholeWord = false, matchCase = false } = {}) {
  if (!query) return { pattern: null };
  let source = query, userFlags = '';
  if (regex) {
    const m = SLASHED.exec(query);
    if (m) { source = m[1]; userFlags = m[2]; }
  } else {
    source = escapeRe(query);
  }
  if (wholeWord) source = withWordBoundary(source);
  const flags = flagSet(userFlags);
  if (!matchCase) flags.add('i');
  if (wholeWord) flags.add('u');
  try {
    return { pattern: new RegExp(source, [...flags].join('')) };
  } catch (err) {
    return { pattern: null, error: String(err && err.message || err) };
  }
}

/** 在整篇文本上收集匹配（offset 区间 + 分组），超过 limit 时截断并置 truncated。 */
export function collectMatches(text, pattern, limit = MAX_MATCHES) {
  const matches = [];
  if (!pattern) return { matches, truncated: false };
  pattern.lastIndex = 0;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    if (m[0] === '') { pattern.lastIndex++; continue; }
    matches.push({ start: m.index, end: m.index + m[0].length, text: m[0], groups: m.slice(1), named: m.groups || null });
    if (matches.length >= limit) return { matches, truncated: true };
  }
  return { matches, truncated: false };
}

export function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** offset → CodeMirror 位置。走二分：每次重算要转换上千个匹配。 */
export function posFromOffset(starts, offset) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return { line: lo, ch: offset - starts[lo] };
}

export function offsetFromPos(starts, pos) {
  const line = Math.max(0, Math.min(starts.length - 1, pos.line | 0));
  return starts[line] + Math.max(0, pos.ch | 0);
}

export function toPositions(starts, matches) {
  return matches.map(m => ({ ...m, from: posFromOffset(starts, m.start), to: posFromOffset(starts, m.end) }));
}

/** 从锚点往后找第一个匹配；都排在锚点前面就回绕到 0（跳转是循环的）。 */
export function pickIndex(matches, anchor) {
  if (!matches.length) return -1;
  if (anchor === null || anchor === undefined) return 0;
  const i = matches.findIndex(m => m.start >= anchor);
  return i === -1 ? 0 : i;
}

export function stepIndex(index, delta, count) {
  if (!count) return -1;
  if (index < 0) return delta > 0 ? 0 : count - 1;
  return (index + delta + count) % count;
}

const isUpper = s => /[A-Z]/.test(s) && s === s.toUpperCase();
const isCapitalized = s => /^[A-Z]/.test(s) && s.slice(1) === s.slice(1).toLowerCase();

/* 只改写替换串里的字面量，分组引用原样带出，避免 ${name} 被大写化、$1 内容被强制改case */
function keepCase(literal, sample, preserveCase) {
  if (!preserveCase || !literal) return literal;
  if (isUpper(sample)) return literal.toUpperCase();
  if (isCapitalized(sample)) return literal.charAt(0).toUpperCase() + literal.slice(1);
  return literal;
}

function resolvePlaceholder(token, match, before, after) {
  if (token === '$') return '$';
  if (token === '&') return match.text;
  if (token === '`') return before;
  if (token === "'") return after;
  const first = token[0];
  if (first === '<' || first === '{') {
    const name = token.slice(1, -1);
    if (match.named && Object.prototype.hasOwnProperty.call(match.named, name)) return match.named[name] ?? '';
    return '$' + token;
  }
  const n = parseInt(token, 10);
  if (!n) return '$' + token;                       // $0 不是分组，按原样保留
  const g = match.groups[n - 1];
  return g === undefined || g === null ? '' : g;
}

/** 计算某个匹配对应的替换文本（支持 $1 / $<name> / ${name} / $& / $` / $' 与保留大小写）。 */
export function replacementText(repl, match, { preserveCase = false, before = '', after = '' } = {}) {
  if (!repl) return '';
  let out = '', last = 0, p;
  PLACEHOLDER.lastIndex = 0;
  while ((p = PLACEHOLDER.exec(repl)) !== null) {
    out += keepCase(repl.slice(last, p.index), match.text, preserveCase);
    out += resolvePlaceholder(p[1], match, before, after);
    last = p.index + p[0].length;
  }
  out += keepCase(repl.slice(last), match.text, preserveCase);
  return out;
}

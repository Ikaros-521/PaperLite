/* PaperLite · LaTeX 静态语法检测（行号级诊断，Node 可单测）
 * 返回 [{ line, msg, severity: 'error'|'warn', kind }]，line 为 0 起。
 * 文案经 i18n 模块级 t() 输出（App 渲染时同步当前语言；Node 测试默认中文）。
 */
import { t } from '../i18n.js';
import { resolveLayout } from './classLayout.js';

// 未闭合环境栈的天花板：真论文几十层就已是异常文档，而栈深直接决定每次 \end
// 错配的扫描代价，也决定末尾「未闭合」诊断条数。超出后不再入栈，只保留已报的错。
const MAX_ENV_STACK = 200;

// 逐字区（verbatim/lstlisting/minted 环境内部与 \verb 定界符内）不参与任何语法判断：
// 里面写 `if (x) { … } // 50%` 是教学示例的正常内容，按 TeX 语法去数花括号/$/\item
// 只会误报，而预览照原样渲染 —— 两边互相打脸。等长空格替换，行号与偏移不受影响。
function blankVerbatim(s) {
  const arr = s.split('');
  const blank = (from, to) => {
    for (let i = Math.max(0, from); i < Math.min(to, arr.length); i++) if (arr[i] !== '\n') arr[i] = ' ';
  };
  let m;
  const envRe = /\\begin\s*\{(verbatim\*?|lstlisting|minted)\}(?:\s*\{[^}]*\})?/g;
  while ((m = envRe.exec(s))) {
    const bodyStart = m.index + m[0].length;
    const close = s.indexOf('\\end{' + m[1] + '}', bodyStart);
    // 未闭合的逐字环境：正文一路遮到文末（环境配对检查自己会在 \begin 处报未闭合）
    blank(bodyStart, close < 0 ? s.length : close);
    if (close < 0) break;
    envRe.lastIndex = close;
  }
  const verbRe = /\\(?:verb|lstinline)\*?\s*([^\s\\{}a-zA-Z])/g;
  while ((m = verbRe.exec(s))) {
    const bodyStart = m.index + m[0].length;
    const eol = s.indexOf('\n', bodyStart);
    const end = s.indexOf(m[1], bodyStart);
    // 定界符没在本行闭合 = 写错了，交给别的检查报，别把后文整段吞掉
    if (end < 0 || (eol >= 0 && end > eol)) continue;
    blank(bodyStart, end);
    verbRe.lastIndex = end + 1;
  }
  return arr.join('');
}

export function lintLaTeX(src) {
  const out = [];
  const text = String(src || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  // 预处理：等长抹除注释（\% 转义不算），保留换行；逐字区内部一并遮掉
  const clean = blankVerbatim(lines.map(l => {
    let res = '', bs = 0;
    for (let i = 0; i < l.length; i++) {
      const c = l.charAt(i);
      if (c === '\\') { bs++; res += c; continue; }
      if (c === '%' && bs % 2 === 0) { res += ' '.repeat(l.length - i); return res; }
      bs = 0; res += c;
    }
    return res;
  }).join('\n'));
  const cleanLines = clean.split('\n');
  // 行首偏移表 + 二分定位：命中处求行号从 O(n) 降到 O(log n)，长文不再二次方
  const lineStarts = [0];
  for (let i = 0; i < clean.length; i++) if (clean.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineAt = (off) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1; }
    return lo;
  };

  // 1) 环境配对
  const stack = [];
  const envRe = /\\(begin|end)\s*\{([^}]+)\}/g;
  let m;
  while ((m = envRe.exec(clean))) {
    const line = lineAt(m.index);
    if (m[1] === 'begin') { if (stack.length < MAX_ENV_STACK) stack.push({ name: m[2], line }); }
    else {
      const top = stack[stack.length - 1];
      if (!top) out.push({ line, msg: t('lint.envNoBegin', { name: m[2] }), severity: 'error', kind: 'env' });
      else if (top.name !== m[2]) {
        out.push({ line, msg: t('lint.envMismatch', { name: top.name, line: top.line + 1, end: m[2] }), severity: 'error', kind: 'env' });
        // 尝试从栈中找回匹配：原地倒序扫，别 [...stack].reverse().findIndex() ——
        // 名字找不到时栈不会缩短，成批错配（截断/损坏的文件）会退化成二次方
        let idx = -1;
        for (let si = stack.length - 1; si >= 0; si--) if (stack[si].name === m[2]) { idx = si; break; }
        if (idx >= 0) stack.splice(idx, 1);
      } else stack.pop();
    }
  }
  stack.forEach(s => out.push({ line: s.line, msg: t('lint.envUnclosed', { name: s.name }), severity: 'error', kind: 'env' }));

  // 2) 花括号配对（全文净深度；负值即报错行）
  let depth = 0;
  for (let li = 0; li < lines.length; li++) {
    const l = cleanLines[li];
    let bs = 0;
    for (let i = 0; i < l.length; i++) {
      const c = l.charAt(i);
      if (c === '\\') { bs++; continue; }
      if (bs % 2 === 0) {
        if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth < 0) { out.push({ line: li, msg: t('lint.extraBrace'), severity: 'error', kind: 'brace' }); depth = 0; }
        }
      }
      bs = 0;
    }
  }
  if (depth > 0) out.push({ line: Math.max(0, lines.length - 1), msg: t('lint.missingBraces', { n: depth }), severity: 'error', kind: 'brace' });

  // 3) 行内 $ 配对（逐行粗查，$$ 视为一对）
  for (let li = 0; li < lines.length; li++) {
    const l = cleanLines[li];
    let count = 0, bs = 0;
    for (let i = 0; i < l.length; i++) {
      const c = l.charAt(i);
      if (c === '\\') { bs++; continue; }
      if (c === '$' && bs % 2 === 0) count++;
      bs = 0;
    }
    if (count % 2 !== 0) out.push({ line: li, msg: t('lint.oddDollar'), severity: 'warn', kind: 'math' });
  }

  // 4) 未定义引用
  const labels = new Set();
  const bibs = new Set();
  let labRe = /\\label\{([^}]+)\}/g;
  while ((m = labRe.exec(clean))) labels.add(m[1].trim());
  let bibRe = /\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
  while ((m = bibRe.exec(clean))) bibs.add(m[1].trim());
  // 文档确实引用了外部文件（\input 子文件、\bibliography/.bib）时，符号表不在这篇里，
  // 断言「引用不存在」只会把真问题淹掉；单文件文档照旧严格检查（走查 audit-15）
  const pullsExternal = /\\(?:input|include|subfile|subfileinclude|import|subimport|bibliography|addbibresource)\s*[{[]/.test(clean);
  const checkRef = !pullsExternal || labels.size > 0;
  const checkCite = !pullsExternal || bibs.size > 0;
  let refRe = /\\(ref|eqref|autoref|cref|Cref)\{([^}]+)\}/g;
  while ((m = refRe.exec(clean))) {
    const key = m[2].trim();
    if (checkRef && !labels.has(key)) {
      const line = lineAt(m.index);
      out.push({ line, msg: t('lint.badRef', { key }), severity: 'warn', kind: 'ref' });
    }
  }
  // \cite[..]{..} 手扫代替 (?:\[[^\]]*\])?\s*\{([^}]*)\}：缺右界时 [^\]]* 与 [^}]*
  // 会对每个候选把余文重扫一遍（\cite[a ×16000 实测 1.0s）。水位线记录「此后已无 ] / }」，
  // 后续候选直接照结论跳过，整轮回到线性。
  let citeRe = /\\cite[pt]?(?![A-Za-z])/g;
  let noOpt = -1, noArg = -1;
  const skipWs = (s, i) => { while (i < s.length && /\s/.test(s.charAt(i))) i++; return i; };
  while ((m = citeRe.exec(clean))) {
    if (!checkCite) continue;
    let p = skipWs(clean, m.index + m[0].length);
    if (clean.charAt(p) === '[' && !(noOpt >= 0 && p >= noOpt)) {
      const ce = clean.indexOf(']', p + 1);
      if (ce < 0) noOpt = p; else p = skipWs(clean, ce + 1);
    }
    if (clean.charAt(p) !== '{') continue;
    if (noArg >= 0 && p >= noArg) continue;
    const ae = clean.indexOf('}', p + 1);
    if (ae < 0) { noArg = p; continue; }
    const line = lineAt(m.index);
    clean.slice(p + 1, ae).split(',').map(s => s.trim()).filter(Boolean).forEach(key => {
      if (!bibs.has(key)) out.push({ line, msg: t('lint.badCite', { key }), severity: 'warn', kind: 'cite' });
    });
  }

  // 5) \item 出现在列表环境外
  const listDepth = [];
  let itemEnvRe = /\\begin\{(itemize|enumerate|description)\}|\\end\{(itemize|enumerate|description)\}|\\item(?![A-Za-z])/g;
  let inList = 0;
  while ((m = itemEnvRe.exec(clean))) {
    if (m[1]) inList++;
    else if (m[2]) inList = Math.max(0, inList - 1);
    else if (inList === 0) {
      const line = lineAt(m.index);
      out.push({ line, msg: t('lint.itemOutside'), severity: 'warn', kind: 'item' });
    }
  }

  // 6) 文档类与排版选项：\documentclass 只能有一个，互斥选项要指出
  const clsRe = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}/g;
  const clsHits = [];
  while ((m = clsRe.exec(clean))) clsHits.push(m);
  clsHits.slice(1).forEach(cm => out.push({ line: lineAt(cm.index), msg: t('lint.dupDocumentclass'), severity: 'error', kind: 'class' }));
  if (clsHits.length) {
    const cm = clsHits[0];
    const om = cm[0].match(/\[([^\]]*)\]/);
    const options = (om ? om[1] : '').split(',').map(s => s.trim()).filter(Boolean);
    const lay = resolveLayout((cm[0].match(/\{([^{}]*)\}/) || [, ''])[1].trim(), options);
    lay.conflicts.forEach(c => out.push({ line: lineAt(cm.index), msg: t('lint.classOptionConflict', { a: c.a, b: c.b }), severity: 'warn', kind: 'class' }));
  }

  // 去重 & 排序（按行）
  const seen = new Set();
  return out
    .filter(d => { const k = d.line + '|' + d.msg; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.line - b.line)
    .slice(0, 100);
}

/* PaperLite · LaTeX 静态语法检测（行号级诊断，Node 可单测）
 * 返回 [{ line, msg, severity: 'error'|'warn', kind }]，line 为 0 起。
 * 文案经 i18n 模块级 t() 输出（App 渲染时同步当前语言；Node 测试默认中文）。
 */
import { t } from '../i18n.js';
import { resolveLayout } from './classLayout.js';

export function lintLaTeX(src) {
  const out = [];
  const text = String(src || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  // 预处理：等长抹除注释（\% 转义不算），保留换行
  const clean = lines.map(l => {
    let res = '', bs = 0;
    for (let i = 0; i < l.length; i++) {
      const c = l.charAt(i);
      if (c === '\\') { bs++; res += c; continue; }
      if (c === '%' && bs % 2 === 0) { res += ' '.repeat(l.length - i); return res; }
      bs = 0; res += c;
    }
    return res;
  }).join('\n');
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
    if (m[1] === 'begin') stack.push({ name: m[2], line });
    else {
      const top = stack[stack.length - 1];
      if (!top) out.push({ line, msg: t('lint.envNoBegin', { name: m[2] }), severity: 'error', kind: 'env' });
      else if (top.name !== m[2]) {
        out.push({ line, msg: t('lint.envMismatch', { name: top.name, line: top.line + 1, end: m[2] }), severity: 'error', kind: 'env' });
        // 尝试从栈中找回匹配
        const idx = [...stack].reverse().findIndex(s => s.name === m[2]);
        if (idx >= 0) stack.splice(stack.length - 1 - idx, 1);
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
  let citeRe = /\\cite[pt]?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
  while ((m = citeRe.exec(clean))) {
    if (!checkCite) continue;
    const line = lineAt(m.index);
    m[1].split(',').map(s => s.trim()).filter(Boolean).forEach(key => {
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

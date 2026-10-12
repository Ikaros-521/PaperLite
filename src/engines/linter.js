/* PaperLite · LaTeX 静态语法检测（行号级诊断，Node 可单测）
 * 返回 [{ line, msg, severity: 'error'|'warn', kind }]，line 为 0 起。
 */
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

  // 1) 环境配对
  const stack = [];
  const envRe = /\\(begin|end)\s*\{([^}]+)\}/g;
  let m;
  while ((m = envRe.exec(clean))) {
    const line = clean.slice(0, m.index).split('\n').length - 1;
    if (m[1] === 'begin') stack.push({ name: m[2], line });
    else {
      const top = stack[stack.length - 1];
      if (!top) out.push({ line, msg: `\\end{${m[2]}} 没有对应的 \\begin`, severity: 'error', kind: 'env' });
      else if (top.name !== m[2]) {
        out.push({ line, msg: `环境不匹配：\\begin{${top.name}}（第 ${top.line + 1} 行）被 \\end{${m[2]}} 关闭`, severity: 'error', kind: 'env' });
        // 尝试从栈中找回匹配
        const idx = [...stack].reverse().findIndex(s => s.name === m[2]);
        if (idx >= 0) stack.splice(stack.length - 1 - idx, 1);
      } else stack.pop();
    }
  }
  stack.forEach(s => out.push({ line: s.line, msg: `环境 ${s.name} 未关闭（\\begin 在此行）`, severity: 'error', kind: 'env' }));

  // 2) 花括号配对（全文净深度；负值即报错行）
  let depth = 0;
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    let bs = 0;
    for (let i = 0; i < l.length; i++) {
      const c = l.charAt(i);
      if (c === '\\') { bs++; i++; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth < 0) { out.push({ line: li, msg: '多余的 `}`（花括号不配对）', severity: 'error', kind: 'brace' }); depth = 0; }
      }
      bs = 0;
    }
  }
  if (depth > 0) out.push({ line: Math.max(0, lines.length - 1), msg: '文档末尾缺少 ' + depth + ' 个闭合花括号 }', severity: 'error', kind: 'brace' });

  // 3) 行内 $ 配对（逐行粗查，$$ 视为一对）
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    let count = 0, bs = 0;
    for (let i = 0; i < l.length; i++) {
      const c = l.charAt(i);
      if (c === '\\') { bs++; i++; continue; }
      if (c === '$' && bs % 2 === 0) count++;
      bs = 0;
    }
    if (count % 2 !== 0) out.push({ line: li, msg: '本行 $ 数量为奇数（数学环境可能未闭合，或跨行公式请用 \\[ \\] / equation）', severity: 'warn', kind: 'math' });
  }

  // 4) 未定义引用
  const labels = new Set();
  const bibs = new Set();
  let labRe = /\\label\{([^}]+)\}/g;
  while ((m = labRe.exec(clean))) labels.add(m[1].trim());
  let bibRe = /\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
  while ((m = bibRe.exec(clean))) bibs.add(m[1].trim());
  let refRe = /\\(ref|eqref|autoref|cref|Cref)\{([^}]+)\}/g;
  while ((m = refRe.exec(clean))) {
    const key = m[2].trim();
    if (!labels.has(key)) {
      const line = clean.slice(0, m.index).split('\n').length - 1;
      out.push({ line, msg: `引用了未定义的标签「${key}」（缺少 \\label{${key}}）`, severity: 'warn', kind: 'ref' });
    }
  }
  let citeRe = /\\cite[pt]?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
  while ((m = citeRe.exec(clean))) {
    const line = clean.slice(0, m.index).split('\n').length - 1;
    m[1].split(',').map(s => s.trim()).filter(Boolean).forEach(key => {
      if (!bibs.has(key)) out.push({ line, msg: `引用了不存在的文献「${key}」（thebibliography 中无此 \\bibitem）`, severity: 'warn', kind: 'cite' });
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
      const line = clean.slice(0, m.index).split('\n').length - 1;
      out.push({ line, msg: '\\item 出现在列表环境之外', severity: 'warn', kind: 'item' });
    }
  }

  // 去重 & 排序（按行）
  const seen = new Set();
  return out
    .filter(d => { const k = d.line + '|' + d.msg; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.line - b.line)
    .slice(0, 100);
}

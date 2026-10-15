// Keep every quick insertion in one undo step and select its editable placeholder.
export function replaceTemplate(cm, before, content, after = '') {
  const start = cm.indexFromPos(cm.getCursor('from'));
  cm.replaceSelection(before + content + after, 'end', 'quick-insert');
  cm.setSelection(cm.posFromIndex(start + before.length), cm.posFromIndex(start + before.length + content.length));
  cm.focus();
}

export function inMath(source) {
  let delimiter = null;
  for (const match of source.matchAll(/%[^\n]*|\\begin\{(equation\*?|align\*?|gather\*?|math|displaymath)\}|\\end\{(?:equation\*?|align\*?|gather\*?|math|displaymath)\}|\\[\s\S]|\$\$?/g)) {
    const token = match[0];
    if (token.startsWith('%')) continue;
    if (token.startsWith('\\begin')) delimiter = 'environment';
    else if (token.startsWith('\\end')) delimiter = null;
    else if (token === '\\[' || token === '\\(') delimiter = token;
    else if (token === '\\]' || token === '\\)') delimiter = null;
    else if (token === '$' || token === '$$') delimiter = delimiter === token ? null : delimiter || token;
  }
  return !!delimiter;
}

export function quickInsert(cm, id, value, { markdown = false, text = 'text' } = {}) {
  if (!cm) return false;
  const selected = cm.getSelection();
  const math = () => inMath(cm.getValue().slice(0, cm.indexFromPos(cm.getCursor('from'))));
  const wrap = (before, after, placeholder = '') => replaceTemplate(cm, before, selected || placeholder, after);
  const formats = markdown
    ? { tB: ['**', '**'], tI: ['*', '*'], tU: ['<u>', '</u>'], tTt: ['`', '`'] }
    : { tB: ['\\textbf{', '}'], tI: ['\\emph{', '}'], tU: ['\\underline{', '}'], tTt: ['\\texttt{', '}'] };
  if (formats[id]) { wrap(...formats[id]); return true; }
  if (['tSec', 'tSub', 'tSubSub'].includes(id)) {
    const level = ['tSec', 'tSub', 'tSubSub'].indexOf(id);
    const prefix = cm.getCursor('from').ch ? '\n' : '';
    wrap(prefix + (markdown ? '#'.repeat(level + 1) + ' ' : '\\' + ['section', 'subsection', 'subsubsection'][level] + '{'), markdown ? '\n' : '}\n', text);
  } else if (id === 'tMath') wrap('$', '$');
  else if (id === 'tEq') wrap(markdown ? '\n$$\n' : '\n\\begin{equation}\n', markdown ? '\n$$\n' : '\n\\end{equation}\n');
  else if (id === 'tAlign') wrap(markdown ? '\n$$\n\\begin{aligned}\n' : '\n\\begin{align}\n', markdown ? '\n\\end{aligned}\n$$\n' : '\n\\end{align}\n', 'a &= b + c \\\\\nd &= e + f');
  else if (id === 'tFrac' || id === 'tSqrt') {
    const delimiter = math() ? '' : '$';
    wrap(delimiter + (id === 'tFrac' ? '\\frac{' : '\\sqrt{'), (id === 'tFrac' ? '}{b}' : '}') + delimiter, id === 'tFrac' ? 'a' : 'x');
  }
  else if (id === 'tSymbol') {
    const delimiter = math() ? '' : '$';
    replaceTemplate(cm, delimiter, value, delimiter);
  } else if (id === 'tLink') {
    const url = String(value).trim().replace(/([{}%#&_$])/g, '\\$1');
    cm.operation(() => {
      const source = cm.getValue().replace(/(?<!\\)%[^\n]*/g, '');
      if (!markdown && !/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\s*\{[^}]*\bhyperref\b/.test(source)) {
        const begin = cm.getValue().search(/^[ \t]*\\begin\s*\{document\}/m);
        if (begin >= 0) cm.replaceRange('\\usepackage{hyperref}\n', cm.posFromIndex(begin), undefined, 'quick-insert');
      }
      wrap(markdown ? '[' : '\\href{' + url + '}{', markdown ? '](' + String(value).trim().replace(/[\s()]/g, encodeURIComponent) + ')' : '}', text);
    });
  } else if (id === 'tLabel' || id === 'tRef') replaceTemplate(cm, '\\' + (id === 'tLabel' ? 'label' : 'ref') + '{', value || 'sec:label', '}');
  else if (id === 'tComment') {
    const from = cm.getCursor('from'), to = cm.getCursor('to');
    const endLine = to.line > from.line && to.ch === 0 ? to.line - 1 : to.line;
    const lines = Array.from({ length: endLine - from.line + 1 }, (_, i) => cm.getLine(from.line + i));
    const uncomment = lines.every(line => /^\s*%/.test(line));
    const result = lines.map(line => uncomment ? line.replace(/^(\s*)% ?/, '$1') : '% ' + line).join('\n');
    cm.replaceRange(result, { line: from.line, ch: 0 }, { line: endLine, ch: lines.at(-1).length }, '+input');
    cm.focus();
  } else if (id === 'tList' || id === 'tEnum') {
    const items = (selected || text).split('\n');
    const environment = id === 'tList' ? 'itemize' : 'enumerate';
    replaceTemplate(cm, '\n' + (markdown ? '' : '\\begin{' + environment + '}\n'), items.map((line, i) => (markdown ? (id === 'tList' ? '- ' : `${i + 1}. `) : '  \\item ') + line).join('\n'), markdown ? '\n' : '\n\\end{' + environment + '}\n');
  } else if (id === 'tGridTable') {
    const { rows, cols } = value;
    const row = Array.from({ length: cols }, (_, i) => `${text} ${i + 1}`);
    const body = Array.from({ length: rows }, () => row.join(' & ') + ' \\\\').join('\n');
    replaceTemplate(cm, markdown ? '\n' : '\n\\begin{tabular}{' + 'l'.repeat(cols) + '}\n\\hline\n', markdown ? '| ' + row.join(' | ') + ' |\n| ' + row.map(() => '---').join(' | ') + ' |\n' + Array.from({ length: rows - 1 }, () => '| ' + row.join(' | ') + ' |').join('\n') : body, markdown ? '\n' : '\n\\hline\n\\end{tabular}\n');
  } else return false;
  return true;
}

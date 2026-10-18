/* PaperLite · LaTeX 命令 / 环境 / 文件名补全（纯逻辑）
 *
 * 编辑器在 change(+input) 时取光标前的行文本，依次匹配四类上下文：
 *   1) \ref / \cite 键位 —— 在 projectIndex.js，EditorPane 单独接
 *   2) \begin{ 环境名
 *   3) \input / \includegraphics / \bibliography 等文件参数
 *   4) \command 命令（内置表 + 文档内 \newcommand 合并）
 * 无 React/DOM 依赖，Node 可直接单测；候选的插入动作（光标落点、环境闭合）在 EditorPane 侧。
 */

// 常用环境（含 PaperLite 排版引擎与内置 XeLaTeX 收录的期刊排版环境）
export const ENVIRONMENTS = [
  'abstract', 'align', 'align*', 'algorithm', 'algorithmic', 'cases', 'center',
  'description', 'document', 'enumerate', 'equation', 'equation*', 'figure', 'figure*',
  'flushleft', 'flushright', 'gather', 'gather*', 'IEEEbiography', 'IEEEkeywords',
  'IEEEproof', 'itemize', 'lstlisting', 'mermaid', 'minipage', 'multline', 'quote',
  'split', 'subequations', 'table', 'table*', 'tabular', 'tabular*', 'theorem',
  'tikzpicture', 'verbatim', 'verse',
];

/* 内置命令表：[名字, 模板后缀]。后缀追加在名字后面，'{}' 表示补全后光标停在花括号内，
 * '[]{ }' 这类带可选参数的模板只保证第一个插入点。空后缀 = 无参数命令。 */
export const COMMANDS = [
  ['textbf', '{}'], ['textit', '{}'], ['emph', '{}'], ['underline', '{}'],
  ['texttt', '{}'], ['textsc', '{}'], ['textrm', '{}'], ['textsf', '{}'], ['text', '{}'],
  ['section', '{}'], ['subsection', '{}'], ['subsubsection', '{}'], ['paragraph', '{}'],
  ['section*', '{}'], ['subsection*', '{}'],
  ['title', '{}'], ['author', '{}'], ['date', '{}'], ['maketitle', ''], ['tableofcontents', ''],
  ['label', '{}'], ['ref', '{}'], ['eqref', '{}'], ['autoref', '{}'], ['cref', '{}'], ['Cref', '{}'],
  ['cite', '{}'], ['citep', '{}'], ['citet', '{}'], ['footnote', '{}'],
  ['item', ''], ['item[]', ''], ['caption', '{}'], ['centering', ''],
  ['usepackage', '{}'], ['documentclass', '{}'], ['newcommand', '{}'], ['renewcommand', '{}'],
  ['begin', '{}'], ['end', '{}'],
  ['input', '{}'], ['include', '{}'], ['includegraphics', '[]{ }'], ['graphicspath', '{}'],
  ['bibliography', '{}'], ['bibliographystyle', '{}'], ['addbibresource', '{}'], ['printbibliography', ''],
  ['url', '{}'], ['href', '[]{ }'], ['verb', ''], ['lstinline', ''],
  ['frac', '{}{ }'], ['dfrac', '{}{ }'], ['tfrac', '{}{ }'], ['sqrt', '[]{}'],
  ['sum', ''], ['prod', ''], ['int', ''], ['iint', ''], ['oint', ''],
  ['lim', ''], ['infty', ''], ['partial', ''], ['nabla', ''],
  ['mathbf', '{}'], ['mathit', '{}'], ['mathrm', '{}'], ['mathcal', '{}'], ['mathbb', '{}'], ['mathsf', '{}'],
  ['hat', '{}'], ['bar', '{}'], ['vec', '{}'], ['tilde', '{}'], ['overline', '{}'], ['underline', '{}'],
  ['substack', '{}'], ['overset', '{}{ }'], ['underset', '{}{ }'], ['binom', '{}{ }'],
  ['left', ''], ['right', ''], ['bigl', ''], ['bigr', ''], ['Bigl', ''], ['Bigr', ''],
  ['hspace', '{}'], ['vspace', '{}'], ['quad', ''], ['qquad', ''],
  ['newpage', ''], ['clearpage', ''], ['linebreak', ''], ['newline', ''], ['noindent', ''],
  ['footnotesize', ''], ['small', ''], ['large', ''], ['Large', ''], ['huge', ''], ['Huge', ''],
  ['theoremstyle', '{}'], ['newtheorem', '{}'], ['captionsetup', '{}'],
];

/** 从若干文档源码里收集 \newcommand / \renewcommand / \DeclareMathOperator 定义的命令名 */
export function collectUserCommands(texts) {
  const out = new Set();
  const push = m => { if (m[1]) out.add(m[1]); };
  for (const text of texts || []) {
    // 抹掉未转义 % 后的注释：被注释掉的定义不该进候选（与 lint/QuickTools 同款规则）
    const src = String(text || '').replace(/(?<!\\)%[^\n]*/g, '');
    let m;
    const re1 = /\\(?:re)?newcommand\*?\s*\{\s*\\([a-zA-Z]+)/g;
    while ((m = re1.exec(src))) push(m);
    const re2 = /\\(?:re)?newcommand\*?\s*\\([a-zA-Z]+)/g;
    while ((m = re2.exec(src))) push(m);
    const re3 = /\\DeclareMathOperator\*?\s*\{\s*\\([a-zA-Z]+)/g;
    while ((m = re3.exec(src))) push(m);
  }
  return [...out];
}

/** 命令候选：内置表 + 用户命令合并，按前缀过滤；startsWith 优先、再按字典序，封顶 40 条 */
export function commandCandidates(token, userCommands) {
  const q = String(token || '').toLowerCase();
  const seen = new Set();
  const items = [];
  const add = (name, suffix) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    items.push({ name, suffix: suffix || '' });
  };
  for (const [name, suffix] of COMMANDS) add(name, suffix);
  for (const name of userCommands || []) add(name, '{}');
  const matched = items.filter(c => !q || c.name.toLowerCase().startsWith(q));
  matched.sort((a, b) => (a.name.toLowerCase() === q ? -1 : b.name.toLowerCase() === q ? 1 : a.name.localeCompare(b.name)));
  return matched.slice(0, 40);
}

/** \begin{ 部分：返回 { partial }；未进入环境名输入则 null */
export function matchEnvToken(before) {
  const m = String(before || '').match(/\\begin\s*\{\s*([a-zA-Z*]*)$/);
  return m ? { partial: m[1] } : null;
}

/** 命令名输入中：行尾是 \word（空 token = 刚敲下反斜杠，也弹全量候选）。
 * 返回 { token, start }，start 为反斜杠的偏移（替换区从 '\' 开始） */
export function matchCommandToken(before) {
  const s = String(before || '');
  const m = s.match(/\\([a-zA-Z]*\*?)$/);
  if (!m) return null;
  const start = s.length - m[0].length;
  // '\\section' 是换行 + 单词，不是命令：前一个字符还是反斜杠就不补
  if (start > 0 && s[start - 1] === '\\') return null;
  return { token: m[1], start };
}

/* 文件参数命令 → 候选池类型：
 *   tex   → .tex/.sty/.cls
 *   image → 图片与 PDF（includegraphics 能吃 PDF）
 *   bib   → .bib
 *   file  → 以上并集（lstinputlisting 等） */
const FILE_CMDS = {
  input: 'tex', include: 'tex', subfile: 'tex',
  includegraphics: 'image', lstinputlisting: 'file',
  bibliography: 'bib', addbibresource: 'bib',
};

/** \cmd[…]{ 部分：返回 { cmd, kind, partial }；segment 语义与 \cite 多键一致（最后一个逗号之后） */
export function matchFileToken(before) {
  const names = Object.keys(FILE_CMDS).join('|');
  const m = String(before || '').match(new RegExp('\\\\(' + names + ')\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^}]*)$'));
  if (!m) return null;
  const body = m[2];
  const comma = body.lastIndexOf(',');
  const partial = comma >= 0 ? body.slice(comma + 1) : body;
  return { cmd: m[1], kind: FILE_CMDS[m[1]], partial };
}

/** 按类型取文件候选池；pool 形如 { tex: [...], image: [...], bib: [...] }（统一斜杠路径） */
export function fileCandidates(kind, partial, pool) {
  const lists = {
    tex: pool?.tex || [],
    image: pool?.image || [],
    bib: pool?.bib || [],
  };
  const src = kind === 'file' ? [...lists.tex, ...lists.image, ...lists.bib] : lists[kind] || [];
  const seen = new Set();
  const q = String(partial || '').toLowerCase();
  const out = [];
  for (const p of src) {
    if (!p || seen.has(p)) continue;
    if (q && !p.toLowerCase().includes(q)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= 50) break;
  }
  return out;
}

/** 环境补全后是否需要补 \end：光标之后的窗口里已有同名 \end 就不重复插 */
export function envNeedsEnd(envName, after) {
  const re = new RegExp('\\\\end\\s*\\{\\s*' + envName.replace(/[*\\]/g, '\\$&') + '\\s*\\}');
  return !re.test(String(after || ''));
}

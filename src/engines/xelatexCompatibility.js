// Saved editor documents survive template updates in localStorage. Repair the
// preamble of earlier PaperLite samples at compile time, preserving user edits
// and original line numbers. Other documents keep their explicit dependencies.
export function prepareXeLaTeXSource(value) {
  const source = String(value);
  const active = source.replace(/(?<!\\)%[^\r\n]*/g, '');
  const demo = active.includes('\\newcommand{\\model}{BiLSTM-Att}')
    && active.includes('\\tikzset{');
  const flow = active.includes('\\section{TikZ 流程图速查}')
    && active.includes('trapezium left angle=70');
  const setup = [];
  // xeCJK lazily loads its monospace font. Loading a fontspec config for the
  // first time inside \verb inherits verbatim EOF hooks and breaks its group.
  // Prime the CJK monospace font in a discarded box before body text is read.
  const primeMono = '\\AtBeginDocument{\\begingroup\\setbox0=\\hbox{\\ttfamily 中}\\endgroup}';
  if (/\\verb\*?[^a-zA-Z]/.test(active) && /\b(?:ctex\w*|xeCJK)\b/.test(active)
      && !active.includes(primeMono)) setup.push(primeMono);
  if ((demo || flow) && !/\\usetikzlibrary\s*\{[^}]*\bshapes\.geometric\b/.test(active)) {
    setup.push('\\usetikzlibrary{shapes.geometric,positioning,arrows}');
  }
  if (demo && /\\mathbb\b/.test(active)
      && !/\\(?:usepackage|RequirePackage)(?:\s*\[[^\]]*\])?\s*\{[^}]*(?:amssymb|amsfonts|unicode-math)\b/.test(active)) {
    setup.push('\\ifdefined\\mathbb\\else\\RequirePackage{amssymb}\\fi');
  }
  if (demo && /\\begin\s*\{mermaid\}/.test(active)
      && !/\\(?:DefineVerbatimEnvironment|newenvironment|renewenvironment|NewDocumentEnvironment)\s*\{mermaid\}/.test(active)) {
    // Same fallback as the current demo: web preview renders Mermaid, while
    // XeLaTeX keeps its source as a listing instead of an undefined environment.
    setup.push('\\RequirePackage{fancyvrb}\\ifcsname mermaid\\endcsname\\else'
      + '\\DefineVerbatimEnvironment{mermaid}{Verbatim}{fontsize=\\small}\\fi');
  }
  if (!setup.length) return source;
  return source.replace(/^([ \t]*)\\begin\s*\{document\}/m,
    (_, indent) => indent + setup.join('') + '\\begin{document}');
}

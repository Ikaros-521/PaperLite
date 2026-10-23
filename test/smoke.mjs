/* PaperLite 冒烟测试（Node + 真实 KaTeX） */
import { readFileSync } from 'node:fs';
import { renderLatex } from '../src/engines/latex.js';
import { renderMarkdown, renderMarkdownFull } from '../src/engines/markdown.js';
import { lintLaTeX } from '../src/engines/linter.js';
import { collectIssues, currentCompileErrors } from '../src/diagnostics.js';
import * as TIKZ from '../src/engines/tikz.js';
import { samples } from '../src/engines/samples.js';
import * as C from '../src/context.js';
import { DICT, setLang } from '../src/i18n.js';
import { THEME_IDS, DEFAULT_THEME, detectTheme } from '../src/theme.js';

const PICK_TO_TOKEN = { '--t-desk': '--desk', '--t-paper': '--paper', '--t-accent': '--accent', '--t-seal': '--seal' };

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.error('  ✗ FAIL:', msg); }
}

// ---------- demo 模板 ----------
console.log('== demo 模板（真实 KaTeX）==');
const src = samples.demo;
const res = renderLatex(src);
ok(res.html.includes('摘要'), '包含摘要');
ok(res.html.includes('doc-title'), '包含标题块');
ok((res.html.match(/<h2 /g) || []).length === 5, '5 个一级章节, got ' + (res.html.match(/<h2 /g) || []).length);
ok(res.html.includes('class="katex"'), 'KaTeX 真实渲染输出');
ok((res.html.match(/class="katex"/g) || []).length >= 10, '≥10 处公式');
ok(res.html.includes('eq-no">(1)<'), '公式编号 (1)');
ok(res.html.includes('tabular'), '包含表格');
ok(res.html.includes('r-toprule'), '三线表规则线');
ok(res.html.includes('图&nbsp;1：'), '图 1 题注');
ok(res.html.includes('表&nbsp;2：'), '表 2 题注');
ok(res.html.includes('BiLSTM-Att'), '宏 \\model 已展开');
ok(res.html.includes('参考文献'), '参考文献');
ok(res.html.includes('[1]'), '引用回填 [1]');
ok(res.html.includes('mermaid-block'), 'mermaid 块');
ok(res.html.includes('footnotes'), '脚注');
ok(res.diagrams.length === 1, '1 个 tikz 图');
ok(res.warnings.length === 0, '零警告, got: ' + res.warnings.slice(0, 5).map(w => w.msg).join(' | '));
ok(res.headings.length === 8 && res.headings.every(h => h.offset > 0), '大纲 8 条且含偏移: ' + JSON.stringify(res.headings.map(h => [h.text, h.offset])));

// ---------- 源码区间回切 ----------
console.log('== 区间回切 ==');
const dg = res.diagrams[0];
ok(dg.svg && dg.svg.includes('<svg'), 'tikz svg 生成');
ok((dg.svg.match(/class="tk-node"/g) || []).length === 7, '7 个绘制节点, got ' + (dg.svg.match(/class="tk-node"/g) || []).length);
ok(dg.svg.includes('marker-end'), '箭头 marker');
const rawNode = dg.nodes.filter(n => n.name === 'raw')[0];
ok(!!rawNode, '节点 raw 存在');
if (rawNode) ok(src.slice(rawNode.optStart, rawNode.optEnd).startsWith('data, text width=2.6cm'), 'raw 选项回切正确');
const blockRange = dg.tikzsetRanges.filter(r => r.name === 'block')[0];
ok(!!blockRange, 'block 样式区间存在');
if (blockRange) ok(src.slice(blockRange.start, blockRange.end).startsWith('rectangle, rounded corners=6pt'), 'block 样式回切正确');
if (blockRange) {
  const list = TIKZ.parseOpts(src.slice(blockRange.start, blockRange.end));
  TIKZ.setOpt(list, 'fill', 'red!40');
  ok(TIKZ.buildOpts(list).includes('fill=red!40'), '选项重建');
}

// ---------- flow 模板 ----------
console.log('== flow 模板 ==');
const res2 = renderLatex(samples.flow);
const dg2 = res2.diagrams[0];
ok(res2.diagrams.length === 1 && dg2.nodes.length >= 6, 'flow 节点数 >= 6, got ' + (dg2 ? dg2.nodes.length : 0));
ok(dg2.svg.includes(' Q '), 'bend 曲线');
ok((dg2.svg.match(/marker-end/g) || []).length >= 6, '箭头数 >= 6');
ok(res2.warnings.length === 0, 'flow 零警告, got: ' + res2.warnings.slice(0, 5).map(w => w.msg).join(' | '));

// ---------- blank / 颜色 ----------
console.log('== blank / 颜色 ==');
ok(renderLatex(samples.blank).html.includes('摘要内容'), 'blank 渲染');
ok(TIKZ.parseColor('blue!20') === '#ccccff', 'blue!20');
ok(TIKZ.parseColor('red!50!blue') === '#800080', 'red!50!blue');

// ---------- Markdown 引擎 ----------
console.log('== Markdown 引擎 ==');
const mdSrc = [
  '# 项目笔记',
  '',
  '行内公式 $E=mc^2$ 与显示公式：',
  '',
  '$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$',
  '',
  '| 列A | 列B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '```mermaid',
  'flowchart LR',
  '  A-->B',
  '```',
  '',
  '```js',
  'const x = 1; // 代码中的 $ 不应被当数学处理',
  '```',
  '',
  '**加粗** 与 *斜体*，[链接](https://example.com)。'
].join('\n');
const mdHtml = renderMarkdown(mdSrc);
ok(mdHtml.includes('<h1 id="mdh-0">项目笔记</h1>'), 'md 一级标题(带锚点)');
ok((mdHtml.match(/class="katex"/g) || []).length >= 2, 'md 数学渲染（行内+行间）');
ok(mdHtml.includes('<table>') && mdHtml.includes('<th>列A</th>'), 'md 表格');
ok(mdHtml.includes('mermaid-block') && mdHtml.includes('flowchart'), 'md mermaid 块');
ok(mdHtml.includes('language-js'), 'md 代码块语言类');
ok(mdHtml.includes('const x = 1'), 'md 代码块内容保留');
ok(mdHtml.includes('<strong>加粗</strong>'), 'md 加粗');
ok(mdHtml.includes('<a href="https://example.com"'), 'md 链接');

// ---------- Markdown 大纲提取 ----------
console.log('== Markdown 大纲 ==');
const mdFull = renderMarkdownFull('# 一级\n\n正文\n\n### 三级\n\n## 二级\n\n```js\n# 注释非标题\n```\n\n## 二级2');
ok(mdFull.headings.length === 4, 'md 大纲条数 4, got ' + mdFull.headings.length);
ok(mdFull.headings[0].line === 0 && mdFull.headings[1].level === 3 && mdFull.headings[3].line === 12, 'md 大纲行号/层级: ' + JSON.stringify(mdFull.headings));
ok(!mdFull.headings.some(h => h.text.includes('注释非标题')), 'md 代码围栏内不识别为标题');

// ---------- LaTeX 语法检测 ----------
console.log('== LaTeX 语法检测 ==');
const bad = [
  '\\documentclass{ctexart}',
  '\\begin{document}',
  '\\section{引言}',
  '正文 $x 未闭合',
  '\\ref{missing-label}',
  '\\begin{itemize}',
  '  \\item A',
  '\\end{document}'
].join('\n');
const ds = lintLaTeX(bad);
ok(ds.some(d => d.kind === 'env' && d.line === 5), '未关闭环境定位到第 6 行: ' + JSON.stringify(ds.filter(d => d.kind === 'env').map(d => (d.line + 1) + ':' + d.msg)));
ok(ds.some(d => d.kind === 'math' && d.line === 3), '奇数 $ 警告在第 4 行');
ok(ds.some(d => d.kind === 'ref' && d.msg.includes('missing-label')), '未定义 label 引用');
const good = lintLaTeX(samples.demo);
ok(good.filter(d => d.kind === 'env' || d.kind === 'brace').length === 0, '示例论文环境/花括号零错误: ' + JSON.stringify(good.slice(0, 3)));
ok(lintLaTeX('text % { $ \\begin{itemize}').length === 0, '注释中的括号、公式和环境不误报');
ok(lintLaTeX('text \\% {').some(d => d.kind === 'brace'), '转义百分号后仍检查真实语法');
// 逐字区内部不参与语法判断（预览照原样渲染，lint 不该和它打脸）
ok(lintLaTeX('\\begin{document}\n\\begin{verbatim}\nif (x) { run($s) } // 50%\n\\end{verbatim}\n\\end{document}').length === 0,
  'verbatim 里的花括号/$/注释不误报: ' + JSON.stringify(lintLaTeX('\\begin{document}\n\\begin{verbatim}\nif (x) { run($s) } // 50%\n\\end{verbatim}\n\\end{document}')));
ok(lintLaTeX('\\begin{document}\n\\verb|a{b$c|\n\\end{document}').length === 0, '\\verb 定界符内不误报');
ok(lintLaTeX('\\begin{document}\n\\begin{verbatim}\nunclosed {\n').some(d => d.kind === 'env'),
  '未闭合的 verbatim 仍由环境配对报出来');
ok(lintLaTeX('\\begin{document}\n\\begin{verbatim}\n\\end{verbatim}\n{oops\n').some(d => d.kind === 'brace'),
  '逐字区之外的真错误照报');
ok(lintLaTeX('{fixed}').length === 0 && lintLaTeX('{broken').some(d => d.kind === 'brace'), '修改后重新检测，已修复的错误消失');
ok(lintLaTeX('On a five-level delay sweep ($\\Delta \\in \\{60, 300, 600, 900, 1800\\}$\\,s.').length === 0, '转义花括号紧随公式结尾不误报奇数 $');
ok(lintLaTeX('Price is \\$100 and \\$200').length === 0, '转义美元 \\$ 不计入数学环境');
ok(lintLaTeX('Formula \\\\$x$').length === 0, '换行 \\\\ 后的行内公式 $x$ 正常配对');
ok(lintLaTeX('Formula \\\\\\$100').length === 0, '换行 \\\\ 后跟随转义 \\$ 不误报');
ok(lintLaTeX('set \\{1, 2, 3\\}').length === 0, '转义花括号 \\{ \\} 不影响环境括号深度');

// ---------- 排版语法：\documentclass[选项]{类} ----------
console.log('== 排版语法（文档类与选项）==');
const { readDocumentclass, resolveLayout } = await import('../src/engines/classLayout.js');
const dcls = readDocumentclass('\\documentclass[journal]{IEEEtran}\n\\usepackage{cite}');
ok(dcls && dcls.cls === 'IEEEtran' && dcls.options.join(',') === 'journal', '解析 \\documentclass[journal]{IEEEtran}: ' + JSON.stringify(dcls));
ok(resolveLayout('IEEEtran', ['journal']).columns === 2, 'IEEEtran journal 默认双栏');
ok(resolveLayout('IEEEtran', ['journal']).spanHead === true, 'IEEEtran 标题带跨栏');
ok(resolveLayout('IEEEtran', ['journal']).classes.includes('cols-span'), 'IEEEtran 用跨栏标记而不是给容器加双栏类');
ok(resolveLayout('IEEEtran', ['conference']).authorLayout === 'columns', '会议模式作者分栏');
ok(resolveLayout('IEEEtran', ['technote']).columns === 1, 'technote 单栏');
ok(resolveLayout('IEEEtran', ['onecolumn']).columns === 1, 'onecolumn 覆盖类默认双栏');
ok(resolveLayout('IEEEtran', []).basePt === 10, 'IEEEtran 未给尺寸时按 10pt');
ok(resolveLayout('IEEEtran', ['12pt', '8pt']).basePt === 8, '尺寸选项后者覆盖前者');
ok(resolveLayout('article', ['twocolumn']).classes.includes('twocolumn'), 'article[twocolumn] 整页双栏');
ok(resolveLayout('article', ['11pt']).scale < resolveLayout('article', ['12pt']).scale, '字号选项驱动 --doc-scale');
ok(resolveLayout('ctexart', ['UTF8']).family === 'ctex', 'ctex 家族识别');
ok(resolveLayout('IEEEtran', ['journal', 'onecolumn']).conflicts.length === 0 &&
   resolveLayout('IEEEtran', ['onecolumn', 'twocolumn']).conflicts.length === 1, '互斥选项只在真冲突时报');
const ieeeVars = resolveLayout('IEEEtran', ['journal']).vars;
ok(ieeeVars['--doc-scale'] === '0.9' && ieeeVars['--doc-page-w'] === '830px', '版式变量输出: ' + JSON.stringify(ieeeVars));

const ieeeRes = renderLatex(samples.ieee);
ok(ieeeRes.warnings.length === 0, 'IEEE 示例零警告, got: ' + ieeeRes.warnings.slice(0, 5).map(w => w.msg).join(' | '));
ok(ieeeRes.html.includes('<div class="doc-cols">'), '正文进入跨栏后的双栏容器');
ok(ieeeRes.html.trimEnd().endsWith('</div>'), '双栏容器闭合');
ok(ieeeRes.html.includes('doc-heads'), '\\markboth 渲染为期刊页眉');
ok(ieeeRes.html.includes('ieeepar-c') && ieeeRes.html.includes('ieeepar-w'), '\\IEEEPARstart 首字下沉 + 小型大写');
ok(ieeeRes.html.includes('ieee-keywords'), 'IEEEkeywords 渲染为索引术语');
ok(ieeeRes.html.includes('ieee-bio'), 'IEEEbiographynophoto 渲染为作者简介');
ok(ieeeRes.html.includes('au-mark'), '\\IEEEauthorrefmark 渲染为上标符号');
ok(ieeeRes.html.includes('au-thanks'), '\\thanks 渲染为标题带下的致谢');
ok(ieeeRes.html.includes('ieee-abstract') && !ieeeRes.html.includes('<div class="abstract"><h4>'), 'IEEE 摘要不用边框块');
ok(JSON.stringify(ieeeRes.headings.map(h => h.num)) === '["I","II","A)","1)","III","IV"]', 'IEEE 章节编号 I / A) / 1): ' + JSON.stringify(ieeeRes.headings.map(h => h.num)));
ok(ieeeRes.meta.authorBlocks.length === 3 && ieeeRes.meta.authorBlocks[0].affils.length === 1, '作者带按 \\and 拆成 3 块: ' + ieeeRes.meta.authorBlocks.length);
ok(ieeeRes.html.includes('Eq.&nbsp;') || ieeeRes.html.includes('式'), '\\eqref 仍可用');
const confRes = renderLatex('\\documentclass[conference]{IEEEtran}\\begin{document}\\author{\\IEEEauthorblockN{A}\\and\\IEEEauthorblockN{B}}\\maketitle\\section{Intro}Text\\end{document}');
ok(confRes.html.includes('au-columns'), '会议模式作者分栏类名');
const ieeeLower = renderLatex('\\documentclass[journal]{IEEEtran}\\begin{document}\\markboth{Left}{\\MakeLowercase{\\textit{Et Al.}} Author}\\maketitle\\section{A}x\\end{document}');
ok(ieeeLower.html.includes('<em>et al.</em> Author'), '\\MakeLowercase 变小写但不破坏标签: ' + (ieeeLower.meta.heads || {}).right);
const silentRes = renderLatex('\\documentclass[journal]{IEEEtran}\\begin{document}\\IEEEoverridecommandlockouts\\IEEEpubid{2026\\$ IEEE}\\IEEEpubidadjcol\\section{A}\\IEEEPARstart{O}{ne}\\end{document}');
ok(silentRes.warnings.length === 0, 'IEEE 声明命令不产生「不支持的命令」警告: ' + silentRes.warnings.map(w => w.msg).join(' | '));
const unknownCls = renderLatex('\\documentclass[11pt]{acmsmart}\n\\begin{document}\\section{A}正文\\end{document}');
ok(unknownCls.meta.layout.family === 'other' && unknownCls.meta.layout.basePt === 11, '未知文档类退化但不报错，字号选项仍生效');

// 畸形列格式规格：曾经 *{ 缺右括号会让 i 绕回 0 无限重入（冻结主线程后 RangeError）
console.log('== 畸形 tabular 列格式 ==');
for (const bad of ['{*}', '{*{3}{c}', '{*{99999999}{c}}', '{@}', '{p{2cm}']) {
  const t0 = Date.now();
  let threw = null;
  try { renderLatex(String.raw`\documentclass{article}\begin{tabular}` + bad + String.raw` a \end{tabular}\end{document}`); }
  catch (e) { threw = e.message; }
  ok(!threw && Date.now() - t0 < 500, `列格式 ${bad} 不抛错且不阻塞, took ${Date.now() - t0}ms ${threw || ''}`);
}
const starCols = renderLatex(String.raw`\documentclass{article}\begin{tabular}{*{3}{c}}a&b&c\end{tabular}\end{document}`);
ok((starCols.html.match(/<td/g) || []).length === 3, '*{3}{c} 仍展开成 3 列: ' + (starCols.html.match(/<td/g) || []).length);

// ---------- 补齐的命令：\toprule 家族 / \appendix / \mbox / \dots / \verb ----------
console.log('== 补齐命令 ==');
const ruleRes = renderLatex(String.raw`\documentclass{article}\begin{document}
\begin{tabularx}{\linewidth}{lXr}\toprule A & B & C \\ \midrule 1 & 2 & 3 \\ \bottomrule
\end{tabularx}
\begin{tabular}[t]{cc}\toprule H & I \\ \cmidrule(r){1-2} J & K \\ \bottomrule\end{tabular}
\end{document}`);
ok(ruleRes.warnings.length === 0, 'tabularx / [t] / \\cmidrule 零警告: ' + ruleRes.warnings.map(w => w.msg).join(' | '));
ok((ruleRes.html.match(/r-toprule/g) || []).length === 2, '两种表格都识别行首 \\toprule');
ok((ruleRes.html.match(/r-bottomrule/g) || []).length === 2, '表尾 \\bottomrule 附加到最后一行');
ok(/<tr class="[^"]*\bcl\b/.test(ruleRes.html), '\\cmidrule 归入 cl 横线类');
// data-off（预览回跳源码的偏移标注）与这些断言无关，比较前剥掉
const stripOff = html => html.replace(/ data-off="\d+"/g, '');
ok(/<td class="ta-r"><p>C<\/p>/.test(stripOff(ruleRes.html)), 'tabularx 的 X 列不再挤掉后续列: ' + (ruleRes.html.match(/<tr class="r-toprule">.*?<\/tr>/s) || [''])[0]);
const strayRes = renderLatex(String.raw`\documentclass{article}\begin{document}正文 \toprule 继续 \hline 结束 \cline{1-2}\end{document}`);
ok(strayRes.warnings.length === 0 && !strayRes.html.includes('toprule'), '表格线命令落在正文里静默忽略: ' + strayRes.html);
const apRes = renderLatex(String.raw`\documentclass{article}\begin{document}\section{Body}\label{s1}\appendix
\section{Proof}\label{p1}\subsection{Case}\end{document}`);
ok(apRes.warnings.length === 0, '\appendix 零警告: ' + apRes.warnings.map(w => w.msg).join(' | '));
ok(JSON.stringify(apRes.headings.map(h => h.num)) === '[1,"A","A.1"]', '附录章节改用字母编号: ' + JSON.stringify(apRes.headings.map(h => h.num)));
const boxRes = renderLatex(String.raw`\documentclass{article}\begin{document}等式 \mbox{$a=b$} 不断行，诸如此类 \dots 与 \ldots 都省略。数学里 $\mbox{文字}+x$ 排正体。\end{document}`);
ok(boxRes.warnings.length === 0, '\mbox / \dots 零警告: ' + boxRes.warnings.map(w => w.msg).join(' | '));
ok(boxRes.html.includes('<span class="mbox"><span class="katex">'), '\mbox 内容照常渲染（含数学）: ' + (boxRes.html.match(/<span class="mbox">[^<]*/) || [''])[0]);
ok(!/class="math-error"/.test(boxRes.html) && !boxRes.html.includes('$\\mbox{文字}+x$'), '数学里的 \\mbox 按 \\text 渲染，不报公式错误');
ok(boxRes.html.includes('\u2026') && !boxRes.html.includes('\\dots'), '\dots / \ldots 渲染为省略号');
const verbRes = renderLatex(String.raw`\documentclass{article}\begin{document}\section{含 \verb|foo| 的标题}
用 \verb|%|、\verb*{a  b} 与 \verb+\LaTeX+，表格里的 \verb|&| 不分列。
\begin{tabular}{cc}\verb|&| & ok \\ \end{tabular}
\end{document}`);
ok(verbRes.warnings.length === 0, '\verb 零警告: ' + verbRes.warnings.map(w => w.msg).join(' | '));
ok(verbRes.html.includes('<code class="verb">%</code>'), '\verb 定界符内的 % 不当注释');
ok(verbRes.html.includes('<code class="verb">a\u2423\u2423b</code>'), '\verb* 显示可见空格');
ok(verbRes.html.includes('<code class="verb">\\LaTeX</code>'), '\verb 内容按字面显示，不展开命令');
ok(/<td><p><code class="verb">&amp;<\/code><\/p><\/td><td><p>ok/.test(stripOff(verbRes.html)), '\verb|&| 不被当成列分隔符: ' + (verbRes.html.match(/<tr[^>]*>.*?<\/tr>/s) || [''])[0]);
ok(stripOff(verbRes.html).includes('<h2 id="h-0" class="sec1"><span class="secnum">1</span> 含 <code class="verb">foo</code> 的标题</h2>'), '标题内的 \verb 照常排版');

// ---------- 第二批：\lstinline / \fbox / 引用与模板命令 / 表格环境 ----------
console.log('== 补齐命令（第二批）==');
const liRes = renderLatex(String.raw`\documentclass{article}\begin{document}
用 \lstinline{fontspec} 与 \lstinline[language=C]|int x; // 注释| 两种写法。
\end{document}`);
ok(liRes.warnings.length === 0, '\lstinline 零警告: ' + liRes.warnings.map(w => w.msg).join(' | '));
ok(liRes.html.includes('<code class="verb">fontspec</code>') && liRes.html.includes('<code class="verb">int x; // 注释</code>'),
  '\lstinline 带选项与花括号定界符都取字面: ' + (liRes.html.match(/<code class="verb">[^<]*<\/code>/g) || []).join(''));
const fbRes = renderLatex(String.raw`\documentclass{article}\begin{document}\fbox{带框} 与 \hbox{连写} 和 \mbox{不换行}\end{document}`);
ok(fbRes.warnings.length === 0 && fbRes.html.includes('<span class="fbox">带框</span>') && (fbRes.html.match(/class="mbox"/g) || []).length === 2,
  '\fbox 加边框、\hbox 等同 \mbox: ' + fbRes.warnings.map(w => w.msg).join(' | '));
const refRes = renderLatex(String.raw`\documentclass{article}\begin{document}
\begin{figure}\caption{图一}\label{f:1}\end{figure}
\begin{table}\begin{tabular}{cc}a&b\end{tabular}\caption{表一}\label{t:1}\end{table}
如\figref{f:1}、\tabref{t:1}与\autoref{t:1}所示。\begin{thebibliography}{9}\bibitem{k}文献\end{thebibliography}
据~\cite{k}、\parencite{k}、\textcite{k}。
\end{document}`);
ok(refRes.warnings.length === 0, '\figref / \tabref / \parencite 零警告: ' + refRes.warnings.map(w => w.msg).join(' | '));
ok(refRes.html.includes('图&nbsp;1') && refRes.html.includes('表&nbsp;1'), '\figref/\tabref 带图/表前缀');
ok((refRes.html.match(/class="cite">\[1\]/g) || []).length === 3, '三种引用命令都回填 [1]: ' + (refRes.html.match(/class="cite">[^<]*</g) || []).join(''));
const tplRes = renderLatex(String.raw`\documentclass{ctexart}
\title{标题}\author{张三\email{z@x.edu}\institute{某大学}}\keywords{图论, \LaTeX{}}
\begin{document}\maketitle\begin{abstract}本文……。
\end{abstract}用 \hologo{XeLaTeX} 编译，\version{0.1}\printbibliography[heading=bibintoc, title=\ebibname]
\end{document}`);
ok(tplRes.warnings.length === 0, '模板命令零警告: ' + tplRes.warnings.map(w => w.msg).join(' | '));
ok(/<div class="abstract">[\s\S]*关键词[：:][\s\S]*图论/.test(stripOff(tplRes.html)), '导言 \keywords 落在摘要内: ' + (tplRes.html.match(/关键词[^<]*[^]*/) || [''])[0].slice(0, 40));
ok(tplRes.html.includes('mailto:z@x.edu'), '\email 渲染为邮件链接');
ok(tplRes.html.includes('doc-institute') && (tplRes.html.match(/某大学/g) || []).length === 1, '\institute 在 \author 内时只显示一次');
ok(tplRes.html.includes('XeLaTeX') && !tplRes.html.includes('\\version') && !tplRes.html.includes('bibintoc'),
  '\hologo 出文字，\version/\printbibliography 参数不外泄');
const kwBody = renderLatex(String.raw`\documentclass{article}\begin{document}正文\keywords{甲, 乙}后文\end{document}`);
ok(kwBody.warnings.length === 0 && /<div class="doc-keywords">/.test(stripOff(kwBody.html)), '正文里的 \keywords 就地成块');
const wideRes = renderLatex(String.raw`\documentclass{article}\begin{document}
\begin{tabular*}{\textwidth}{ccc}\toprule A & B & C \\ \midrule 1 & 2 & 3 \\ \bottomrule\end{tabular*}
\end{document}`);
ok(wideRes.warnings.length === 0 && /<table class="tabular" data-tid="\d+" style="width:100%">/.test(stripOff(wideRes.html)) && wideRes.html.includes('r-toprule'),
  'tabular* 按列格式排版并占满宽度: ' + wideRes.warnings.map(w => w.msg).join(' | '));
const ltRes = renderLatex(String.raw`\documentclass{article}\begin{document}
\begin{longtable}{cc}\caption{长表}\label{lt}\toprule 头 & 目 \\ \midrule \endfirsthead
\toprule 续 & 头 \\ \endhead
\midrule \endfoot
\bottomrule \endlastfoot
1 & 2 \\ 3 & 4 \\ 5 & 6 \\
\end{longtable}
跨页表见 \tabref{lt}。
\end{document}`);
ok(ltRes.warnings.length === 0, 'longtable 零警告: ' + ltRes.warnings.map(w => w.msg).join(' | '));
ok((ltRes.html.match(/<tr/g) || []).length === 4, '首份表头 + 3 行表体（重复表头与表脚只留一份）: ' + (ltRes.html.match(/<tr[^>]*>/g) || []).join(''));
ok(ltRes.html.includes('表&nbsp;1：长表') && ltRes.html.includes('见 1') || ltRes.html.includes('表&nbsp;1'), 'longtable 题注按表编号');
const apEnvRes = renderLatex(String.raw`\documentclass{article}\begin{document}\section{正文}\begin{appendix}\section{附录}\end{appendix}\end{document}`);
ok(apEnvRes.warnings.length === 0 && JSON.stringify(apEnvRes.headings.map(h => h.num)) === '[1,"A"]',
  '\begin{appendix} 环境同样切换字母编号: ' + JSON.stringify(apEnvRes.headings.map(h => h.num)));
const verbEnvRes = renderLatex('\\documentclass{article}\\begin{document}\n\\begin{verbatim}\nx = 1  % 行内注释保留\n\\end{verbatim}\n\\begin{lstlisting}[language=C]\nchar c = 0x25; // % 也保留\n\\end{lstlisting}\n\\end{document}');
ok(verbEnvRes.warnings.length === 0 && verbEnvRes.html.includes('% 行内注释保留') && verbEnvRes.html.includes('// % 也保留'),
  '逐字环境内的 % 不再被当注释抹掉: ' + verbEnvRes.html.replace(/<[^>]*>/g, '').trim());
const fixtureRes = renderLatex(readFileSync(new URL('../test/fixtures/elegantpaper-demo.tex', import.meta.url), 'utf8'));
ok(fixtureRes.warnings.length === 0, 'elegantpaper 示例零警告: ' + fixtureRes.warnings.slice(0, 5).map(w => w.msg).join(' | '));

// ---------- 换行的可选间距 \\[<dim>] ----------
console.log('== 换行间距 \\\\ [<dim>] ==');
const brkTitle = renderLatex(String.raw`\documentclass{ctexart}\begin{document}\title{\textbf{甲}\\[0.5cm]\large 乙\\[-3pt]丙}\maketitle\end{document}`).html;
ok(!brkTitle.includes('[0.5cm]') && !brkTitle.includes('[-3pt]'), '换行后的长度参数不再当正文显示: ' + brkTitle);
ok(/margin-top:18\.9px/.test(brkTitle) && /margin-top:-3\.99px/.test(brkTitle), '0.5cm→18.9px、-3pt→-3.99px 间距: ' + brkTitle);
const brkKeep = renderLatex(String.raw`\documentclass{ctexart}\begin{document}\title{甲 \\[见注] 乙}\maketitle\end{document}`).html;
ok(brkKeep.includes('[见注]'), '非长度参数不吞掉，保留原文: ' + brkKeep);
const brkRow = renderLatex(String.raw`\documentclass{ctexart}\begin{document}\begin{tabular}{cc}A & B \\[6pt] C & D\end{tabular}\end{document}`).html;
ok(/<tr[^>]*style="--rg:7\.98px"/.test(brkRow) && !brkRow.includes('[6pt]'), '表格行距落到下一行且不留字面量: ' + brkRow);
const brkOffset = renderLatex(String.raw`\documentclass{ctexart}\begin{document}\begin{tabular}{cc}A & B \\[6pt] C & D\end{tabular}\end{document}`);
ok(brkOffset.warnings.length === 0, '带间距的表格不产生渲染警告: ' + brkOffset.warnings.map(w => w.msg).join(' | '));

// ---------- 排版语法的静态检测 ----------
// ---------- 高校论文常用 LaTeX 宏包支持 ----------
console.log('== 宏包支持：算法伪代码 / 高级表格 / 定理证明 / 子图 ==');

// 1. 算法与伪代码
const algDoc = String.raw`\documentclass{article}
\usepackage{algorithm,algpseudocode}
\begin{document}
\begin{algorithm}[h]
  \caption{Euclid's algorithm}
  \label{alg:euclid}
  \begin{algorithmic}[1]
    \Require $a, b \ge 0$
    \Ensure $\gcd(a, b)$
    \State $r \gets a \bmod b$ \Comment{init remainder}
    \While{$r \ne 0$}
      \State $a \gets b$
      \State $b \gets r$
      \State $r \gets a \bmod b$
    \EndWhile
    \State \Return $b$
  \end{algorithmic}
\end{algorithm}
引用算法：\ref{alg:euclid}
\end{document}`;
const algRes = renderLatex(algDoc);
ok(algRes.html.includes('class="float algorithm"'), '渲染 algorithm 浮动容器');
ok(algRes.html.includes('Euclid'), '包含算法题注标题');
ok(algRes.html.includes('class="alg-line"'), '生成算法行');
ok(algRes.html.includes('class="alg-lineno"'), '生成行号标签');
ok(algRes.html.includes('1:</span>') && algRes.html.includes('6:</span>'), '行号连续递增');
ok(algRes.html.includes('--alg-indent:1'), 'While 循环内部存在缩进');
ok(algRes.html.includes('class="alg-comment"'), '渲染算法注释');
ok(algRes.html.includes('引用算法：1'), '算法引用 \\ref 成功回填对应编号: ' + algRes.html);

// 2. 高级表格（multirow, makecell, diagbox）
const tabDoc = String.raw`\documentclass{article}
\usepackage{multirow,makecell,diagbox}
\begin{document}
\begin{tabular}{|c|c|c|}
\hline
\multirow{2}{*}{合并两行} & \makecell{第一行\\第二行} & \diagbox{行}{列} \\
\cline{2-3}
& \thead{表头A\\副标题} & 普通格 \\
\hline
\end{tabular}
\end{document}`;
const tabRes = renderLatex(tabDoc);
ok(tabRes.html.includes('rowspan="2"'), '表格支持 rowspan 属性');
ok(tabRes.html.includes('class="makecell"'), '生成 makecell 行内换行容器');
ok(tabRes.html.includes('第一行<br/>第二行'), 'makecell 内部 \\ 转换为 <br/>');
ok(tabRes.html.includes('<strong>表头A<br/>副标题</strong>'), 'thead 自动加粗换行表头');
ok(tabRes.html.includes('class="diagbox"'), '支持 diagbox 对角表头');
const tabTrs = tabRes.html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
ok(tabTrs.length === 2, '生成 2 行数据');
const r2Tds = (tabTrs[1].match(/<td/g) || []).length;
ok(r2Tds === 2, '第二行正确跳过占位空单元格，保持列数对齐 (2 tds): ' + tabTrs[1]);

// 3. 定理与证明
const thmDoc = String.raw`\documentclass{article}
\usepackage{amsthm}
\newtheorem{mythm}{引申定理}[section]
\begin{document}
\section{基础理论}
\begin{theorem}[勾股定理]
\label{thm:pyth}
直角三角形斜边平方等于两直角边平方和。
\end{theorem}
\begin{mythm}
这是自定义并按章节编号的定理。
\end{mythm}
\begin{proof}[勾股定理的证明]
通过面积分割法显然成立。\qed
\end{proof}
定理编号引用：\ref{thm:pyth}
\end{document}`;
const thmRes = renderLatex(thmDoc);
ok(thmRes.html.includes('class="theorem-block"'), '渲染 theorem-block');
ok(thmRes.html.includes('thm-head') && thmRes.html.includes('thm-opt'), '渲染定理头与可选名');
ok(thmRes.html.includes('勾股定理'), '包含定理自定义名称');
ok(thmRes.html.includes('class="proof-block"'), '渲染 proof-block');
ok(thmRes.html.includes('勾股定理的证明.'), '自定义证明标题');
ok(thmRes.html.includes('class="proof-qed"'), '包含 QED 证明结束符号 □');
ok(thmRes.html.includes('定理编号引用：1'), '定理 label/ref 正确绑定');

// 4. 子图与子题注
const subDoc = String.raw`\documentclass{article}
\usepackage{subcaption,graphicx}
\begin{document}
\begin{figure}[htbp]
  \begin{subfigure}[b]{0.45\textwidth}
    \caption{子图 A}
    \label{sub:a}
  \end{subfigure}
  \begin{subfigure}[b]{0.45\textwidth}
    \caption{子图 B}
    \label{sub:b}
  \end{subfigure}
  \caption{总图}
  \label{fig:main}
\end{figure}
引用主图：\ref{fig:main}，引用子图：\ref{sub:a}
\end{document}`;
const subRes = renderLatex(subDoc);
ok(subRes.html.includes('has-subfigures'), '主图 figure 自动挂上 has-subfigures 类');
ok(subRes.html.includes('class="subfigure"'), '渲染 subfigure 子容器');
ok(subRes.html.includes('width:45%;'), '宽度百分比正确折算');
ok(subRes.html.includes('(a)') && subRes.html.includes('(b)'), '子图编号 (a) (b) 自动生成');
ok(subRes.html.includes('引用主图：1'), '主图编号绑定');
ok(subRes.html.includes('引用子图：1a'), '子图引用绑定主图+字母序号');

// 5. 宏包扩展审查缺陷回归验证
const regCap = renderLatex('\\begin{figure}\\begin{subfigure}{0.45\\textwidth}\\caption{子图 A}\\end{subfigure}\\caption{总图标题}\\end{figure}');
ok(regCap.html.includes('总图标题') && regCap.html.includes('<figcaption>图&nbsp;1：总图标题</figcaption>'), '宏包回归: 主图题注不被子图劫持');

const regMath = renderLatex('\\begin{algorithmic}\\State $x \\in S, \\forall y$\\end{algorithmic}');
ok(!regMath.html.includes('for all') && regMath.html.includes('x \\in S, \\forall y'), '宏包回归: 数学量词 \\forall 不被错误切断');

const regRet = renderLatex('\\begin{algorithmic}\\State \\Return x\\end{algorithmic}');
ok(regRet.html.includes('<span class="alg-kw">return</span>') && !regRet.html.includes('&lt;span'), '宏包回归: \\Return 正常高亮无二次实体转义');

const regSubcap = renderLatex('\\begin{figure}\\begin{subfigure}{0.5\\textwidth}\\subcaption{说明}\\end{subfigure}\\end{figure}');
const subCount = (regSubcap.html.match(/subfig-cap/g) || []).length;
ok(subCount === 1, '宏包回归: \\subcaption 在子图内不重复渲染');

const regSecThm = renderLatex('\\newtheorem{mythm}{Theorem}[section]\\begin{document}\\section{A}\\begin{mythm}T1\\end{mythm}\\section{B}\\begin{mythm}T2\\end{mythm}\\end{document}');
ok(regSecThm.html.includes('Theorem&nbsp;2.1'), '宏包回归: 定理跨 section 计数器归零重置');

const regFnCom = renderLatex('\\begin{algorithmic}\\Function{Calc}{$x$} \\Comment{注释}\\State x\\EndFunction\\end{algorithmic}');
ok(regFnCom.html.includes('注释') && regFnCom.html.includes('alg-comment'), '宏包回归: Function 行末 \\Comment 正常保留');

const regThmDiv = renderLatex('\\begin{theorem}T\\end{theorem}');
ok(regThmDiv.html.includes('<div class="thm-body">'), '宏包回归: thm-body 为 div 语义块');

// 6. 第二轮宏包审查缺陷回归验证
const regThmSib = renderLatex('\\newtheorem{thm}{Theorem}[section]\n\\newtheorem{lem}[thm]{Lemma}\n\\begin{document}\n\\section{Sec 1}\\begin{thm}T1\\end{thm}\n\\section{Sec 2}\\begin{lem}L1\\end{lem}\\begin{thm}T2\\end{thm}\n\\end{document}');
ok(regThmSib.html.includes('Lemma&nbsp;2.1') && regThmSib.html.includes('Theorem&nbsp;2.2'), '宏包回归: 共享计数器的从属定理继承 parent 章节重置与编号');

const regSubTab = renderLatex('\\begin{figure}\\caption{F1}\\end{figure}\\begin{figure}\\caption{F2}\\end{figure}\\begin{table}\\begin{subtable}{0.4\\textwidth}\\caption{ST}\\label{st1}\\end{subtable}\\caption{T1}\\end{table}引用：\\ref{st1}');
ok(regSubTab.html.includes('引用：1a'), '宏包回归: subtable 引用正确绑定 table 编号而非先前 figure 编号');

const regQedHere = renderLatex('\\begin{proof}Step 1. \\qedhere\\end{proof}');
const qedCount = (regQedHere.html.match(/proof-qed/g) || []).length;
ok(qedCount === 1, '宏包回归: \\qedhere 证明环境不重复生成双重 QED 符号');

const regIeeeQed = renderLatex('\\begin{IEEEproof}Step 1. \\qedhere\\end{IEEEproof}');
ok(regIeeeQed.html.includes('&#8718;'), '宏包回归: IEEEproof 中的 \\qedhere 使用实心方块');

const regReqEnsCom = renderLatex('\\begin{algorithmic}\\Require{data} \\Comment{req c}\\Ensure{res} \\Comment{ens c}\\State x\\end{algorithmic}');
ok(regReqEnsCom.html.includes('req c') && regReqEnsCom.html.includes('ens c'), '宏包回归: \\Require/\\Ensure 带花括号保留行末注释');

const regEndSubSpace = renderLatex('\\begin{figure}\\begin{subfigure}{0.4\\textwidth}\\caption{Sub}\\end {subfigure}\\caption{Main}\\end{figure}');
ok(regEndSubSpace.html.includes('图&nbsp;1：Main'), '宏包回归: \\end {subfigure} 带空格不吞掉主图题注');

const regDiagCss = renderLatex('\\begin{tabular}{c}\\diagbox{R}{C}\\end{tabular}');
ok(regDiagCss.html.includes('diag-top-right') && regDiagCss.html.includes('diag-bot-left'), '宏包回归: diagbox 生成对角表头语义结构');

const regThmStar = renderLatex('\\begin{document}\\begin{theorem*}无编号定理\\end{theorem*}\\begin{lemma*}无编号引理\\end{lemma*}\\end{document}');
ok(regThmStar.warnings.length === 0 && regThmStar.html.includes('无编号定理') && !regThmStar.html.includes('定理&nbsp;'), '宏包回归: 自动支持 theorem* 与 lemma* 无编号定理变体且无降级警告');

// 7. 第三轮宏包审查缺陷回归验证
const regAlgCaps = renderLatex('\\begin{algorithmic}\\STATE \\RETURN x\\STATE \\CALL{Calc}{y}\\STATE \\PRINT z\\COMMENT{note}\\end{algorithmic}');
ok(regAlgCaps.warnings.length === 0 && regAlgCaps.html.includes('return') && regAlgCaps.html.includes('Calc') && regAlgCaps.html.includes('print'), '宏包回归: 全大写算法宏 \\RETURN \\CALL \\PRINT \\COMMENT 正常解析零警告');

const regSubfloat = renderLatex('\\begin{figure}\\subfloat[子图 A\\label{suba}]{图像A}\\subfloat[子图 B\\label{subb}]{图像B}\\caption{总图}\\end{figure}引用：\\ref{suba}, \\ref{subb}');
ok(regSubfloat.warnings.length === 0 && regSubfloat.html.includes('has-subfigures') && regSubfloat.html.includes('引用：1a, 1b'), '宏包回归: \\subfloat 支持及题注 \\label 绑定 1a 1b');

const regMultiOpt = renderLatex('\\begin{figure}\\begin{subfigure}[t][b]{0.45\\textwidth}\\caption{A}\\end{subfigure}\\caption{Main}\\end{figure}');
ok(regMultiOpt.html.includes('width:45%;') && !regMultiOpt.html.includes('[b]0.45'), '宏包回归: subfigure 多可选参数 [t][b] 正常消化不泄露');

const regAlgOps = renderLatex('\\begin{algorithmic}\\State x \\gets y\\For{i = 1 \\to n}\\State \\Return \\TRUE \\AND \\NOT \\FALSE\\EndFor\\end{algorithmic}');
ok(regAlgOps.warnings.length === 0 && regAlgOps.html.includes('&larr;') && regAlgOps.html.includes('&rarr;') && regAlgOps.html.includes('true'), '宏包回归: 算法文本态 \\gets \\to \\TRUE 符号正常渲染零警告');

const regTabCap = renderLatex('\\begin{table}\\caption{表头}\\begin{tabular}{c}A\\end{tabular}\\end{table}');
ok(regTabCap.html.indexOf('<figcaption') < regTabCap.html.indexOf('<table'), '宏包回归: 表格题注置于表格上方');

const regFloatSpan = renderLatex('\\begin{figure*}\\caption{F}\\end{figure*}\\begin{table*}\\caption{T}\\end{table*}\\begin{algorithm*}\\caption{A}\\end{algorithm*}');
ok(regFloatSpan.html.includes('fig float-span') && regFloatSpan.html.includes('tab float-span') && regFloatSpan.html.includes('algorithm float-span'), '宏包回归: figure*/table*/algorithm* 挂载 float-span 跨栏类');

// 8. 第四轮宏包审查缺陷回归验证
const regCapStar = renderLatex('\\begin{figure}\\caption*{无编号主图题注}\\end{figure}\\begin{figure}\\begin{subfigure}{0.4\\textwidth}\\subcaption*{无编号子图}\\end{subfigure}\\end{figure}');
ok(regCapStar.html.includes('<figcaption>无编号主图题注</figcaption>') && regCapStar.html.includes('class="subfig-cap">无编号子图</div>'), '宏包回归: caption* 与 subcaption* 无编号题注完整保留且无图号前缀');

const regColor = renderLatex('\\textcolor{red}{红字} 与 \\colorbox{yellow}{黄底}');
ok(regColor.warnings.length === 0 && regColor.html.includes('style="color:red"') && regColor.html.includes('background-color:yellow'), '宏包回归: textcolor 与 colorbox 正常着色零警告');

const regResize = renderLatex('\\begin{table}\\resizebox{\\textwidth}{!}{\\begin{tabular}{c}X\\end{tabular}}\\end{table}');
ok(regResize.warnings.length === 0 && regResize.html.includes('class="resizebox"') && !regResize.html.includes('\\resizebox'), '宏包回归: resizebox 与 \\textwidth 正常包装零警告');

const regSi = renderLatex('\\SI{10}{m/s} 与 \\num{1.23} 与 \\si{kg/m^3} 与 \\ang{45}');
ok(regSi.warnings.length === 0 && regSi.html.includes('si-quantity') && regSi.html.includes('45&deg;'), '宏包回归: siunitx 核心宏零警告正常格式化');

const regTabFn = renderLatex('\\begin{tabular}{c}A\\tablefootnote{表注}\\end{tabular}');
ok(regTabFn.warnings.length === 0 && regTabFn.html.includes('fnref') && regTabFn.html.includes('表注'), '宏包回归: tablefootnote 正常渲染进脚注列表');

const regUrlEsc = renderLatex('\\url{https://foo.com/a\\_b}');
ok(regUrlEsc.html.includes('href="https://foo.com/a_b"'), '宏包回归: url 包含转义下划线时反转义');

// ---------- 排版语法的静态检测 ----------
console.log('== 排版语法检测 ==');
const dupCls = lintLaTeX('\\documentclass{IEEEtran}\n\\begin{document}\n\\documentclass[conference]{IEEEtran}\n\\end{document}');
ok(dupCls.some(d => d.kind === 'class' && d.line === 2 && d.severity === 'error'), '重复 \\documentclass 定位到第 3 行: ' + JSON.stringify(dupCls.filter(d => d.kind === 'class')));
const conflict = lintLaTeX('\\documentclass[onecolumn,twocolumn]{IEEEtran}\n\\begin{document}x\\end{document}');
ok(conflict.some(d => d.kind === 'class' && d.line === 0 && d.severity === 'warn'), '互斥选项给出行级警告');
ok(lintLaTeX('\\documentclass[journal]{IEEEtran}\n\\begin{document}x\\end{document}').filter(d => d.kind === 'class').length === 0, '合法选项不警告');
ok(lintLaTeX(samples.ieee).filter(d => d.kind === 'class').length === 0, 'IEEE 示例无文档类诊断');
setLang('en');
ok(lintLaTeX('\\documentclass[twocolumn,onecolumn]{IEEEtran}').some(d => d.kind === 'class' && /mutually exclusive/.test(d.msg)), '英文选项冲突文案');
setLang('zh');

// ---------- 主题皮肤 ----------
console.log('== 主题皮肤 ==');
const readSrc = f => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const themesCss = readSrc('themes.css');
const appCss = readSrc('app.css');
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
// 打印样式与图表波浪线 data-URI 必须固定白/固定色，允许出现字面颜色
const printBlock = (appCss.match(/@media print\s*\{[\s\S]*?\n\}/) || [''])[0];
const chrome = stripComments(appCss.replace(printBlock, '')).replace(/url\("[^"]*"\)/g, 'url()');
const chromeColors = chrome.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d/g) || [];
ok(!chromeColors.length, 'app.css 界面样式不该写死颜色：' + chromeColors.join(' '));
ok(detectTheme() === DEFAULT_THEME, '读不到偏好时回退默认皮肤');

// 每套皮肤 = 一个 /* @palette */ 块，且 token 集合完全一致（少一个就会露出默认暖白）
const palettes = [...themesCss.matchAll(/\/\* @palette \*\/\s*([^{}]*)\{([^{}]*)\}/g)]
  .map(m => ({ sel: m[1], body: m[2], ids: [...m[1].matchAll(/data-theme="([^"]+)"/g)].map(x => x[1]) }));
ok(palettes.length === THEME_IDS.length, '每套皮肤一个 @palette 块：' + palettes.length + ' vs ' + THEME_IDS.length);
const tokensOf = body => [...new Set((body.match(/(^|[;{\s])(--[a-z0-9-]+)\s*:/g) || []).map(s => s.replace(/[^a-z0-9-]/g, '')))];
const inkTokens = tokensOf(palettes[0].body);
ok(palettes.every(p => p.ids.some(id => THEME_IDS.includes(id))), '调色板都对应已注册皮肤');
ok(inkTokens.some(t => t.startsWith('--doc-')) && inkTokens.some(t => t.startsWith('--syn-')) === false, '@palette 块含纸面色调、不含语法色');
for (const p of palettes.slice(1)) {
  const mine = tokensOf(p.body);
  for (const t of inkTokens) ok(mine.includes(t), p.ids.join('/') + ' 缺少 token ' + t);
  for (const t of mine) ok(inkTokens.includes(t), p.ids.join('/') + ' 多出 token ' + t);
}

// 皮肤 id 三方对齐：theme.js 注册表 ↔ themes.css 的 [data-theme] / [data-pick] ↔ DICT 文案
for (const id of THEME_IDS) {
  ok(new RegExp('\\[data-theme="' + id + '"\\]').test(themesCss), '缺少 [data-theme="' + id + '"] 调色板');
  ok(new RegExp('\\[data-pick="' + id + '"\\]').test(themesCss), '缺少 [data-pick="' + id + '"] 缩略色');
  for (const l of ['zh', 'en']) ok(DICT[l]['theme.' + id], l + ' 缺少文案 theme.' + id);
}
ok(THEME_IDS.includes(DEFAULT_THEME) && palettes[0].sel.includes(':root'), '默认皮肤挂在 :root 上兜底');

// 选择器缩略色与真实调色板同源
const propVal = (body, name) => (body.match(new RegExp(name + '\\s*:\\s*([^;]+);')) || [, ''])[1].trim().toLowerCase();
for (const p of palettes) for (const [pick, real] of Object.entries(PICK_TO_TOKEN)) {
  const block = (themesCss.match(new RegExp('\\[data-pick="' + (p.ids[0]) + '"\\] \\{([^}]*)\\}')) || [, ''])[1];
  ok(propVal(block, pick) === propVal(p.body, real), p.ids[0] + ' 的 ' + pick + ' 缩略色与调色板不一致');
}

// app.css 用到的变量都得有定义，否则该处直接失去颜色
const declared = new Set((stripComments(appCss + themesCss).match(/(^|[;{\s])(--[a-z0-9-]+)\s*:/g) || []).map(s => s.replace(/[^a-z0-9-]/g, '')));
const referenced = new Set([...(appCss + themesCss).matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]));
for (const v of referenced) ok(declared.has(v), '变量无人定义：' + v);

console.log('== 诊断生命周期 ==');
const compileError = { line: 0, msg: 'Undefined control sequence' };
// 过期判断由 useCompile 的 staleNow 闭包负责（入口文档内容是否又变了），
// 不再比较 result.source 与当前标签全文——主文档入口编译时两者永不相等
const compiled = { tabId: 1, source: '\\unknown', errors: [compileError], staleNow: () => false };
ok(currentCompileErrors(compiled, 1).length === 1, '发起标签未改动时显示编译错误');
ok(currentCompileErrors({ ...compiled, staleNow: () => true }, 1).length === 0, '入口文档改动后不再显示旧编译错误');
ok(currentCompileErrors(compiled, 2).length === 0, '另一文件不继承错误');
ok(currentCompileErrors(null, 1).length === 0, '无编译结果时不显示编译错误');
const issues = collectIssues(
  [{ line: 1, msg: '引用了未定义的标签', severity: 'warn', kind: 'ref' }],
  [{ msg: '环境 xyz 按普通内容处理', line: 4, kind: 'env' }, { msg: '与静态检查同类的引用提示', line: 1, kind: 'ref' }, { msg: '渲染中断', line: null }],
  [compileError]
);
ok(issues.map(d => d.src).join(',') === 'compile,lint,render,render', '统一收集全部诊断并保留来源');
ok(!issues.some(d => d.msg === '与静态检查同类的引用提示'), '同一行同一类问题只留静态检查那条');
ok(issues.some(d => d.src === 'render' && d.line === 4), '渲染警告带行号，问题栏才能给出「第 N 行」并跳转');
ok(new Set(issues.map(d => d.id)).size === 4, '每条提示独立标识，可逐条忽略');
const remaining = issues.filter(d => d.id !== issues[0].id);
ok(remaining.length === 3 && remaining.filter(d => d.line != null).length === 2, '忽略编译错误时计数和行内标记同步移除');
// 引擎侧：警告要落在出问题的那一行，而不是整篇
const warnRes = renderLatex('\\documentclass{article}\n\\begin{document}\n正文 \\zzUnknown 正文\n见 \\ref{missing}。\n\\end{document}');
ok(warnRes.warnings.some(w => w.kind === 'command' && w.line === 2), '不支持的命令落在自己的行: ' + JSON.stringify(warnRes.warnings));
ok(warnRes.warnings.some(w => w.kind === 'ref' && w.line === 3), '未定义引用落在 \\ref 所在行: ' + JSON.stringify(warnRes.warnings));

console.log('== 上下文预算（token 口径）==');
ok(C.inferWindow('claude-sonnet-4-5') === 200000, 'Claude 200k');
ok(C.inferWindow('gpt-4o') === 128000 && C.inferWindow('deepseek-chat') === 64000, 'OpenAI 128k / DeepSeek 64k');
ok(C.inferWindow('moonshot-v1-32k') === 32000, '模型名后缀显式窗口');
ok(C.inferWindow('glm-5.3') === 1000000 && C.inferWindow('glm-5.3-flash') === 200000 && C.inferWindow('glm-5.3-flash[1m]') === 1000000, 'GLM-5.3 1M / flash 200k / flash[1m] 1M');
ok(C.inferWindow('MiniMax-M3.1-Flash') === 524288, 'MiniMax M3.1 524k');
ok(C.inferWindow('some-random-model') === 0 && C.inferWindow('') === 0, '认不出返回 0');
ok(C.resolveWindow({ chatModel: 'gpt-4o' }).tokens === 128000, '默认按模型推断');
ok(C.resolveWindow({ chatModel: 'gpt-4o', ctxWindow: 8000 }).tokens === 8000, '自定义覆盖优先于推断');
ok(C.resolveWindow({ chatModel: 'unknown-x' }).tokens === C.FALLBACK_WINDOW, '未知模型走兜底窗口');
const chDs = { chatModel: 'deepseek-chat' };
ok(C.inputBudget(chDs) === C.resolveWindow(chDs).tokens - C.outputReserve(chDs) - Math.max(256, Math.round(64000 * 0.02)), '输入预算 = 窗口 − 输出预留 − 估算余量');
ok(C.estimateTokens('') === 0, '空文本 0 token');
ok(C.estimateTokens('这是一段中文论文引言') > 8 && C.estimateTokens('This is an introduction paragraph.') < 10, '中文按字计、英文按密度计');
ok(C.formatTokens(999) === '999' && C.formatTokens(12345) === '12.3k' && C.formatTokens(200000) === '200k', 'token 缩写');
const longDoc = 'A'.repeat(40000) + '\n' + '研究'.repeat(2000);
const cutDoc = C.truncateToTokens(longDoc, 500, '……中略……');
ok(C.estimateTokens(cutDoc) <= 500 && cutDoc.includes('中略') && cutDoc.length < longDoc.length, '按 token 截断且不超预算: ' + C.estimateTokens(cutDoc));
ok(C.truncateToTokens('short text', 500, '……') === 'short text', '未超预算原样返回');
const hist = [];
for (let i = 0; i < 24; i++) hist.push({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(2000) });
const built = C.buildPayload({ system: 'sys', docHeader: 'DOC', doc: 'd'.repeat(8000), summaryHeader: 'SUM', history: hist, budget: 8000 });
ok(built.usage.total <= 8000 && built.usage.dropped > 0, '历史超预算时丢最早条: total=' + built.usage.total + ' dropped=' + built.usage.dropped);
ok(built.messages[0].role === 'system' && built.messages[1].role === 'system' && built.messages[1].content.startsWith('DOC'), '系统提示与文档块在最前');
ok(built.messages[built.messages.length - 1].content === hist[hist.length - 1].content, '本轮提问始终保留');
const tight = C.buildPayload({ system: 's', history: [{ role: 'user', content: 'hi' }], budget: 10 });
ok(tight.messages.length === 2 && tight.usage.dropped === 0, '预算极小也至少保留本轮提问');
const withSummary = C.buildPayload({
  system: 's', summaryHeader: 'SUM', budget: 8000,
  history: [{ role: 'assistant', kind: 'summary', content: '要点' }, ...hist.slice(-4)]
});
ok(withSummary.messages[1].role === 'system' && withSummary.messages[1].content.startsWith('SUM'), '摘要按 system 注入而非冒充用户发言');
const sp = C.splitForCompact(hist, 6);
ok(sp && sp.head.length === hist.length - 6 && sp.tail.length === 6, '压缩切分保留末尾 6 条');
ok(C.splitForCompact(hist.slice(0, 6), 6) === null, '对话太短不压缩');
ok(C.splitForCompact(new Array(9).fill({ role: 'assistant', kind: 'summary', content: 'a' }), 6) === null, '只剩摘要时不重复压缩');
ok(C.summaryBudget({ chatModel: 'claude-sonnet-4-5' }) <= 2000 && C.summaryBudget({ chatModel: 'glm-4.5-flash' }) >= 600, '摘要预算夹在 600~2000，避免摘要请求打满窗口');
ok(C.rawUsage({ system: 'sys', history: hist }).total > built.usage.history, 'rawUsage 不裁剪，可显示超出预算');
ok(C.historyToText([{ role: 'user', content: 'u' }, { role: 'assistant', kind: 'summary', content: 's' }], { user: 'U', assistant: 'A', summary: 'S' }).split('\n')[1].startsWith('S:'), '摘要历史再次压缩时保留标记');

console.log('== 预览国际化 ==');
const bilingualSource = String.raw`\documentclass{ctexart}
\begin{document}
\maketitle\today
\begin{abstract}Author content stays unchanged.\end{abstract}
\tableofcontents\section{Author heading}
\begin{figure}Image\caption{Author caption}\label{fig:a}\end{figure}
\begin{table}Data\caption{Author table}\end{table}
\Cref{fig:a}\eqref{eq:a}\cite{missing}
\begin{thebibliography}{9}\bibitem{a}Author reference\end{thebibliography}
\end{document}`;
setLang('en');
const englishPreview = renderLatex(bilingualSource);
for (const text of ['Abstract', 'Contents', 'References', 'Figure&nbsp;1: ', 'Table&nbsp;1: ', 'Untitled document', 'Not found in references', 'Eq.&nbsp;', 'Figure 1']) {
  ok(englishPreview.html.includes(text), '英文预览包含 ' + text);
}
ok(!/[\u4e00-\u9fff]/.test(englishPreview.html), 'ctex 文档的英文预览无内置中文文案');
ok(englishPreview.warnings.some(w => w.msg.includes('Undefined reference')), '英文引用诊断');
setLang('zh');
const chinesePreview = renderLatex(bilingualSource);
for (const text of ['摘要', '目录', '参考文献', '图&nbsp;1：', '表&nbsp;1：', '无标题文档']) {
  ok(chinesePreview.html.includes(text), '切回中文预览包含 ' + text);
}
ok(chinesePreview.html.includes('Author content stays unchanged.'), '切语言保留作者正文');
// 英文完整性：这些命名空间是界面文案，缺 en 或夹了汉字都会在英文界面上露出中文
// （mb.* 是移动端各 flow 的文案，见 src/flows/mobile/i18n/）
for (const key of Object.keys(DICT.zh).filter(k => k.startsWith('style.') || k.startsWith('render.') || k.startsWith('mb.') || k.startsWith('hist.'))) {
  ok(typeof DICT.en[key] === 'string' && DICT.en[key].length > 0, '英文文案存在: ' + key);
  ok(!/[\u4e00-\u9fff]/.test(DICT.en[key]), '英文翻译完整: ' + key);
}

// \begin 与 { 之间的空格是合法 TeX：曾经只认 \begin{，导致降级成「不支持的命令」
const spacedEnv = renderLatex('\\documentclass{article}\n\\begin{document}\n\\begin {center}\n居中文字\n\\end {center}\n\\end{document}');
ok(spacedEnv.html.includes('居中文字'), '\\begin {center} 空格写法照常渲染');
ok(!spacedEnv.warnings.some(w => (w.msg || '').includes('不支持') || /unsupported/i.test(w.msg || '')), '不产生 unsupported 警告');
// \beginfoo 是普通命令名：不得把后文真正的环境当成它的一部分吞掉
const fakeBegin = renderLatex('\\documentclass{article}\n\\begin{document}\n\\beginfoo x\\par 前文保留\\begin {center}内文\\end{center}\n\\end{document}');
ok(fakeBegin.html.includes('前文保留'), '\\beginfoo 不吞后文正文');
ok(fakeBegin.html.includes('内文'), '后接的真实环境照常渲染');

// 坏文件（截断下载、连写漏括号）不该把主线程锁死：以下三种都曾是 O(N·L)，
// 240KB 输入实测 8.1s / 4.1s / 5.2s，现在必须停在毫秒级
{
  const cases = [
    ['未闭合 \\begin', (String.raw`\begin{figure}x`).repeat(16000)],
    ['未闭合 \\label{', (String.raw`\section{` + String.raw`\label{a`).repeat(8000)],
    ['未闭合 \\caption[', String.raw`\begin{figure}` + (String.raw`\caption[` + 'x').repeat(8000) + String.raw`\end{figure}`],
    ['未闭合 \\bibitem[', String.raw`\begin{thebibliography}{9}` + (String.raw`\bibitem[` + 'k').repeat(8000)],
  ];
  for (const [name, chunk] of cases) {
    const src = String.raw`\documentclass{article}\begin{document}` + '\n' + chunk;
    const t0 = Date.now();
    renderLatex(src);
    const ms = Date.now() - t0;
    ok(ms < 1500, name + ' 大批量渲染保持线性, got ' + ms + 'ms');
  }
}

// 嵌套列表：只切顶层 \item，内层交给递归
{
  const nestedList = renderLatex(String.raw`\documentclass{article}\begin{document}\begin{enumerate}\item a\begin{itemize}\item b\end{itemize}\item c\end{enumerate}\end{document}`);
  ok(/<ol[\s\S]*?<li>[\s\S]*?<ul/.test(nestedList.html), '嵌套列表生成内层 ul');
  ok(!nestedList.html.includes('beginitemize'), '内层 \\begin 不漏成正文');
}

// 一个环境可以带多个 \label，真 LaTeX 让它们都指向同一编号
{
  const multiLab = renderLatex(String.raw`\documentclass{article}\begin{document}\begin{figure}\caption{题注\label{f1}\label{f2}}\end{figure}见\ref{f1}与\ref{f2}\end{document}`);
  ok(!/bad-ref/.test(multiLab.html), '同环境多个 \\label 都能引用');
  ok(multiLab.html.includes('图&nbsp;1') || (multiLab.html.match(/bad-ref/g) || []).length === 0, '浮动体照常编号');
}

// 未闭合的行内 $ 不该把后面的章节整段吞进公式
{
  const dollar = renderLatex(String.raw`\documentclass{article}\begin{document}单价 $50 每件。` + '\n\n' +
    String.raw`\section{结果}` + '\n以及 $x$ 与 $y$。\n' + String.raw`\end{document}`);
  ok(/<h2[^>]*>[\s\S]{0,80}结果/.test(dollar.html), '未闭合行内 $ 不吞后续章节标题');
  ok(dollar.headings.some(h => h.text.includes('结果')), '大纲仍有该章节');
}

// 深嵌套：打爆 JS 栈会让整篇预览只剩一个错误框
{
  let deepErr = null, deepRes = null;
  try {
    deepRes = renderLatex(String.raw`\documentclass{article}\begin{document}` + String.raw`\textbf{`.repeat(2000) +
      'x' + '}'.repeat(2000) + String.raw`\end{document}`);
  } catch (e) { deepErr = e; }
  ok(!deepErr, '深嵌套不再打爆调用栈');
  ok(deepRes && deepRes.warnings.some(w => /嵌套层级|Nesting deeper/.test(w.msg || '')), '深嵌套给出可读警告');
}

// 内部占位符改用 NUL 定界：正文里的 @@ 记号该原样显示，也不该被误判成引用
{
  const marks = renderLatex(String.raw`\documentclass{article}\begin{document}正文 @@COLS@@ 与 @@R:x@@ 与 @@TOC@@ 保持原样\end{document}`);
  ok(marks.html.includes('@@COLS@@') && marks.html.includes('@@R:x@@') && marks.html.includes('@@TOC@@'), '正文里的 @@ 记号不被当占位符回填');
  ok(!/bad-ref/.test(marks.html), '正文里的 @@R:x@@ 不误报未定义引用');
  const headMark = renderLatex(String.raw`\documentclass{article}\begin{document}\section{见\ref{nope}}\end{document}`);
  ok(!headMark.headings.some(h => (h.text || '').includes('\u0000')), '大纲标题不含占位符控制字符');
}

// 大表与坏 \cite 的线性守卫：行→原始行回填以前每行都从 rawRows[0] 重找，
// 64000 行实测 4.3s；linter 的 (?:\[[^\]]*\])?\{ 在缺 ] 时逐个候选重扫余文
{
  const bigRows = String.raw`\documentclass{article}\begin{document}` + '\n' +
    String.raw`\begin{tabular}{c}a` + '\\\\a'.repeat(16000) + String.raw`\end{tabular}` + '\n' + String.raw`\end{document}`;
  const t0 = Date.now();
  const res = renderLatex(bigRows);
  ok(Date.now() - t0 < 1500, '64k 行级大表保持线性, got ' + (Date.now() - t0) + 'ms');
  ok(res.tables.length === 1 && res.tables[0].rows.length > 15000, '大表仍逐行登记元数据（可视化表格编辑要靠它写回）');
  const lastRow = res.tables[0].rows.at(-1);
  ok(lastRow.hasFollowingRow === false, '末行不该认为自己还有后继行');
  const badCite = String.raw`\documentclass{article}\begin{document}` + '\n' + (String.raw`\cite[` + 'a').repeat(16000);
  const t1 = Date.now();
  lintLaTeX(badCite);
  ok(Date.now() - t1 < 1500, '未闭合 \\cite[ 大批量 lint 保持线性, got ' + (Date.now() - t1) + 'ms');
  const okCite = lintLaTeX(String.raw`\documentclass{article}\begin{document}\cite[a,2020]{k1} 与 \citep{k2,k3}\end{document}`);
  ok(okCite.filter(i => i.kind === 'cite').length === 3, '\\cite 可选参数与多键列表照常逐条校验');
}

// \end{verbatim} 紧跟的 % 是注释（以前的偏移多算一个字符，把它一起吃掉）
{
  const verbTail = renderLatex(String.raw`\documentclass{article}\begin{document}` + '\n' +
    String.raw`\begin{verbatim}` + '\n% 示例注释\n' + String.raw`\end{verbatim}` + '%这行是注释\n\n正文\n' + String.raw`\end{document}`);
  ok(verbTail.html.includes('% 示例注释'), '逐字环境内的 % 不当注释');
  ok(!verbTail.html.includes('这行是注释'), '逐字环境结束后的 % 正常当注释');
  ok(verbTail.html.includes('正文'), '后续正文照常渲染');
}

// \draw 后连写的 ( 以前逐个候选把余文扫到串尾（×40000 实测 3.1s 二次方）；
// 水位线之后要回到线性，同时正常坐标与 node 文本必须照常配上
{
  const tctx = () => ({ styles: {}, macros: {}, tikzsetRanges: [], defaultFontPx: 13 });
  const tBad = Date.now();
  TIKZ.render(String.raw`\draw` + '('.repeat(40000), '', 0, tctx());
  ok(Date.now() - tBad < 800, '未闭合括号大批量 tikz 保持线性, got ' + (Date.now() - tBad) + 'ms');
  const good = TIKZ.render(String.raw`\draw (0,0) -- (2,1) node[right]{标签} -- (3,0);`, '', 0, tctx());
  ok(good.svg && good.svg.includes('标签'), '坐标与 node 文本照常解析');
  const half = TIKZ.render(String.raw`\draw (0,0) -- ((2,1) -- (3,0);`, '', 0, tctx());
  ok(!!half.svg, '局部配平的坏路径仍出图，不是整幅报废');
}

// ---------- 病态输入的线性与数值夹取 ----------
{
  const docOf = body => '\\documentclass{article}\n\\begin{document}\n' + body + '\n\\end{document}\n';
  // 未闭合 \[ 以前每个都把余文扫到 EOF（88KB→0.4s，翻倍×4），现在靠「最后位置 + 负水位线」收成线性
  const tMath = Date.now();
  const badMath = renderLatex(docOf(String.raw`\[ `.repeat(20000)), {});
  ok(Date.now() - tMath < 800, '大批未闭合 \\[ 保持线性, got ' + (Date.now() - tMath) + 'ms');
  ok(!!badMath.html, '病态输入仍出结果，不是整页空白');
  // 水位线不能吃掉后面的合法公式
  const mixed = renderLatex(docOf(String.raw`\[ 未闭合 a+b` + '\n\n' + String.raw`\[ c+d \]` + '\n'), {});
  ok(mixed.html.includes('katex') || mixed.html.includes('equation'), '前一个未闭合不该让后一个合法公式也不渲染');

  // \caption[ 长跑无近端 ]：以前每条都扫到那个孤零零的 ]
  const tOpt = Date.now();
  renderLatex(docOf(String.raw`\caption[ `.repeat(20000) + ']'), {});
  ok(Date.now() - tOpt < 800, '超跨度的可选参数按「没有可选参数」处理，保持线性, got ' + (Date.now() - tOpt) + 'ms');
  const fig = renderLatex(docOf(String.raw`\begin{figure}[h]\caption[短标题]{长标题}\end{figure}`), {});
  ok(fig.html.includes('长标题') && !fig.html.includes('[短标题]') && !fig.html.includes('[h]'),
    '正常长度的可选参数照常读出并消费掉（不该以方括号原样出现在正文里）：' + fig.html);

  // 数值只校验形状不校验量级时，9999999in 会原样进 style 把排版撑爆
  const huge = renderLatex(docOf('\\begin{tabular}{p{9999999in}}a\\end{tabular}'), {});
  const w = (/width:([\d.]+)px/.exec(huge.html) || [])[1];
  ok(w !== undefined && Number(w) <= 20000, 'p{9999999in} 的宽度要夹到合理上限, got ' + w);
  const neg = renderLatex(docOf(String.raw`甲\\[-3pt]乙`), {});
  ok(neg.html.includes('margin-top:-3.99px'), '负的 \\vspace 类长度仍按原值出（夹取只砍极端）');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

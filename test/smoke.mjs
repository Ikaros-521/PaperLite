/* PaperLite 冒烟测试（Node + 真实 KaTeX） */
import { renderLatex } from '../src/engines/latex.js';
import { renderMarkdown, renderMarkdownFull } from '../src/engines/markdown.js';
import { lintLaTeX } from '../src/engines/linter.js';
import * as TIKZ from '../src/engines/tikz.js';
import { samples } from '../src/engines/samples.js';

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
ok(res.warnings.length === 0, '零警告, got: ' + res.warnings.slice(0, 5).join(' | '));
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
ok(res2.warnings.length === 0, 'flow 零警告, got: ' + res2.warnings.slice(0, 5).join(' | '));

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

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

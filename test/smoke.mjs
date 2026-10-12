/* PaperLite React 版冒烟测试（Node + 真实 KaTeX） */
import { renderLatex } from '../src/engines/latex.js';
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

// ---------- 源码区间回切（面板回写前提） ----------
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

// 模拟面板改样式（写回工具函数）
if (blockRange) {
  const list = TIKZ.parseOpts(src.slice(blockRange.start, blockRange.end));
  TIKZ.setOpt(list, 'fill', 'red!40');
  const rebuilt = TIKZ.buildOpts(list);
  ok(rebuilt.includes('fill=red!40') && rebuilt.startsWith('rectangle, rounded corners=6pt'), '选项重建');
}

// ---------- flow 模板 ----------
console.log('== flow 模板 ==');
const res2 = renderLatex(samples.flow);
const dg2 = res2.diagrams[0];
ok(res2.diagrams.length === 1 && dg2.nodes.length >= 6, 'flow 节点数 >= 6, got ' + (dg2 ? dg2.nodes.length : 0));
ok(dg2.svg.includes(' Q '), 'bend 曲线');
ok((dg2.svg.match(/marker-end/g) || []).length >= 6, '箭头数 >= 6');
ok(res2.warnings.length === 0, 'flow 零警告, got: ' + res2.warnings.slice(0, 5).join(' | '));

// ---------- blank + 颜色 ----------
console.log('== blank / 颜色 ==');
ok(renderLatex(samples.blank).html.includes('摘要内容'), 'blank 渲染');
ok(TIKZ.parseColor('blue!20') === '#ccccff', 'blue!20');
ok(TIKZ.parseColor('red!50!blue') === '#800080', 'red!50!blue');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

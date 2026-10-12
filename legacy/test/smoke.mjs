/* PaperLite 冒烟测试（Node，无 DOM）：
 *  1. 三份模板能完整渲染且包含关键结构；
 *  2. tikz 节点/样式记录的源码区间能精确回切到原文（样式面板回写的前提）；
 *  3. 选项解析/重建工具函数可用。
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = {
  console,
  performance: { now: () => Date.now() },
  katex: {
    renderToString: (tex, opts) => `<span class="katex-mock">${tex.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>`
  }
};
vm.createContext(sandbox);
for (const f of ['js/samples.js', 'js/tikz.js', 'js/latex.js']) {
  vm.runInContext(readFileSync(join(root, f), 'utf8'), sandbox, { filename: f });
}
const PL = sandbox.PaperLite;

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ FAIL:', msg); }
}

// ---------- demo 模板 ----------
console.log('== demo 模板 ==');
const src = PL.samples.demo;
const res = PL.latex.render(src);
ok(res.html.includes('摘要'), '包含摘要');
ok(res.html.includes('doc-title'), '包含标题块');
ok((res.html.match(/<h2 /g) || []).length === 5, '5 个一级章节, got ' + (res.html.match(/<h2 /g) || []).length);
ok(res.html.includes('class="equation"'), '包含公式');
ok(res.html.includes('eq-no">(1)<'), '公式编号 (1)');
ok(res.html.includes('tabular'), '包含表格');
ok(res.html.includes('r-toprule'), '三线表 top 规则线');
ok(res.html.includes('图&nbsp;1：'), '图 1 题注');
ok(res.html.includes('表&nbsp;2：'), '表 2 题注（第二张表）');
ok(res.html.includes('BiLSTM-Att'), '宏 \\model 已展开');
ok(res.html.includes('豆瓣电影 数据集') || res.html.includes('数据集'), '宏 \\dataset 已展开');
ok(res.html.includes('参考文献'), '参考文献');
ok(res.html.includes('bib-liu2012sentiment'.replace('bib-','id="bib-liu2012sentiment"').slice(0,20)), 'bibitem id');
ok((res.html.match(/\[1\]/g) || []).length >= 1, '引用回填 [1]');
ok(res.html.includes('mermaid-block'), 'mermaid 块');
ok(res.html.includes('footnotes'), '脚注');
ok(res.diagrams.length === 1, '1 个 tikz 图, got ' + res.diagrams.length);
console.log('warnings:', res.warnings.length ? res.warnings.slice(0, 10) : '(none)');

// ---------- 源码区间回切（样式面板回写核心前提） ----------
console.log('== 区间回切 ==');
const dg = res.diagrams[0];
ok(dg.svg && dg.svg.includes('<svg'), 'tikz svg 生成');
ok((dg.svg.match(/class="tk-node"/g) || []).length === 7, '7 个绘制节点, got ' + (dg.svg.match(/class="tk-node"/g) || []).length);
ok(dg.svg.includes('marker-end'), '箭头 marker');
const rawNode = dg.nodes.filter(n => n.name === 'raw')[0];
ok(!!rawNode, '节点 raw 存在');
if (rawNode) {
  const cut = src.slice(rawNode.optStart, rawNode.optEnd);
  ok(cut.startsWith('data, text width=2.6cm'), `raw 选项回切正确: "${cut}"`);
}
const decNode = dg.nodes.filter(n => n.name === 'dec')[0];
ok(!!decNode && decNode.shape === 'diamond', '菱形节点识别');
const blockRange = dg.tikzsetRanges.filter(r => r.name === 'block')[0];
ok(!!blockRange, 'block 样式区间存在');
if (blockRange) {
  const cut = src.slice(blockRange.start, blockRange.end);
  ok(cut.startsWith('rectangle, rounded corners=6pt'), `block 样式回切正确: "${cut.slice(0, 40)}"`);
}

// ---------- 模拟样式面板改色 ----------
console.log('== 模拟面板改样式 ==');
if (blockRange) {
  const list = PL.tikz.parseOpts(src.slice(blockRange.start, blockRange.end));
  PL.tikz.setOpt(list, 'fill', 'red!40');
  PL.tikz.setOpt(list, 'draw', null);
  const rebuilt = PL.tikz.buildOpts(list);
  ok(rebuilt.startsWith('rectangle, rounded corners=6pt') && rebuilt.includes('fill=red!40'), '重建选项串: ' + rebuilt.slice(0, 60));
}

// ---------- flow 模板 ----------
console.log('== flow 模板 ==');
const res2 = PL.latex.render(PL.samples.flow);
ok(res2.diagrams.length === 1, 'flow 有 1 图');
const dg2 = res2.diagrams[0];
ok(dg2.nodes.length >= 6, 'flow 节点数 >= 6, got ' + dg2.nodes.length);
ok(dg2.svg.includes(' Q '), 'bend 曲线存在');
ok((dg2.svg.match(/marker-end/g) || []).length >= 6, '箭头数 >= 6');
const startNode = dg2.nodes.filter(n => n.name === 'start')[0];
ok(startNode && startNode.roundedPt > 0, 'start 圆角');
const memoRange = dg2.tikzsetRanges.filter(r => r.name === 'memo')[0];
ok(!!memoRange, 'memo 样式区间');
if (memoRange) ok(PL.samples.flow.slice(memoRange.start, memoRange.end).startsWith('rectangle, dashed'), 'memo 样式回切');
console.log('warnings:', res2.warnings.length ? res2.warnings.slice(0, 8) : '(none)');

// ---------- blank 模板 ----------
console.log('== blank 模板 ==');
const res3 = PL.latex.render(PL.samples.blank);
ok(res3.html.includes('摘要内容'), 'blank 渲染');

// ---------- 颜色工具 ----------
console.log('== 颜色 ==');
ok(PL.tikz.parseColor('blue!20') === '#ccccff', 'blue!20 = #ccccff, got ' + PL.tikz.parseColor('blue!20'));
ok(PL.tikz.parseColor('red!50!blue') === '#800080', 'red!50!blue, got ' + PL.tikz.parseColor('red!50!blue'));
ok(PL.tikz.parseColor('{rgb,255:255,0,0}') === '#ff0000', 'rgb 形式');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

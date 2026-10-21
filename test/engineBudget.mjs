/* 渲染/检测的线性预算回归（Node）
 *
 * 钉住两类曾经成立的退化：
 *  1) 病态文档把主线程冻住——缺右括号的环境名 / \label / 长空白串起的 \newcommand /
 *     未闭合宏体，四种形状在修前都是二次方（328KB 级 5.6s、300KB 级 6.9s、
 *     12KB 就能 5.4s）。现在同输入应在几十毫秒内落完，给 1500ms 是 CI 上的余量。
 *  2) 文档正文里的键名撞进 Object 原型——\begin{constructor} 曾直接抛 TypeError，
 *     整页预览变成一条渲染异常横幅。现在按「未知环境/未定义引用」正常降级并出警告。
 * 口径与 src/projectIndex.js 的 collectLabels 注释一致：游标 + 水位线，不回正则重扫。
 */
import assert from 'node:assert/strict';
import { renderLatex } from '../src/engines/latex.js';
import { lintLaTeX } from '../src/engines/linter.js';

const B = String.fromCharCode(92);
const ms = (fn, src) => { const t0 = performance.now(); const r = fn(src); return { ms: performance.now() - t0, r }; };
const budget = 1500;

const pathological = [
  ['未闭合环境名 ×48000', B + 'begin{document}\n' + B + 'begin{'.repeat(48000), renderLatex],
  ['未闭合 label ×48000', B + 'documentclass{article}\n' + B + 'label{'.repeat(48000), lintLaTeX],
  ['未闭合 bibitem 可选参数 ×30000', B + 'bibitem['.repeat(30000), lintLaTeX],
  ['未闭合 ref ×48000', B + 'ref{'.repeat(48000), lintLaTeX],
  ['未闭合 documentclass ×30000', B + 'documentclass{'.repeat(30000), lintLaTeX],
  ['newcommand 后长空白 ×200', ('' + B + 'newcommand' + ' '.repeat(50)).repeat(200), renderLatex],
  ['未闭合宏体 ×20000', (B + 'newcommand{' + B + 'a}{').repeat(20000), renderLatex],
];
for (const [name, src, fn] of pathological) {
  const { ms: took, r } = ms(fn, src);
  assert.ok(Array.isArray(r) || typeof (r && r.html) === 'string', name + '：不该抛错');
  assert.ok(took < budget, name + '：' + took.toFixed(0) + 'ms 超过 ' + budget + 'ms 预算');
}

// 原型键不抛错、且按未定义处理（渲染出 ? 并给警告）
const protoDocs = [
  B + 'begin{constructor}x' + B + 'end{constructor}',
  B + 'label{constructor}' + B + 'ref{constructor}',
  B + 'label{__proto__}' + B + 'ref{__proto__}',
  '前文 ' + B + 'toString{y} 后文',
];
for (const doc of protoDocs) {
  const r = renderLatex(doc);
  assert.ok(typeof r.html === 'string', '原型键文档必须正常返回 html');
}
assert.ok(renderLatex(B + 'label{hasOwnProperty}' + B + 'ref{hasOwnProperty}').html.includes('?'),
  '没定义过的 constructor 型键名要按「未定义引用」画 ?，不能从原型链上取到值');

// 正常语义没被游标改写：嵌套列表分层、宏的可选参数、同名宏后者覆盖、ref 编号
const nested = renderLatex(B + 'begin{itemize}' + B + 'item 外' + B + 'begin{enumerate}' + B + 'item 内' + B + 'end{enumerate}' + B + 'end{itemize}');
assert.equal((nested.html.match(/<li>/g) || []).length, 2, '嵌套列表仍是两个顶层 li');
assert.ok(nested.html.includes('内'), '内层条目不能丢');
assert.ok(!nested.html.includes('beginitemize'), '内层环境标记不该漏成正文');

const optDoc = B + 'newcommand{' + B + 'bx}[2][红]{B:#1/#2}' + B + 'renewcommand{' + B + 'bx}[1]{仅一参#1}' + B + 'bx[蓝色]{正文}';
const optHtml = renderLatex(optDoc).html;
assert.ok(!optHtml.includes('蓝色正文') && !optHtml.includes('仅一参蓝色'),
  'argc=1 的宏不该把 [蓝色] 当参数吃掉（残留上一条定义的默认值就是这个表现）');

const numbered = renderLatex(B + 'section{甲}' + B + 'label{s}' + B + 'ref{s}');
assert.ok(numbered.html.includes('>1<') || /\b1\b/.test(numbered.html.replace(/<[^>]+>/g, ' ')), '正常 \ref 仍要编号');

console.log('engineBudget: all tests passed');

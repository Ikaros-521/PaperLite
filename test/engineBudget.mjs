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
import { renderMarkdownFull } from '../src/engines/markdown.js';
import { KATEX_MAX_SIZE } from '../src/previewBudget.js';
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

// ---- 正文里的 NUL 不许把整页预览顶掉 ----
// 占位符以 \x00 分界，而 escHtml 不吞 NUL：verbatim/verb 里出现 NUL + 畸形百分号时，
// 那段正文会被当成 \x00R:…\x00 占位符匹配上，旧写法在这直接 decodeURIComponent 抛
// URIError，界面上整篇预览换成一条「渲染器异常」。现在按未定义引用收口，其余照排。
const NUL = String.fromCharCode(0), LF = String.fromCharCode(10);
{
  const doc = B + 'begin{document}' + LF +
    B + 'begin{verbatim}' + LF + NUL + 'R:%zz' + NUL + LF +
    B + 'end{verbatim}' + LF + '后半段正文 $x^2$ 必须还在' + LF + B + 'end{document}';
  let r = null, threw = null;
  try { r = renderLatex(doc, {}); } catch (e) { threw = e; }
  assert.equal(threw, null, '畸形百分号只是正文里的字节，不该抛出：' + (threw && threw.message));
  assert.ok(r.html.includes('后半段正文'), '后半段照常渲染');
  assert.ok(r.html.includes('bad-ref'), '认不出的占位符按未定义引用显示 ?');
  assert.ok(!r.html.includes('%zz'), '原始片段不许渗进 HTML');
  const citeDoc = B + 'begin{document}' + LF + NUL + 'C:%zz' + NUL + LF + B + 'cite{a}' + LF + B + 'end{document}';
  let c2 = null;
  try { c2 = renderLatex(citeDoc, {}); } catch (e) { c2 = 'THREW ' + e.message; }
  assert.equal(typeof c2, 'object', 'cite 回填同样不抛：' + c2);
  const protoRef = renderLatex(B + 'ref{constructor}' + B + 'ref{toString}', {});
  assert.ok(protoRef.html.includes('bad-ref'), '原型键名的未定义引用正常降级（计数表得是无原型字典）');
}

// ---- KaTeX 尺寸闸：maxSize 默认 Infinity，\rule{100000em}{20em} 会原样进 CSS ----
// 只断言真的参与布局的值：annotation 里回显的是 LaTeX 源码本身，那里出现 100000em
// 是正常且隐藏的（mathml 层），拿整串 html 去 indexOf 会误判成「没夹住」
const cssLens = (html) => (html.match(/(?:border-right-width|border-top-width|width|height):\s*([\d.]+)em/g) || [])
  .map(s => parseFloat(s.replace(/[^\d.]/g, '')));
{
  const big = renderLatex('$' + B + 'rule{100000em}{20em}$', {});
  assert.ok(cssLens(big.html).length > 0, '夹具要真的产出尺寸样式');
  assert.ok(Math.max(...cssLens(big.html)) <= KATEX_MAX_SIZE + 0.001,
    '尺寸必须被夹到 KATEX_MAX_SIZE，实测 CSS: ' + JSON.stringify(cssLens(big.html)));
  const okDoc = renderLatex('$' + B + 'rule{3em}{1em}$', {});
  assert.ok(cssLens(okDoc.html).includes(3), '正常尺寸不该被夹：' + JSON.stringify(cssLens(okDoc.html)));
  const md = renderMarkdownFull('$' + B + 'rule{100000em}{20em}$');
  assert.ok(cssLens(md.html).length > 0 && Math.max(...cssLens(md.html)) <= KATEX_MAX_SIZE + 0.001,
    'Markdown 侧必须同口径，实测 CSS: ' + JSON.stringify(cssLens(md.html)));
}

console.log('engineBudget: all tests passed');

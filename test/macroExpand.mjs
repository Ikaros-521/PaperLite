/* 宏展开的线性预算与语义回归（Node）
 *
 * 钉住修前成立的退化：expandMacros 对每个文本片段都把整本宏字典的每个宏名各编译一条
 * 正则再扫一遍，代价是「片段数 × 宏数 × 片段长」。4000 条 \newcommand + 4000 段正文
 * （171KB，远没到预览的 1MB 源码闸）实测 31560ms 冻结主线程，每翻倍约 ×4.5；同输入现在 31ms。
 * 912a02b 只线性化了扫描侧 scanMacros，应用侧这条一直在。
 *
 * 换实现最大的风险是「先单遍扫本片出现过哪些宏」漏掉旧写法的某种匹配，所以断言逐条对着
 * 旧口径钉：极大字母 token、可选参数默认值、宏体里再套宏、同宏超 50 次、自增长上限、
 * 原型链键名。全量等价另用 HEAD 版引擎对 28 份文档（4 个内置样例 + 夹具 + 21 个对抗样例
 * + 两个规模样）逐字节比对 html/meta/warnings/headings/tables，确认一致后才收。
 *
 * 夹具口径：定义串与用串分开喂。把整份文档当纯文本展开时，\newcommand 行自身里的宏名
 * 也会被展开，断言就对不上真实渲染路径了。
 */
import assert from 'node:assert/strict';
import { renderLatex, expandMacros, scanMacros } from '../src/engines/latex.js';
import { macroNamesIn } from '../src/texScan.js';

const B = String.fromCharCode(92);
const N = String.fromCharCode(10);
const dict = (def) => scanMacros(def);
const Ax = (def, text) => expandMacros(text, dict(def), 0);
const budget = 1500;

// ---- 1. 规模闸：病态宏数量必须在线性预算内落完 ----
const nameOf = (i) => {
  let s = '', x = i;
  do { s = String.fromCharCode(97 + (x % 26)) + s; x = Math.floor(x / 26); } while (x >= 0 && s.length < 6);
  return s;
};
function macroDoc(count, perPara) {
  const names = [...Array(count)].map((_, i) => nameOf(i));
  assert.equal(new Set(names).size, count, '宏名必须互不相同，否则测的是同一个宏');
  let head = '', body = '';
  for (const n of names) head += B + 'newcommand{' + B + n + '}{xx}' + N;
  for (let p = 0; p < count; p++) {
    let line = 'para' + p + ' ';
    for (let k = 0; k < perPara; k++) line += B + names[(p + k) % count] + ' ';
    body += line + N + N;
  }
  return head + B + 'begin{document}' + N + body + B + 'end{document}' + N;
}
// 稀疏（每段一个宏）与稠密（每段 12 个宏）两条都要：稠密那条是「本片确实有很多宏」时
// 预扫之外剩下的第二条成本路径
for (const [n, per] of [[4000, 1], [1000, 12]]) {
  const src = macroDoc(n, per);
  assert.ok(src.includes(B + 'newcommand'), '夹具里的反斜杠不能丢');
  const t0 = performance.now();
  const r = renderLatex(src);
  const took = performance.now() - t0;
  assert.ok(typeof r.html === 'string' && r.html.length > 0, n + ' 宏文档必须正常渲染');
  assert.ok(took < budget, '宏 ' + n + '×' + per + '（' + (src.length / 1024).toFixed(0) + 'KB）：' + took.toFixed(0) + 'ms 超过 ' + budget + 'ms 预算');
}
// 宏必须真的被展开了，否则上面的耗时测的是「零宏」空输入。
// 踩过的坑：\newcommand{\m0} 这类带数字的名字 scanMacros 整条丢弃（宏名只收字母）。
{
  const src = macroDoc(200, 1);
  assert.equal(Object.keys(scanMacros(src)).length, 200, '字典必须注册满 200 个宏，否则基准测的是空输入');
  assert.ok(renderLatex(src).html.includes('xx'), '宏体没展开，性能断言测的是空输入');
}

// ---- 2. 匹配口径：与旧正则 \\name(?![A-Za-z]) 逐位一致 ----
const dMa = B + 'newcommand{' + B + 'ma}{A}';
assert.equal(Ax(dMa, B + 'mab'), B + 'mab', '极大字母 token：宏 ma 不得命中 \\mab');
assert.equal(Ax(dMa, B + 'ma?'), 'A?', '非字母后随即命中');
assert.equal(Ax(dMa, B + 'ma1'), 'A1', '宏名后跟数字算命中（旧写法靠 lookahead 放行）');
assert.equal(Ax(dMa, 'x' + B + 'ma'), 'xA', 'token 前紧邻的普通字符不影响');
assert.equal(Ax(B + 'def' + B + 'd{DD}', B + 'd ' + B + 'dd'), 'DD ' + B + 'dd', '\\def 语法同样只认极大 token');

// ---- 3. 参数与可选默认值 ----
assert.equal(Ax(B + 'newcommand{' + B + 'two}[2]{#1-#2}', B + 'two{a}{b}'), 'a-b', '双参按位置抓取');
const dC = B + 'newcommand{' + B + 'c}[2][blue]{#1/#2}';
assert.equal(Ax(dC, B + 'c[green]{red}'), 'green/red', '显式可选参数走 readOpt');
assert.equal(Ax(dC, B + 'c{red}'), 'blue/red', '省略可选参数时使用默认值');
assert.equal(Ax(dC, B + 'c'), B + 'c', '真缺必选参数时整条宏不展开');
assert.equal(Ax(B + 'newcommand{' + B + 'optOne}[1][dflt]{(#1)}', B + 'optOne'), '(dflt)', '单参可选宏省略参数展开为默认值');
assert.equal(Ax(B + 'newcommand{' + B + 'optOne}[1][dflt]{(#1)}', B + 'optOne[custom]'), '(custom)', '单参可选宏提供参数展开为自定义值');
{
  const dBox = [
    '\\documentclass{article}',
    '\\newcommand{\\notebox}[2][提示]{\\textbf{#1}: #2}',
    '\\begin{document}',
    '\\notebox{正文内容}',
    '\\notebox[警告]{严重错误}',
    '\\end{document}',
  ].join('\n');
  const rBox = renderLatex(dBox);
  assert.ok(rBox.html.includes('<strong>提示</strong>') && rBox.html.includes('正文内容'), '正文宏省略可选参数时使用默认值');
  assert.ok(rBox.html.includes('<strong>警告</strong>') && rBox.html.includes('严重错误'), '正文宏显式提供可选参数时覆盖默认值');
}
assert.equal(Ax(B + 'newcommand{' + B + 'x}{X}', B + 'x' + B + 'x' + B + 'x'), 'XXX', '相邻 token 全部展开');
assert.equal(Ax(B + 'newcommand{' + B + 'm}{$E$}', B + 'm'), '$E$', '宏体里的 $& 不该被当替换串解释');
assert.equal(Ax(B + 'newcommand{' + B + 'p}{#1miss}', B + 'p'), 'miss', 'argc=0 时宏体里的 #1 按旧口径替换为空');

// ---- 4. 宏体里再套宏：旧写法在同一遍按字典序吃掉，新写法在下一遍（深度上限 12）----
// 宏名只收字母：写成 \L1 会被 scanMacros 整条丢弃（名字读到 L 就停，随后要求紧跟 {），
// 于是「链没展开」其实是「字典是空的」——这个坑在性能基准上白测过一轮，夹具必须用纯字母名
{
  const letters = 'abcdefghijk';
  let defs = B + 'newcommand{' + B + 'c' + letters[0] + '}{1}';
  for (let i = 1; i < letters.length; i++) defs += N + B + 'newcommand{' + B + 'c' + letters[i] + '}{' + B + 'c' + letters[i - 1] + '}';
  assert.equal(Object.keys(scanMacros(defs)).length, letters.length, '宏链夹具必须真的注册出 11 个宏');
  const last = B + 'c' + letters[letters.length - 1];
  assert.equal(Ax(defs, last), '1', '11 层宏链要展开到底（每层一遍，深度预算 12）');
  assert.equal(Ax(B + 'newcommand{' + B + 'b}{B}' + N + B + 'newcommand{' + B + 'a}{' + B + 'b}', B + 'a'),
    'B', '先定义被引用的宏、再定义引用它的，顺序不影响结果');
  assert.equal(Ax(B + 'newcommand{' + B + 'a}{' + B + 'b-X}' + N + B + 'newcommand{' + B + 'b}{B}', B + 'a'),
    'B-X', '只在别的宏体里出现的宏名也要展开（预扫靠递归补上这一层）');
  assert.equal(Ax(B + 'newcommand{' + B + 'a}{' + B + 'bX}' + N + B + 'newcommand{' + B + 'b}{B}', B + 'a'),
    B + 'bX', '宏体里 \\bX 是一个整体 token，不该命中宏 b（旧实现同样不展开）');
  assert.equal(Ax(B + 'newcommand{' + B + 'b}{B}' + N + B + 'newcommand{' + B + 'c}{C}' + N + B + 'newcommand{' + B + 'a}{' + B + 'b' + B + 'c}', B + 'a'),
    'BC', '一个宏体里引出两个宏时都要跟上');
}

// ---- 5. 上限：自增长宏体与超 50 次出现 ----
{
  const grow = Ax(B + 'newcommand{' + B + 'z}{zz' + B + 'z' + B + 'z}', B + 'z');
  assert.ok(grow.length < 4 * 1024 * 1024 + 64, '展开后正文必须落在 MACRO_MAX_TEXT 内，实测 ' + grow.length);
  const many = Ax(B + 'newcommand{' + B + 'r}{x}', (B + 'r ').repeat(120));
  assert.equal(many.trim().split(/\s+/).length, 120, '同宏超 50 次要跨遍展开完（guard 50 × 深度 12）');
}

// ---- 6. 原型链键名不被当成已定义宏 ----
{
  assert.deepEqual(macroNamesIn(B + 'toString hasOwnProperty valueOf', {}), [], '空字典时零命中');
  const d = dict(B + 'newcommand{' + B + 'constructor}{C}');
  assert.deepEqual(macroNamesIn(B + 'constructor ' + B + 'toString', d), ['constructor'], '只认 own property');
  assert.equal(Ax(B + 'newcommand{' + B + 'constructor}{C}', B + 'toString'), B + 'toString',
    '未定义的 toString 保持原样，不从原型链取到 Function 后炸渲染');
}

// ---- 7. macroNamesIn 自身口径：首现顺序、去重、缺字典不抛 ----
{
  const d = dict(B + 'newcommand{' + B + 'a}{1}' + N + B + 'newcommand{' + B + 'b}{2}');
  assert.deepEqual(macroNamesIn(B + 'b ' + B + 'a ' + B + 'b ' + B + 'ab', d), ['b', 'a'], '去重并忽略未定义的 \\ab');
  assert.deepEqual(macroNamesIn('', d), []);
  assert.deepEqual(macroNamesIn('abc', d), [], '没有反斜杠就没有 token');
  assert.deepEqual(macroNamesIn(B + 'a', null), [], '缺字典时不抛');
  assert.deepEqual(macroNamesIn('x' + B + B + 'a', d), ['a'], '连续反斜杠 \\ 后接 \\a 时仍认出宏');
}

console.log('macroExpand: all tests passed');

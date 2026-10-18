/* 预览点击回跳源码行：data-off 偏移标注的正确性 */
import { renderLatex } from '../src/engines/latex.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.error('  ✗ FAIL:', msg); }
}

console.log('== 预览回跳 data-off ==');

// 段落：data-off 指向段落首个非空白字符的偏移（段首换行按排版规则折成空格，故允许前导空白）
const src = `\\documentclass{article}
\\begin{document}
First paragraph opens here.

Second \\textbf{bold} paragraph.
\\section{Intro}
Body after heading.
\\begin{equation}
  a = b
\\end{equation}
\\end{document}`;
const res = renderLatex(src);

const firstOff = src.indexOf('First');
const p1 = res.html.match(/<p data-off="(\d+)">\s*First/);
ok(!!p1 && +p1[1] === firstOff, '段落 data-off 精确指向段首字符: ' + (p1 && p1[1]) + ' vs ' + firstOff);

// 段落中间含命令时仍以文本起点为准
const secondOff = src.indexOf('Second');
const p2 = res.html.match(/<p data-off="(\d+)">\s*Second/);
ok(!!p2 && +p2[1] === secondOff, '含 \\textbf 的段落 data-off 指向段首');

// 章节：data-off 指向 \section 反斜杠
const secOff = src.indexOf('\\section');
const h = res.html.match(/<h2[^>]*data-off="(\d+)"/);
ok(!!h && +h[1] === secOff, '章节 data-off 指向 \\section 起点: ' + (h && h[1]) + ' vs ' + secOff);

// equation 环境：data-off 指向 \begin{equation}（data-off 注在标签名后、class 前）
const eqOff = src.indexOf('\\begin{equation}');
const eq = res.html.match(/<div data-off="(\d+)" class="equation"/);
ok(!!eq && +eq[1] === eqOff, 'equation data-off 指向环境起点: ' + (eq && eq[1]) + ' vs ' + eqOff);

// 段后文字：heading 之后的段落指向自己的段首而非章节行
const bodyOff = src.indexOf('Body after');
const p3 = res.html.match(/<p data-off="(\d+)">\s*Body after/);
ok(!!p3 && +p3[1] === bodyOff, '章节后的段落 data-off 指向自身段首');

// IEEE 跨栏：@@COLS@@ 前缀不挡注入，data-off 落在 <h2> 上
const ieee = renderLatex(`\\documentclass[journal]{IEEEtran}
\\begin{document}
\\title{T}
\\author{A}
\\maketitle
\\section{One}
Text here.
\\end{document}`);
const base = `\\documentclass[journal]{IEEEtran}
\\begin{document}
\\title{T}
\\author{A}
\\maketitle
`;
const ih = ieee.html.match(/<h2[^>]*data-off="(\d+)"/);
ok(!!ih && +ih[1] === base.length, 'IEEE 跨栏章节 data-off 正确: ' + (ih && ih[1]) + ' vs ' + base.length);
ok(!!ih && !/<div class="doc-cols" data-off=/.test(ieee.html), '双栏容器本身不抢 data-off');

// 表格单元格：每个单元格段落有独立偏移
const tab = renderLatex(`\\documentclass{article}
\\begin{document}
\\begin{tabular}{cc}
A & B \\\\
C & D
\\end{tabular}
\\end{document}`);
const cellOff = tab.html.match(/<td[^>]*><p data-off="(\d+)">A<\/p>/);
ok(!!cellOff && +cellOff[1] === tabSrcCell('A'), '表格单元格 data-off 指向单元格内容: ' + (cellOff && cellOff[1]));
function tabSrcCell(ch) {
  const t = `\\documentclass{article}
\\begin{document}
\\begin{tabular}{cc}
A & B \\\\
C & D
\\end{tabular}
\\end{document}`;
  return t.indexOf(ch, t.indexOf('\\begin{tabular}'));
}

// 没有 \begin{document} 的裸文档同样标注
const bare = renderLatex('alpha beta\n\ngamma delta');
const bareOff = 'alpha beta\n\ngamma delta'.indexOf('gamma');
const bp = bare.html.match(/<p data-off="(\d+)">gamma/);
ok(!!bp && +bp[1] === bareOff, '裸文档段落 data-off 正确');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

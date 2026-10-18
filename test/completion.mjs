/* LaTeX 补全测试：上下文匹配器、命令/环境/文件候选、\newcommand 收集、环境闭合判断 */
import {
  collectUserCommands, commandCandidates, fileCandidates,
  matchCommandToken, matchEnvToken, matchFileToken, envNeedsEnd, ENVIRONMENTS, COMMANDS,
} from '../src/completion.js';
import { DICT } from '../src/i18n.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.error('  ✗ FAIL:', msg); }
}

console.log('== matchEnvToken ==');
let m = matchEnvToken('\\begin{fig');
ok(m && m.partial === 'fig', '\\begin{fig → partial=fig');
m = matchEnvToken('\\begin{');
ok(m && m.partial === '', '\\begin{ 刚敲花括号');
m = matchEnvToken('\\begin {equ');
ok(m && m.partial === 'equ', '命令与花括号间允许空格');
ok(matchEnvToken('\\section{Intro') === null, '\\section 不触发环境补全');
ok(matchEnvToken('\\begin{figure}[h]') === null, '环境已闭合不再触发');

console.log('== matchCommandToken ==');
m = matchCommandToken('see \\text');
ok(m && m.token === 'text' && m.start === 4, '\\text → token/start');
m = matchCommandToken('a \\');
ok(m && m.token === '', '孤立反斜杠 → 空 token（全量候选）');
ok(matchCommandToken('line break \\\\') === null, '\\\\ 换行不触发');
ok(matchCommandToken('\\\\section') === null, '\\\\section（换行+单词）不触发');
m = matchCommandToken('\\section*');
ok(m && m.token === 'section*', '带星号命令');

console.log('== matchFileToken ==');
m = matchFileToken('\\input{cha');
ok(m && m.cmd === 'input' && m.kind === 'tex' && m.partial === 'cha', '\\input{cha');
m = matchFileToken('\\includegraphics[width=0.8\\textwidth]{fig');
ok(m && m.kind === 'image' && m.partial === 'fig', '可选参数后的花括号');
m = matchFileToken('\\bibliography{refs');
ok(m && m.kind === 'bib', '\\bibliography');
m = matchFileToken('\\include{chapters/ma');
ok(m && m.partial === 'chapters/ma', '路径片段原样返回');
ok(matchFileToken('\\cite{sm') === null, '\\cite 不走文件补全（有专属键位补全）');

console.log('== commandCandidates ==');
let c = commandCandidates('textb', []);
ok(c.length === 1 && c[0].name === 'textbf' && c[0].suffix === '{}', '前缀过滤');
c = commandCandidates('', []);
ok(c.length === 40, '空 token 封顶 40 条：' + c.length);
c = commandCandidates('mode', ['modell', 'modeX']);
ok(c.some(x => x.name === 'modell') && c.some(x => x.name === 'modeX'), '\\newcommand 命令并入候选');
ok(COMMANDS.some(x => x[0] === 'begin') && COMMANDS.some(x => x[0] === 'end'), 'begin/end 在内置表（打 \\begin 可直选）');
c = commandCandidates('textbf', []);
ok(c[0].name === 'textbf', '精确命中排最前');

console.log('== collectUserCommands ==');
const cmds = collectUserCommands([
  '\\newcommand{\\model}{BiLSTM}\n\\renewcommand\\vec{\\mathbf}',
  '\\DeclareMathOperator{\\rank}{rank}',
  '% \\newcommand{\\commentedOut}{x}',
]);
ok(cmds.includes('model') && cmds.includes('vec') && cmds.includes('rank'), '三种定义形式都收集');
ok(!cmds.includes('commentedOut'), '注释里的定义不收集（match 源文本含注释行时按纯文本收集，此处断言非注释路径）');

console.log('== fileCandidates ==');
const pool = { tex: ['main.tex', 'chapters/intro.tex'], image: ['figures/fig1.png', 'logo.svg'], bib: ['refs.bib'] };
let paths = fileCandidates('tex', 'ch', pool);
ok(JSON.stringify(paths) === JSON.stringify(['chapters/intro.tex']), 'tex 池 + 子串过滤');
paths = fileCandidates('image', '', pool);
ok(paths.length === 2, 'image 池');
paths = fileCandidates('file', '', pool);
ok(paths.length === 5, 'file = 三池并集（2+2+1）');
ok(fileCandidates('bib', 'zzz', pool).length === 0, '无命中返回空');

console.log('== envNeedsEnd ==');
ok(envNeedsEnd('figure', ''), '后面没有 \\end → 需要闭合');
ok(!envNeedsEnd('figure', '\n\\includegraphics{x}\n\\end{figure}\n'), '已有同名 \\end → 不重复');
ok(!envNeedsEnd('align*', 'x\\end{align*}'), '星号环境名转义正确');
ok(ENVIRONMENTS.includes('tikzpicture') && ENVIRONMENTS.includes('mermaid'), '项目特色环境在列');

console.log('== 新增设置文案双语完整 ==');
for (const key of ['file.mainDoc', 'file.mainDocAuto', 'file.mainDocHint', 'file.autoCompile', 'file.acOff', 'file.acSave', 'file.acIdle', 'file.vimMode', 'st.mainDocTip', 't.image']) {
  ok(typeof DICT.en[key] === 'string' && DICT.en[key].length > 0, '英文文案存在: ' + key);
  ok(!/[\u4e00-\u9fff]/.test(DICT.en[key]), '英文无汉字: ' + key);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

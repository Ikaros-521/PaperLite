/* LanguageTool 语法检查纯逻辑测试：分块、偏移→行列映射、响应解析、遮罩联动 */
import { splitChunks, buildRequestBody, posOf, parseMatches } from '../src/grammar.js';
import { maskNonProse } from '../src/spellcheck.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.error('  ✗ FAIL:', msg); }
}

console.log('== splitChunks ==');
let chunks = splitChunks('a'.repeat(20000), 8000, 0);
ok(chunks.length === 3 && chunks[0].text.length === 8000 && chunks[1].offset === 8000, '无空行硬切：等长分块');
ok(chunks[2].offset + chunks[2].text.length === 20000, '块拼起来等于原文');
chunks = splitChunks('x'.repeat(100) + '\n\n' + 'y'.repeat(100) + '\n\n' + 'z'.repeat(50), 120, 0);
ok(chunks.length === 2 && chunks[0].text.endsWith('x\n\n') || chunks.length >= 2, '空行优先切分');
ok(splitChunks('', 8000, 0).length === 0, '空文本无块');
ok(splitChunks('short', 8000, 3).length === 1, '短文本单块');
chunks = splitChunks('p'.repeat(40000), 8000, 3);
ok(chunks.length === 3, 'maxChunks 封顶：' + chunks.length);

console.log('== buildRequestBody ==');
const body = buildRequestBody('hello 他好');
ok(decodeURIComponent(body.replace(/\+/g, ' ')).includes('hello 他好'), '文本进表单且可还原');
ok(body.includes('language=auto'), 'language=auto');

console.log('== posOf ==');
const masked = maskNonProse('第一行文本\n\\textbf{粗体} 后文\n第三行 $x^2$ 尾');
ok(posOf(masked, 0).line === 0 && posOf(masked, 0).ch === 0, '偏移 0');
const nl = masked.indexOf('\n');
const p2 = posOf(masked, nl + 3);
ok(p2.line === 1 && p2.ch === 2, '第二行第 2 列：' + JSON.stringify(p2));

console.log('== parseMatches：偏移映射回源码行列 ==');
// 构造一段带命令的文本：LT 只应看到遮罩后的正文，偏移据此映射
const src = '本句有一个错误地用法。\n\\label{sec:x}\n这里 he have a problem too.';
const m2 = maskNonProse(src);
// 手工挑两个正文片段的位置：第 0 行「错误地」与第 2 行「have」
const bad1 = m2.indexOf('错误地');
const bad2 = m2.indexOf('have');
const fakeLT = { matches: [
  { offset: bad1, length: 3, message: 'Grammar issue in Chinese.', shortMessage: '语法', rule: { description: '用法' }, replacements: [{ value: '错误的' }] },
  { offset: bad2, length: 4, message: 'Agreement error.', replacements: [{ value: 'has' }, { value: 'had' }] },
  { offset: m2.indexOf('\\label'), length: 6, message: '落在遮罩区', replacements: [] },  // 命中遮罩：应被丢弃
] };
const marks = parseMatches(fakeLT, m2, 0);
ok(marks.length === 2, '遮罩区命中被丢弃：' + marks.length);
ok(marks[0].line === 0 && m2.split('\n')[0].slice(marks[0].from, marks[0].to) === '错误地', '第 0 行映射回「错误地」');
ok(marks[0].replacements[0] === '错误的', '替换建议保留');
ok(marks[1].line === 2 && m2.split('\n')[2].slice(marks[1].from, marks[1].to) === 'have', '第 2 行映射回「have」');
ok(marks[1].msg.includes('Agreement error.'), '消息透传');

console.log('== 跨行命中 ==');
const src2 = 'this is a very long line one\nand line two continues';
const m3 = maskNonProse(src2);
const start = m3.indexOf('very');
const fakeLT2 = { matches: [{ offset: start, length: ('very long line one\nand').length, message: 'spans', replacements: [] }] };
const spans = parseMatches(fakeLT2, m3, 0);
ok(spans.length === 1 && spans[0].line === 0 && spans[0].endLine === 1, '跨行标记给出 endLine');

console.log('== 遮罩与拼写共用一套规则 ==');
const m4 = maskNonProse('% comment here\n$body text$ \\cite{key2020x}');
ok(m4.split('\n')[0].trim() === '', '注释被遮蔽');
ok(!m4.includes('body'), '数学环境被遮蔽');
ok(!m4.includes('key2020x'), '引用键被遮蔽');

console.log('== 新增文案双语完整 ==');
import { DICT } from '../src/i18n.js';
for (const key of ['m.citeSearch', 't.citeSearch', 'cite.title', 'cite.provider', 'cite.search', 'cite.searching', 'cite.placeholder', 'cite.empty', 'cite.error', 'cite.netNote', 'cite.insert', 'cite.inserted', 'cite.onlyTex', 'cite.noBibTarget', 'cite.etAl', 'cite.p_crossref', 'cite.p_openalex', 'cite.p_dblp', 'gm.suggest', 'file.grammar', 'file.grammarHint']) {
  ok(typeof DICT.en[key] === 'string' && DICT.en[key].length > 0, '英文文案存在: ' + key);
  ok(!/[\u4e00-\u9fff]/.test(DICT.en[key]), '英文无汉字: ' + key);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

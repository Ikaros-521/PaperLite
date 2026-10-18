/* 英文拼写检查：遮罩口径（注释/数学/逐字环境/引用键不参与）+ 屈折还原 + 定位 */
import { maskNonProse, buildChecker, findTypos } from '../src/spellcheck.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.error('  ✗ FAIL:', msg); }
}

const dictText = readFileSync(new URL('../public/dict/en.txt', import.meta.url), 'utf8');
const isWord = buildChecker(dictText);

console.log('== 拼写检查：遮罩 ==');

// 遮罩等长
const sample = 'Hello $x+y$ world\\nsecond line';
ok(maskNonProse(sample).length === sample.length, '遮罩等长');

// 行内注释不参与
ok(maskNonProse('good % teh coment').trim() === 'good', '注释被遮掉');
ok(maskNonProse('100\\% sure').includes('sure') && !maskNonProse('100\\% sure').includes('%'), '转义 \\% 不当注释');

// 数学内容不参与（含跨行 $$ 与 \\[ \\]）
ok(maskNonProse('$teh$ ok') === '      ok', '行内数学遮掉');
ok(maskNonProse('$$\\nteh\\n$$ after').includes('after') && !maskNonProse('$$\\nteh\\n$$ after').includes('teh'), '跨行 display 数学遮掉');
ok(maskNonProse('\\\\[\\nteh\\n\\\\] tail').includes('tail') && !maskNonProse('\\\\[\\nteh\\n\\\\] tail').includes('teh'), '\\\\[..\\\\] 遮掉');

// 命令名与引用键不参与，文本参数仍参与
ok(maskNonProse('\\textbf{teh}').includes('teh'), '\\textbf 文字参数参与拼写');
ok(!maskNonProse('\\cite{tehkey}').includes('tehkey'), '\\cite 键遮掉');
ok(!maskNonProse('\\label{sec:badname}').includes('badname'), '\\label 键遮掉');
ok(!maskNonProse('\\verb|teh code|').includes('teh'), '\\verb 内容遮掉');

// verbatim / lstlisting 环境整段不参与
const verb = 'aa \\begin{verbatim}\nteh bad word\n\\end{verbatim} bb';
const mv = maskNonProse(verb);
ok(mv.includes('bb') && !mv.includes('bad'), 'verbatim 环境内容遮掉');

// 换行保留（行列定位不变）
ok(maskNonProse('a\nb').split('\n').length === 2, '遮罩保留换行');

console.log('== 拼写检查：判词 ==');
ok(isWord('hello') && isWord('Hello') && isWord('HELLO'), '大小写不敏感');
ok(isWord("isn't") && isWord("didn't") && isWord("we're") && isWord("they've"), '缩写分写判词');
ok(isWord('runs') && isWord('running') && isWord('ran'), '动词屈折还原');
ok(isWord('churches') && isWord('batteries'), '复数还原（-es / -ies）');
ok(isWord('walked') && isWord('stopped'), '过去式还原（含双写辅音）');
ok(isWord("dog's"), '所有格还原');
ok(!isWord('teh') && !isWord('recieve') && !isWord('adress'), '常见错词判负');
ok(isWord('LSTM') || isWord('IEEE'), '全大写缩写直接放行');

console.log('== 拼写检查：定位 ==');
const doc = 'The teh quick\nbrown $teh$ fox\njumps \\cite{teh} over';
const typos = findTypos(doc, isWord);
ok(typos.length === 1 && typos[0].word === 'teh' && typos[0].line === 0 && typos[0].from === 4 && typos[0].to === 7,
  '只报正文错词，数学与引用键不报: ' + JSON.stringify(typos));
const doc2 = 'good line\nseond line';
const t2 = findTypos(doc2, isWord);
ok(t2.length === 1 && t2[0].line === 1 && t2[0].from === 0, '行号定位正确');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

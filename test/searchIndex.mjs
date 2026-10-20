/* 项目搜索纯逻辑测试：清单装配去重、模式复用 findModel、限量与截断 */
import { collectSearchFiles, searchInFiles } from '../src/searchIndex.js';
import { DICT } from '../src/i18n.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.error('  ✗ FAIL:', msg); }
}

console.log('== collectSearchFiles ==');
let files = collectSearchFiles(
  [{ path: 'main.tex', text: 'live' }, { path: 'a.md', text: '' }],
  [{ path: 'main.tex', text: 'disk-old' }, { path: 'refs.bib', text: '@x' }],
);
ok(files.length === 3, '按 path 去重：' + files.length);
ok(files[0].text === 'live' && files[0].open === true, '打开标签优先，用实时内容');
ok(files.find(f => f.path === 'refs.bib').open === false, '磁盘文件补齐');
ok(collectSearchFiles(null, null).length === 0, '空输入');

console.log('== searchInFiles：基本匹配 ==');
files = [
  { path: 'a.tex', text: 'hello world\nsecond hello line\nno match here' },
  { path: 'b.md', text: 'hello again' },
];
let r = searchInFiles(files, { query: 'hello' });
ok(r.ok && r.matches.length === 3 && r.fileCount === 2, '不区分大小写跨文件：' + r.matches.length);
ok(r.matches[0].line === 0 && r.matches[0].from === 0 && r.matches[0].to === 5, '行列与区间');
ok(r.matches[1].line === 1, '第二行命中');

console.log('== 大小写 / 整词 / 正则 ==');
r = searchInFiles(files, { query: 'HELLO', matchCase: true });
ok(r.matches.length === 0, '区分大小写');
r = searchInFiles(files, { query: 'hello', matchCase: false });
ok(r.matches.length === 3, '忽略大小写');
r = searchInFiles(files, { query: 'hello', wholeWord: true });
ok(r.matches.length === 3, '整词仍命中独立词');
r = searchInFiles([{ path: 'x', text: 'helloing' }], { query: 'hello', wholeWord: true });
ok(r.matches.length === 0, '整词排除子串');
r = searchInFiles(files, { query: 'hel+o', regex: true });
ok(r.matches.length === 3, '正则模式');
r = searchInFiles(files, { query: '(unclosed', regex: true });
ok(r.ok === false && r.error === 'invalid', '非法正则返回 invalid');
r = searchInFiles(files, { query: '' });
ok(r.ok && r.matches.length === 0, '空查询不报错');

console.log('== 限量与截断 ==');
const many = [{ path: 'big.tex', text: Array.from({ length: 200 }, () => 'hit hit').join('\n') }];
r = searchInFiles(many, { query: 'hit', maxPerFile: 10 });
ok(r.matches.length === 10, 'maxPerFile 生效：' + r.matches.length);
r = searchInFiles(many, { query: 'hit', maxPerFile: 500, maxTotal: 50 });
ok(r.matches.length === 50 && r.truncated === true, 'maxTotal 截断并标记');
const multi = [
  { path: 'a.tex', text: 'hit\nhit\nhit' },
  { path: 'b.tex', text: 'hit' },
];
r = searchInFiles(multi, { query: 'hit', maxTotal: 4 });
ok(r.matches.length === 4 && r.fileCount >= 1, '跨文件总量封顶');
ok(r.matches.every(m => typeof m.text === 'string'), '行文本总是字符串');
const longLine = [{ path: 'l.tex', text: 'x'.repeat(400) + ' needle ' + 'y'.repeat(400) }];
r = searchInFiles(longLine, { query: 'needle' });
ok(r.matches[0].text.length <= 300, '超长行截断到 300 字符：' + r.matches[0].text.length);

console.log('== 中文与 CJK 整词 ==');
const cjk = [{ path: 'c.tex', text: '注意力 是关键\n深度学习与注意力\n注意力度' }];
r = searchInFiles(cjk, { query: '注意力' });
ok(r.matches.length === 3, 'CJK 默认子串命中：' + r.matches.length);
r = searchInFiles(cjk, { query: '注意力', wholeWord: true });
ok(r.matches.length === 1, '整词边界按 \\p{L} 判定：只有空格分隔的首行命中（「与注意力」「注意力度」排除）：' + r.matches.length);

console.log('== 墙钟预算（模型写的病态正则会逐行同步 exec，冻住标签页）==');
{
  // 100 行，needle 在第 5 行与第 90 行：假时钟每次调用推进 400ms，
  // deadline = 第一次调用(400) + 1000 = 1400 → li=0(800) 放行、li=32(1200) 放行、li=64(1600) 收口
  const many = [{ path: 'big.tex', text: Array.from({ length: 100 }, (_, i) => (i === 5 || i === 90 ? 'zzz' : 'x')).join('\n') }];
  const realNow = Date.now;
  let clock = 0;
  Date.now = () => (clock += 400);
  try {
    const timed = searchInFiles(many, { query: 'zzz', timeBudgetMs: 1000 });
    ok(timed.truncated === true, '超预算要标 truncated，让调用方说明结果不全');
    ok(timed.matches.length === 1 && timed.matches[0].line === 5,
      '预算内的那部分照常交出，第 90 行的命中被丢掉：' + JSON.stringify(timed.matches.map(m => m.line)));
  } finally { Date.now = realNow; }
  // 默认不限：调用方不传预算时行为完全不变（编辑器的用户搜索与单测保持确定性）
  const plain = searchInFiles(many, { query: 'zzz' });
  ok(plain.matches.length === 2 && plain.truncated === false, '默认无预算：两条命中都交出');
}

console.log('== 新增文案双语完整 ==');
for (const key of ['side.search', 'm.gSearch', 'gs.title', 'gs.placeholder', 'gs.go', 'gs.scope', 'gs.noFolder', 'gs.none', 'gs.count', 'gs.truncated']) {
  ok(typeof DICT.en[key] === 'string' && DICT.en[key].length > 0, '英文文案存在: ' + key);
  ok(!/[\u4e00-\u9fff]/.test(DICT.en[key]), '英文无汉字: ' + key);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

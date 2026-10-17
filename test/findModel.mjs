import assert from 'node:assert/strict';
import {
  buildPattern, collectMatches, lineStarts, posFromOffset, offsetFromPos, toPositions,
  pickIndex, stepIndex, replacementText, MAX_MATCHES
} from '../src/findModel.js';

const find = (query, text, opts) => {
  const { pattern, error } = buildPattern(query, opts);
  assert.equal(error, undefined, '查询应能编译: ' + query);
  const starts = lineStarts(text);
  return toPositions(starts, collectMatches(text, pattern).matches);
};

// ---- 字面量：默认忽略大小写，点号不是通配符 ----
let text = 'Foo foo FOO f.ofoo';
assert.deepEqual(find('foo', text).map(m => m.start), [0, 4, 8, 15]);
assert.deepEqual(find('foo', text, { matchCase: true }).map(m => m.start), [4, 15]);
assert.deepEqual(find('f.o', text).map(m => m.text), ['f.o']);

// ---- 全字匹配：\b 只认 ASCII，中文词要能整体命中 ----
assert.deepEqual(find('foo', 'foo foo-bar xfoo').map(m => m.text), ['foo', 'foo', 'foo']);
assert.deepEqual(find('foo', 'foo foo-bar xfoo', { wholeWord: true }).map(m => m.text), ['foo', 'foo']);
assert.deepEqual(find('模型', '模型 大模型 模型。', { wholeWord: true }).map(m => m.text), ['模型', '模型']);
assert.deepEqual(find('模型', '模型 大模型 模型。').map(m => m.text), ['模型', '模型', '模型']);

// ---- 正则：原生语法 + /re/flags 写法 ----
assert.deepEqual(find('\\b\\w{3}\\b', 'foo bar foobar', { regex: true }).map(m => m.text), ['foo', 'bar']);
assert.deepEqual(find('/foo/i', 'Foo foo', { regex: true }).map(m => m.text), ['Foo', 'foo']);
assert.deepEqual(find('/Foo/', 'Foo foo', { regex: true, matchCase: true }).map(m => m.text), ['Foo']);
assert.deepEqual(find('/a+/', 'AaA ab', { regex: true, matchCase: true }).map(m => m.text), ['a', 'a']);
assert.deepEqual(find('(\\d+)-(\\d+)', 'x 12-34 y', { regex: true })[0].groups, ['12', '34']);
assert.deepEqual(find('\\w', 'ab c', { regex: true, wholeWord: true }).map(m => m.text), ['c'], '正则与全词可叠加');
assert.deepEqual(find('a|b', 'x a y b z', { regex: true, wholeWord: true }).map(m => m.text), ['a', 'b'], '分支要先包起来');
// 零宽匹配会被跳过，避免原地打转
assert.deepEqual(find('^', 'a\nb', { regex: true }), []);
assert.ok(buildPattern('(', { regex: true }).error, '非法正则要报错而不是抛异常');

// ---- 行列映射：跨行文档的每个匹配都能换算回 CodeMirror 位置 ----
text = 'alpha\nbeta gamma\nbeta';
assert.deepEqual(find('beta', text).map(m => [m.from.line, m.from.ch, m.to.line, m.to.ch]), [[1, 0, 1, 4], [2, 0, 2, 4]]);
const starts = lineStarts(text);
assert.deepEqual(starts, [0, 6, 17]);
assert.deepEqual(posFromOffset(starts, 18), { line: 2, ch: 1 });
assert.equal(offsetFromPos(starts, { line: 2, ch: 1 }), 18);
assert.equal(offsetFromPos(starts, { line: 9, ch: 3 }), starts[starts.length - 1] + 3, '越界行号按末行夹住');

// ---- 跳转：循环、回绕、从锚点之后起找 ----
const list = [{ start: 5 }, { start: 10 }, { start: 20 }];
assert.equal(pickIndex(list, 6), 1);
assert.equal(pickIndex(list, 5), 0);
assert.equal(pickIndex(list, 21), 0, '锚点在最后之后就回绕');
assert.equal(pickIndex([], 0), -1);
assert.equal(stepIndex(0, 1, 3), 1);
assert.equal(stepIndex(0, -1, 3), 2, '上一个往前回绕');
assert.equal(stepIndex(-1, 1, 3), 0);
assert.equal(stepIndex(0, 1, 0), -1);

// ---- 替换串：分组引用、原文引用、未定义分组 ----
const m = { text: '12-34', start: 2, end: 7, groups: ['12', '34'], named: { a: '12' } };
const sub = (repl, opts) => replacementText(repl, m, { before: 'xx', after: 'yy', ...opts });
assert.equal(sub('$2-$1'), '34-12');
assert.equal(sub('${a}/${a}'), '12/12');
assert.equal(sub('$<a>'), '12');
assert.equal(sub('$&+'), '12-34+');
assert.equal(sub('$`|$\''), 'xx|yy');
assert.equal(sub('$$'), '$');
assert.equal(sub('$0'), '$0', '$0 不是分组，原样保留');
assert.equal(sub('$9'), '', '越界分组替换成空');
assert.equal(sub('<$1>'), '<12>');
assert.equal(sub(''), '');

// ---- 保留大小写：只改写替换串里的字面量，分组内容原样带出 ----
const word = t => ({ text: t, start: 0, end: t.length, groups: ['12', '34'], named: { a: '12' } });
assert.equal(replacementText('foo bar', word('FOO'), { preserveCase: true }), 'FOO BAR');
assert.equal(replacementText('foo$1', word('FOO'), { preserveCase: true }), 'FOO12');
assert.equal(replacementText('foo bar', word('Foo'), { preserveCase: true }), 'Foo bar');
assert.equal(replacementText('foo bar', word('foo'), { preserveCase: true }), 'foo bar');
assert.equal(replacementText('foo bar', word('12-34'), { preserveCase: true }), 'foo bar', '无字母的命中不改 case');
assert.equal(replacementText('foo bar', word('FOO')), 'foo bar', '不开开关就不动');

// ---- 上限：超出 MAX_MATCHES 时截断并标记 ----
const many = collectMatches('a'.repeat(MAX_MATCHES + 50), buildPattern('a').pattern);
assert.equal(many.matches.length, MAX_MATCHES);
assert.equal(many.truncated, true);
assert.equal(collectMatches('abc', buildPattern('').pattern).matches.length, 0, '空查询不搜');
assert.equal(buildPattern('').pattern, null);

console.log('Find model: literal, case, whole word (CJK), regex, line mapping, navigation, replacements, preserve case passed.');

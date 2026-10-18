/* pdfSync.mjs — PDF⇄源码 近似定位的纯逻辑（synctex-lite）
 * 用合成的 pdf.js 文本条目模拟断行/连字符/CJK，验证归一化与双向匹配。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchKey, stripTexCommands, paragraphHeadAtLine,
  buildPageIndex, findInPageIndex, findTextInDoc, locateLineInSource,
} from '../src/pdfSync.js';

test('matchKey：连字/弯引号/破折号归一，空白与连字符全去掉', () => {
  assert.equal(matchKey('ﬁle “quoted” — dash'), 'filequoteddash');
  assert.equal(matchKey('impor- tant'), 'important');
  assert.equal(matchKey('注意力 Mechanism 机制'), '注意力mechanism机制');
  assert.equal(matchKey('A_B $x^2$ & C'), 'abx2c');
});

test('stripTexCommands：去注释/命令/定界符，正文留下', () => {
  const out = stripTexCommands('\\textbf{bold} text % note\n\\section{Intro}');
  assert.match(out, /bold/);
  assert.match(out, /text/);
  assert.match(out, /Intro/);
  assert.ok(!out.includes('textbf'));
  assert.ok(!out.includes('note'));
});

test('paragraphHeadAtLine：空行边界内的段落与起始行', () => {
  const src = 'a\nb\n\nc\n\nd';
  assert.deepEqual(paragraphHeadAtLine(src, 0), { text: 'a b', startLine: 0, endLine: 1 });
  assert.deepEqual(paragraphHeadAtLine(src, 1), { text: 'a b', startLine: 0, endLine: 1 });
  assert.deepEqual(paragraphHeadAtLine(src, 3), { text: 'c', startLine: 3, endLine: 3 });
});

test('buildPageIndex + findInPageIndex：断行与连字符断词后仍能命中并给坐标', () => {
  const items = [
    { str: 'The attention mecha-', x: 50, y: 700, w: 220, h: 10 },
    { str: 'nism improves quality.', x: 50, y: 688, w: 160, h: 10 },
    { str: '第二章 结论', x: 50, y: 660, w: 120, h: 10 },
  ];
  const idx = buildPageIndex(items, 1);
  const hit = findInPageIndex(idx, 'The attention mechanism improves');
  assert.ok(hit, '跨行+连字符应命中');
  assert.equal(hit.page, 1);
  assert.equal(hit.itemIndex, 0);
  assert.equal(hit.x, 50 + 220 / 2);
  // 源码侧带 TeX 命令的查询同样命中
  const hit2 = findInPageIndex(idx, stripTexCommands('\\emph{The attention mechanism} improves quality.'));
  assert.ok(hit2, '命令剥离后命中');
  // CJK 段落（查询端标点/空白差异不影响键匹配）
  const hit3 = findInPageIndex(idx, '第 二 章……结论!');
  assert.ok(hit3 && hit3.itemIndex === 2, 'CJK 键匹配应命中第三个条目');
});

test('findInPageIndex：找不到时安静返回 null', () => {
  const idx = buildPageIndex([{ str: 'nothing here', x: 0, y: 0, w: 10, h: 10 }], 2);
  assert.equal(findInPageIndex(idx, 'completely absent query text'), null);
});

test('findTextInDoc：优先靠近当前页，找不到再扫全部', () => {
  const mk = (p, s) => buildPageIndex([{ str: s, x: 1, y: 1, w: 9, h: 9 }], p);
  const docs = [mk(1, 'alpha para'), mk(4, 'target paragraph here'), mk(7, 'target paragraph here too')];
  const near = findTextInDoc(docs, 'target paragraph here', 4);
  assert.equal(near.page, 4);
  const none = findTextInDoc(docs, 'missing entirely', 4);
  assert.equal(none, null);
});

test('locateLineInSource：PDF 行文本（含折行拼接）定位到源码行', () => {
  const src = [
    '\\section{Introduction}',
    'Deep learning models have achieved remarkable success.',
    '',
    'The transformer architecture replaced recurrence.',
  ].join('\n');
  assert.equal(locateLineInSource(src, 'remarkable success.'), 1);
  // 双击 span 常只拿到半句；从行首起匹配更稳
  assert.equal(locateLineInSource(src, 'Deep learning models have'), 1);
  assert.equal(locateLineInSource(src, 'replaced recurrence.'), 3);
  assert.equal(locateLineInSource(src, 'zzz no such text'), null);
});

test('locateLineInSource：跨源码两行的 PDF 文本（折行）也能归属', () => {
  const src = 'first half of the\nsecond half sentence\n\nother';
  assert.equal(locateLineInSource(src, 'of the second half'), 0);
});

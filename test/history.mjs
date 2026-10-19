import assert from 'node:assert/strict';
import { compareVersions, inlineChanges } from '../src/historyDiff.js';
import { readHistory, recordVersion, renameVersion, copyHistory, deleteHistory, clearHistory, historyUsage, unusedHistory, pruneHistory } from '../src/fileActions.js';
import { HISTORY_LIMITS } from '../src/historyStorage.js';

// Reconstruct both original byte strings, including CRLF and missing final newlines.
const cases = [['', ''], ['', 'hello\n'], ['hello', ''], ['a\nb\nc\n', 'a\nB\nc\n'],
  ['重复\n重复\n尾行', '重复\n新行\n重复\n尾行\n'], ['x\r\ny\r\n', 'x\r\nz\r\n'],
  ['a\nb\nc\nd\ne', 'a\nx\nc\ny\ne'], ['a\n', 'a'], ['\n', ''], ['a\n\n', '\na\n']];
for (const [before, after] of cases) {
  const diff = compareVersions(before, after);
  assert.equal(diff.rows.map(r => r.left ?? '').join(''), before);
  assert.equal(diff.rows.map(r => r.right ?? '').join(''), after);
  assert.equal(diff.added, diff.rows.filter(r => r.changed && r.right !== undefined).length);
  assert.equal(diff.removed, diff.rows.filter(r => r.changed && r.left !== undefined).length);
  assert.equal(diff.rows.filter(r => r.oldLine).at(-1)?.oldLine || 0, before.match(/[^\n]*\n|[^\n]+$/g)?.length || 0);
}
assert.equal(compareVersions('a\nb\nc\nd\ne', 'a\nx\nc\ny\ne').changes.length, 2);
const parts = inlineChanges('hello old world', 'hello new world');
assert.equal(parts.filter(p => !p.added).map(p => p.value).join(''), 'hello old world');
assert.equal(parts.filter(p => !p.removed).map(p => p.value).join(''), 'hello new world');
const huge = compareVersions('old\n'.repeat(4000), 'new\n'.repeat(4000));
assert.equal(huge.added, 4000); assert.equal(huge.removed, 4000);
assert.equal(compareVersions('x'.repeat(500001), '').tooLarge, true);
assert.equal(compareVersions('\n'.repeat(10001), '').tooLarge, true);

const data = new Map();
globalThis.localStorage = { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) };
const key = 'doc';
recordVersion(key, 'v1');
const manual = recordVersion(key, 'v1', { label: 'First draft', reason: 'manual' });
assert.equal(readHistory(key).length, 2);
assert.equal(manual.version.label, 'First draft');
recordVersion(key, 'v1'); assert.equal(readHistory(key).length, 2);
assert.equal(renameVersion(key, manual.version.id, '  Reviewed  '), true);
assert.equal(readHistory(key)[0].label, 'Reviewed');
recordVersion(key, 'v2');
const backup = recordVersion(key, 'v2', { reason: 'beforeRestore', force: true });
recordVersion(key, 'v1', { reason: 'restore', force: true, protectIds: [backup.version.id] });
assert.equal(readHistory(key)[0].text, 'v1');
assert.equal(readHistory(key)[1].text, 'v2');
assert.equal(readHistory(key)[1].reason, 'beforeRestore');
assert.equal(copyHistory(key, 'saved-as.tex'), true);
assert.deepEqual(readHistory('saved-as.tex'), readHistory(key));
copyHistory(key, 'saved-as.tex');
assert.equal(readHistory('saved-as.tex').length, readHistory(key).length);
assert.equal(deleteHistory(key, backup.version.id), true);
assert.equal(readHistory(key).some(v => v.id === backup.version.id), false);
assert.equal(readHistory('saved-as.tex').some(v => v.id === backup.version.id), true);
assert.equal(clearHistory(key), true);
assert.equal(readHistory(key).length, 0);
assert.ok(readHistory('saved-as.tex').length);
assert.equal(clearHistory(), true);
assert.equal(historyUsage(key).versions, 0);
data.set('paperlite.doc.v2', 'current document');
recordVersion('delete-test', 'old');
const deleteId = readHistory('delete-test')[0].id;
assert.equal(deleteHistory('delete-test', 'missing'), false);
clearHistory();
assert.equal(data.get('paperlite.doc.v2'), 'current document');

// A real browser quota failure gets a single bounded retry; current content and
// the protected rollback backup survive when old snapshots must be reclaimed.
recordVersion('quota', 'old');
const quotaBackup = recordVersion('quota', 'working', { force: true, reason: 'beforeRestore' });
let attempts = 0;
localStorage.setItem = (k, v) => {
  attempts++;
  if (attempts === 1) throw new Error('Quota exceeded');
  data.set(k, v);
};
assert.equal(recordVersion('quota', 'restored', { force: true, protectIds: [quotaBackup.version.id] }).ok, true);
assert.equal(attempts, 2);
assert.deepEqual(readHistory('quota').map(v => v.text), ['restored', 'working']);
localStorage.setItem = (k, v) => data.set(k, v);
clearHistory();

// 配额失败的重试只该丢「最旧的那几条」，不许把别的文件的历史一起塌缩掉：
// 给 A 文件改个版本标签（只保护 1 个 id）时 B 文件的版本必须原样留着
recordVersion('qa', 'a1');
recordVersion('qa', 'a2', { force: true });
recordVersion('qb', 'b1', { force: true });
const qaIds = readHistory('qa').map(v => v.id);
let retryAttempts = 0;
localStorage.setItem = (k, v) => {
  retryAttempts++;
  if (retryAttempts === 1) throw new Error('Quota exceeded');
  data.set(k, v);
};
assert.equal(renameVersion('qa', qaIds[0], '改名'), true, '重试后写入成功');
assert.deepEqual(readHistory('qb').map(v => v.text), ['b1'], '另一个文件的历史没被连带删掉');
assert.equal(readHistory('qa').some(v => v.label === '改名'), true);
localStorage.setItem = (k, v) => data.set(k, v);
clearHistory();

// Many tiny files are bounded by count even when their byte size stays small.
for (let i = 0; i < 230; i++) assert.equal(recordVersion('tiny-' + i, 'v' + i).ok, true);
assert.equal(historyUsage('tiny-229').versions, HISTORY_LIMITS.total);
assert.equal(readHistory('tiny-0').length, 0);
assert.equal(readHistory('tiny-229')[0].text, 'v229');
clearHistory();
for (let i = 0; i < 16; i++) recordVersion('large-' + i, '文'.repeat(90000));
assert.ok(historyUsage('large-15').bytes <= HISTORY_LIMITS.characters * 2);
assert.equal(copyHistory('large-15', 'large-copy'), true);
assert.ok(historyUsage('large-copy').bytes <= HISTORY_LIMITS.characters * 2);
assert.equal(readHistory('large-copy')[0].text.length, 90000);

// 迁移语义（草稿转存为文件）：move=true 合并完把源键一起回收，否则旧草稿键长期占共享配额，
// 挤掉其他文件能用的历史深度
clearHistory();
const realNow = Date.now;
let clock = 1700000000000;
Date.now = () => ++clock;
try {
  recordVersion('["draft","d1"]', 'draft v1');
  recordVersion('["draft","d1"]', 'draft v2');
  recordVersion('["project","a.tex"]', 'file v1');
  assert.equal(copyHistory('["draft","d1"]', '["project","a.tex"]', { move: true }), true);
  assert.deepEqual(readHistory('["draft","d1"]'), [], 'The migrated-from key is reclaimed');
  assert.deepEqual(readHistory('["project","a.tex"]').map(v => v.text), ['file v1', 'draft v2', 'draft v1']);

  // 两个键共用同一版本 id 时按 id 去重，回收的只是源键、不牵连目标键自己的版本
  data.set('paperlite.history.v1', JSON.stringify({
    '["draft","d2"]': [{ id: 'shared', date: 3, text: 'A' }, { id: 'mine', date: 2, text: 'B' }],
    '["project","b.tex"]': [{ id: 'shared', date: 3, text: 'A' }, { id: 'theirs', date: 1, text: 'C' }],
  }));
  assert.equal(copyHistory('["draft","d2"]', '["project","b.tex"]', { move: true }), true);
  assert.deepEqual(readHistory('["project","b.tex"]').map(v => v.id), ['shared', 'mine', 'theirs']);
  assert.equal(readHistory('["draft","d2"]').length, 0);

  // 缺省仍是复制：重命名迁移与多标签共用键的场景依赖源键留着
  data.set('paperlite.history.v1', JSON.stringify({ '["draft","d3"]': [{ id: 'keep', date: 1, text: 'D' }] }));
  assert.equal(copyHistory('["draft","d3"]', '["project","c.tex"]'), true);
  assert.equal(copyHistory('["draft","d3"]', '["project","d.tex"]', { move: false }), true);
  assert.equal(readHistory('["draft","d3"]').length, 1, 'move=false keeps the source key');
  assert.equal(historyUsage('["project","c.tex"]').files, 3);
} finally { Date.now = realNow; }
clearHistory();

// 同一个旧键被两个标签共用（同名文件开两次）：第一条迁移回收源键后，第二条读到的是空键，
// 目标键里的版本必须一条不少（改名路径就是这种形状）
data.set('paperlite.history.v1', JSON.stringify({
  '["project","a.tex"]': [{ id: 'x1', date: 5, text: 'X' }, { id: 'x2', date: 4, text: 'Y' }],
}));
assert.equal(copyHistory('["project","a.tex"]', '["project","a2.tex"]', { move: true }), true);
assert.equal(copyHistory('["project","a.tex"]', '["project","a2.tex"]', { move: true }), true);
assert.deepEqual(readHistory('["project","a2.tex"]').map(v => v.id), ['x1', 'x2']);
assert.equal(readHistory('["project","a.tex"]').length, 0);

// 迁移写不进去时 move 绝不能「只删了源键、目标没收到」：整份历史原样保留
data.set('paperlite.history.v1', JSON.stringify({ '["draft","d4"]': [{ id: 'keep', date: 1, text: 'D' }] }));
localStorage.setItem = () => { throw new Error('Quota exceeded'); };
assert.equal(copyHistory('["draft","d4"]', '["project","e.tex"]', { move: true }), false);
localStorage.setItem = (k, v) => data.set(k, v);
assert.deepEqual(readHistory('["draft","d4"]').map(v => v.id), ['keep'], 'A failed migration keeps the source key');
assert.equal(readHistory('["project","e.tex"]').length, 0);
clearHistory();

// 僵尸键清理：没有任何打开标签引用的键（转存留下的内存键、旧版共用键、形状坏掉的键）
// 只统计与整键回收，被保留的键一条版本都不许动
data.set('paperlite.history.v1', JSON.stringify({
  '["project","open.tex"]': [{ id: 'live1', date: 9, text: 'live' }, { id: 'live2', date: 8, text: 'older' }],
  '["","(未保存)/gone.tex"]': [{ id: 'gone1', date: 7, text: 'G' }],
  '["","draft"]': [{ id: 'legacy', date: 6, text: 'L' }],
  undefined: [{ id: 'broken', date: 5, text: 'B' }],
}));
const keep = ['["project","open.tex"]'];
const stale = unusedHistory(keep);
assert.deepEqual([stale.keys, stale.versions], [3, 3], 'Every key outside the open tabs counts as stale');
assert.ok(stale.bytes > 0 && stale.bytes < data.get('paperlite.history.v1').length * 2,
  'The freed-space estimate covers only the stale keys, never the whole store');
const pruned = pruneHistory(keep);
assert.deepEqual([pruned.ok, pruned.keys, pruned.versions], [true, 3, 3]);
assert.deepEqual(Object.keys(JSON.parse(data.get('paperlite.history.v1'))), keep, 'Only the open tab key survives');
assert.deepEqual(readHistory('["project","open.tex"]').map(v => v.id), ['live1', 'live2'], 'Kept versions are untouched');
assert.deepEqual([unusedHistory(keep).keys, pruneHistory(keep).keys], [0, 0], 'Nothing left to prune');

// 清理写不进去时整份存储原样保留，不能出现「键删了一半」
data.set('paperlite.history.v1', JSON.stringify({
  '["project","open.tex"]': [{ id: 'live1', date: 9, text: 'live' }],
  '["","draft"]': [{ id: 'legacy', date: 6, text: 'L' }],
}));
const before = data.get('paperlite.history.v1');
localStorage.setItem = () => { throw new Error('Quota exceeded'); };
assert.equal(pruneHistory(['["project","open.tex"]']).ok, false);
localStorage.setItem = (k, v) => data.set(k, v);
assert.equal(data.get('paperlite.history.v1'), before, 'A failed prune leaves the store untouched');
assert.deepEqual(readHistory('["","draft"]').map(v => v.id), ['legacy']);
clearHistory();

// Same raw payload is parsed once, and cross-tab/storage changes invalidate it.
data.set('paperlite.history.v1', JSON.stringify({ external: [{ id: 'e', text: 'external', date: 1 }] }));
const parse = JSON.parse;
let parses = 0;
JSON.parse = (...args) => { parses++; return parse(...args); };
try {
  for (let i = 0; i < 50; i++) { readHistory('external'); historyUsage('external'); }
  assert.equal(parses, 1);
  data.set('paperlite.history.v1', '{}');
  assert.equal(readHistory('external').length, 0);
  assert.equal(parses, 2);
} finally { JSON.parse = parse; }

data.clear();
const largeBackup = recordVersion(key, 'a'.repeat(600000), { reason: 'beforeRestore' });
assert.equal(largeBackup.ok, true);
assert.equal(recordVersion(key, 'b'.repeat(600000), { protectIds: [largeBackup.version.id] }).ok, false);
assert.equal(readHistory(key)[0].id, largeBackup.version.id);
assert.equal(recordVersion(key, 'x'.repeat(1000001)).ok, false);
assert.equal(readHistory(key)[0].id, largeBackup.version.id);
localStorage.setItem = () => { throw new Error('Quota exceeded'); };
assert.equal(recordVersion(key, 'unpersistable').ok, false);
assert.equal(renameVersion(key, largeBackup.version.id, 'fail'), false);
assert.equal(readHistory(key)[0].id, largeBackup.version.id);
assert.equal(clearHistory(), false);
assert.equal(readHistory(key)[0].id, largeBackup.version.id);
console.log('History: exact diff reconstruction, CRLF/EOF, large edits, labels, restore backups and storage failure passed.');

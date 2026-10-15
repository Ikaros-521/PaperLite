import assert from 'node:assert/strict';
import { compareVersions, inlineChanges } from '../src/historyDiff.js';
import { readHistory, recordVersion, renameVersion, copyHistory, deleteHistory, clearHistory, historyUsage } from '../src/fileActions.js';
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

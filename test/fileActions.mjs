import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { validName, wordCount, readHistory, recordVersion, sourceZip } from '../src/fileActions.js';

assert.equal(validName('../paper.tex'), false);
assert.equal(validName('..'), false);
assert.equal(validName('论文.tex'), true);
// Windows 保留设备名：建得出来但内容读不回普通文件，界面不能报「已保存」
['CON.tex', 'con', 'NUL.tex', 'nul.txt', 'AUX.log', 'PRN.txt', 'COM1.tex', 'LPT9.tex', 'CON.tar.gz'].forEach(n =>
  assert.equal(validName(n), false, n + ' 是 Windows 保留名'));
['main.tex', 'my.con', 'notes.txt', 'concrete.tex', 'LPT10.tex', 'com1x.tex'].forEach(n =>
  assert.equal(validName(n), true, n + ' 不是保留名'));
assert.deepEqual(wordCount('中文 hello world café'), { cjk: 2, words: 3, total: 5, characters: 16 });
const data = new Map();
globalThis.localStorage = { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) };
recordVersion('a', 'initial'); recordVersion('a', 'initial');
assert.equal(readHistory('a').length, 1);
for (let i = 0; i < 25; i++) recordVersion('a', 'version ' + i);
assert.equal(readHistory('a').length, 20);
assert.equal(readHistory('a')[0].text, 'version 24');
recordVersion('b', 'other file');
assert.equal(readHistory('b')[0].text, 'other file');
data.set('paperlite.history.v1', 'invalid JSON');
assert.deepEqual(readHistory('a'), []);
recordVersion('a', 'recovered');
assert.equal(readHistory('a')[0].text, 'recovered');
const zip = sourceZip([{ name: '论文/main.tex', bytes: '中文 source' }, { name: 'img.bin', bytes: new Uint8Array([0, 255, 128]) }, { name: 'empty.txt', bytes: '' }]);
const bytes = Buffer.from(await zip.arrayBuffer());
const result = spawnSync('python', ['-c', "import sys,zipfile,io; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; assert z.read('论文/main.tex').decode() == '中文 source'; assert z.read('img.bin') == bytes([0,255,128]); assert z.read('empty.txt') == b''"], { input: bytes, encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
assert.throws(() => sourceZip([{ name: 'same', bytes: '' }, { name: 'same', bytes: '' }]));
console.log('File actions: counts, bounded history, Unicode/binary ZIP round trip passed.');

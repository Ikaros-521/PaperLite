import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { validName, agentPathCheck, wordCount, readHistory, recordVersion, sourceZip } from '../src/fileActions.js';

// Agent 建文件的路径判据必须与 UI 同一份（validName），否则保留名从这条路上过去：
// App.jsx 里内联那份只挡了非法字符与点开头，NUL.tex/con.tex 照建
assert.equal(agentPathCheck('NUL.tex').code, 'bad_name', 'Windows 保留名要拒');
assert.equal(agentPathCheck('sub/con.tex').code, 'bad_name', '中间目录同样按段校验');
assert.equal(agentPathCheck('a/b. ').code, 'bad_name', '结尾空格/点要拒');
assert.equal(agentPathCheck('a/../b.tex').code, 'bad_name', '.. 是坏名字，不是「静默换个目标」');
assert.equal(agentPathCheck('a\\b.tex').code, 'bad_name', '反斜杠不当分隔符');
assert.equal(agentPathCheck('x?y.tex').code, 'bad_name');
assert.equal(agentPathCheck('').code, 'bad_name', '空路径');
assert.equal(agentPathCheck('///').code, 'bad_name', '只有分隔符');
assert.equal(agentPathCheck('.latexmkrc').code, 'hidden_path', '合法名但隐藏路径，走更准的那条文案');
assert.equal(agentPathCheck('src/.env').code, 'hidden_path');
assert.equal(agentPathCheck('figs/flow 1.tex').path, 'figs/flow 1.tex', '正常路径原样（按段归一后）通过');
assert.equal(agentPathCheck('a//b.tex').path, 'a/b.tex', '重复分隔符归一');
assert.equal(agentPathCheck('论文/方法.tex').path, '论文/方法.tex');

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

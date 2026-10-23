/* PaperLite · 伴随服务器安全加固单测（路径逃逸拦截、Host 校验、原语防护） */
import assert from 'node:assert';
import { escapingPath, findEscapingArgs, forbiddenHost, forbiddenOrigin } from '../server.mjs';

console.log('== escapingPath 路径边界判定 ==');
assert.strictEqual(escapingPath('main.tex'), false, '当前目录正常文件放行');
assert.strictEqual(escapingPath('figures/plot.pdf'), false, '子目录正常文件放行');
assert.strictEqual(escapingPath('"figures/my plot.png"'), false, '带引号的合法相对路径放行');

assert.strictEqual(escapingPath('../secret.txt'), true, '父级路径 .. 拦截');
assert.strictEqual(escapingPath('"../secret.txt"'), true, '带引号的父级路径 .. 拦截');
assert.strictEqual(escapingPath('/etc/passwd'), true, '绝对路径 / 拦截');
assert.strictEqual(escapingPath('"/etc/passwd"'), true, '带引号的绝对路径 / 拦截');
assert.strictEqual(escapingPath('C:/Windows/win.ini'), true, '盘符路径 C:/ 拦截');
assert.strictEqual(escapingPath('"C:/Windows/win.ini"'), true, '带引号的盘符路径 "C:/..." 拦截');
assert.strictEqual(escapingPath('D:\\secret.txt'), true, 'Windows 反斜杠盘符路径拦截');
assert.strictEqual(escapingPath('"D:\\secret.txt"'), true, '带引号的 Windows 反斜杠盘符路径拦截');
assert.strictEqual(escapingPath('~/.ssh/id_rsa'), true, '家目录 ~ 路径拦截');
assert.strictEqual(escapingPath('"~/.ssh/id_rsa"'), true, '带引号的家目录 ~ 路径拦截');

console.log('== findEscapingArgs TeX 读写原语与越界参数抓取 ==');
const safeTex = '\\documentclass{article}\n\\input{sub.tex}\n\\includegraphics{fig.png}\n\\begin{document}Hello\\end{document}';
assert.deepStrictEqual(findEscapingArgs(safeTex), [], '合法 TeX 不产生越界报警');

const quotedTex = '\\input{"C:/secret.tex"}';
assert.ok(findEscapingArgs(quotedTex).length > 0, '带引号的越界 input 被捕获');

const openinNoEq = '\\openin 0 /etc/passwd';
assert.ok(findEscapingArgs(openinNoEq).length > 0, '省略等号的 openin 越界被捕获');

const openinWithEq = '\\openin 15 = C:/secret.txt';
assert.ok(findEscapingArgs(openinWithEq).length > 0, '带等号的 openin 越界被捕获');

const openoutTex = '\\openout 1 = /tmp/evil.txt';
assert.ok(findEscapingArgs(openoutTex).length > 0, 'openout 越界写盘原语被捕获');

console.log('== Host 头校验（DNS 重绑定防御）==');
assert.strictEqual(forbiddenHost({ headers: { host: 'localhost:8788' } }), false, 'localhost 放行');
assert.strictEqual(forbiddenHost({ headers: { host: '127.0.0.1:8788' } }), false, '127.0.0.1 放行');
assert.strictEqual(forbiddenHost({ headers: { host: '[::1]:8788' } }), false, '[::1] 放行');
assert.strictEqual(forbiddenHost({ headers: { host: 'localhost' } }), false, '不带端口的 localhost 放行');
assert.strictEqual(forbiddenHost({ headers: {} }), false, '无 host 请求放行');

assert.strictEqual(forbiddenHost({ headers: { host: 'evil.com:8788' } }), true, '外部域名拦截');
assert.strictEqual(forbiddenHost({ headers: { host: 'rebind.attacker.org' } }), true, 'DNS 重绑定域名拦截');
assert.strictEqual(forbiddenHost({ headers: { host: 'localhost.evil.com' } }), true, '前缀欺骗域名拦截');

console.log('== Origin 头跨站拦截 ==');
assert.strictEqual(forbiddenOrigin({ headers: { origin: 'http://localhost:5173' } }), false, '本地开发源放行');
assert.strictEqual(forbiddenOrigin({ headers: { origin: 'http://127.0.0.1:8788' } }), false, '本地服务源放行');
assert.strictEqual(forbiddenOrigin({ headers: {} }), false, '无 origin 头（非浏览器）放行');
assert.strictEqual(forbiddenOrigin({ headers: { origin: 'https://evil.com' } }), true, '恶意跨域网站拦截');
assert.strictEqual(forbiddenOrigin({ headers: { origin: 'null' } }), true, 'null 来源拦截');

console.log('serverHardening: all tests passed');

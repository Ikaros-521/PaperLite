// Exercise the shipped WASM engines and local mirror, with no TeX installation/network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const engineDir = fileURLToPath(new URL('../public/xelatex/', import.meta.url));

async function loadEngine(name) {
  let reply;
  let ready;
  const initialized = new Promise(resolve => { ready = resolve; });
  const context = vm.createContext({
    require: createRequire(import.meta.url), process,
    __dirname: engineDir, setTimeout, clearTimeout,
    TextDecoder, TextEncoder, Uint8Array, ArrayBuffer,
    Module: { wasmBinary: fs.readFileSync(path.join(engineDir, name + '.wasm')) },
    console: { log() {}, error() {}, warn() {} },
    texlive_localrepo: path.join(engineDir, 'repo') + '/',
    postMessage(data) {
      if (!data.cmd && data.result === 'ok') ready();
      else reply = data;
    },
  });
  context.self = context;
  vm.runInContext(fs.readFileSync(path.join(engineDir, name + '.js'), 'utf8'), context);
  await initialized;
  return (cmd, payload = {}) => {
    reply = undefined;
    context.onmessage({ data: { cmd, ...payload } });
    return reply;
  };
}

const tex = await loadEngine('swiftlatexxetex');
const source = String.raw`\documentclass{ctexart}
\usepackage{booktabs}
\begin{document}
中文宋体 \textbf{中文粗体} \textit{中文楷体}
{\sffamily 中文黑体 \bfseries 中文粗黑体}
{\ttfamily 中文仿宋}
\begin{tabular}{ll}
\toprule
名称 & 数值 \\
\midrule
测试 & 42 \\
\cmidrule(lr){1-2}
\multicolumn{2}{c}{合计} \\
\bottomrule
\end{tabular}
\end{document}`;
tex('writefile', { url: 'main.tex', src: source });
tex('setmainfile', { url: 'main.tex' });
let result;
for (let pass = 1; pass <= 2; pass++) {
  result = tex('compilelatex');
  assert.equal(result?.result, 'ok', `XeTeX pass ${pass}:\n${result?.log}`);
  assert.equal(result.status, 0, result.log);
}
for (const font of ['FandolSong-Regular', 'FandolSong-Bold', 'FandolKai-Regular',
  'FandolHei-Regular', 'FandolHei-Bold', 'FandolFang-Regular']) {
  assert.ok(result.log.includes(font + '.fontspec'), `Configuration loaded: ${font}`);
}
assert.ok(result.log.includes('booktabs.sty'), 'booktabs loaded from mirror');

const pdf = await loadEngine('swiftlatexdvipdfm');
pdf('writefile', { url: 'main.xdv', src: new Uint8Array(result.pdf) });
pdf('setmainfile', { url: 'main.xdv' });
result = pdf('compilepdf');
assert.equal(result?.result, 'ok', result?.log);
assert.ok(result.pdf, 'PDF produced');
assert.equal(Buffer.from(result.pdf).subarray(0, 5).toString(), '%PDF-');
console.log('XeLaTeX regression passed: Chinese fonts + booktabs → XDV → PDF');

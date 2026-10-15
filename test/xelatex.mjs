// Exercise the shipped WASM engines and local mirror, with no TeX installation/network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { samples } from '../src/engines/samples.js';
import { prepareXeLaTeXSource } from '../src/engines/xelatexCompatibility.js';

const engineDir = fileURLToPath(new URL('../public/xelatex/', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(engineDir, 'repo/manifest.json'), 'utf8'));
const requests = new Set();
const missingRequests = [];

async function loadEngine(name) {
  let reply;
  let ready;
  const initialized = new Promise(resolve => { ready = resolve; });
  const context = vm.createContext({
    require: createRequire(import.meta.url), process: { ...process, on() {} },
    __dirname: engineDir, setTimeout, clearTimeout,
    TextDecoder, TextEncoder, Uint8Array, ArrayBuffer,
    Module: { wasmBinary: fs.readFileSync(path.join(engineDir, name + '.wasm')) },
    console: { log() {}, error() {}, warn() {} },
    texlive_localrepo: path.join(engineDir, 'repo') + '/',
    // Route the actual synchronous XHR code through the static mirror. Any
    // missing HTTP resource fails, including optional kpathsea probes.
    XMLHttpRequest: class {
      open(method, url) { this.url = url; }
      send() {
        const key = new URL(this.url).pathname.split('/repo/xetex/')[1];
        if (!key || !manifest.files.includes(key)) missingRequests.push(this.url);
        assert.ok(key && manifest.files.includes(key), `Unexpected HTTP request: ${this.url}`);
        requests.add(key);
        const bytes = fs.readFileSync(path.join(engineDir, 'repo/xetex', key));
        this.status = 200;
        this.response = Uint8Array.from(bytes).buffer;
      }
      getResponseHeader() { return null; }
    },
    postMessage(data) {
      if (!data.cmd && data.result === 'ok') ready();
      else reply = data;
    },
  });
  context.self = context;
  vm.runInContext(fs.readFileSync(path.join(engineDir, name + '.js'), 'utf8'), context);
  await initialized;
  // Keep Emscripten's Node bootstrap, then exercise its browser resource path.
  context.process = new Proxy(process, {
    get(target, key) { return key === 'versions' ? {} : Reflect.get(target, key); },
  });
  context.onmessage({ data: { cmd: 'settexliveurl', url: 'https://paperlite.test/xelatex/repo/' } });
  context.onmessage({ data: { cmd: 'settexlivemanifest', files: manifest.files } });
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

const fixtures = {
  ...samples,
  elegantpaper: fs.readFileSync(new URL('./fixtures/elegantpaper-demo.tex', import.meta.url), 'utf8'),
  // Reproduce documents already saved before the template dependencies were
  // fixed; replacing samples alone does not update these browser documents.
  legacyDemo: samples.demo
    .replace('booktabs,amsmath,amssymb,graphicx', 'booktabs,amsmath,graphicx')
    .replace(/^.*(?:fancyvrb|Mermaid 在网页|DefineVerbatimEnvironment|usetikzlibrary).*\n/gm, ''),
  legacyFlow: samples.flow.replace(/^.*usetikzlibrary.*\n/gm, ''),
  mathematics: String.raw`\documentclass{article}
\usepackage{amsmath,amssymb,amsthm,mathtools,bm,mathrsfs,cancel,siunitx}
\newtheorem{theorem}{Theorem}
\begin{document}
\textbf{Bold} \textit{Italic} \texttt{Monospace} {\sffamily Sans}
\begin{align}
\bm{x} &\in \mathbb{R}^{3}, &\mathscr{F}(x)&=\int_0^\infty e^{-x^2}\,dx\\
A&=\begin{pmatrix}1&2\\3&4\end{pmatrix}, &f(x)&=\cancel{x}+\dfrac{1}{2}
\end{align}
\begin{theorem}For every $x$, $x=x$.\end{theorem}
\qty{1.23}{\metre\per\second}
\end{document}`,
  packages: String.raw`\documentclass{ctexrep}
\usepackage{geometry,graphicx,xcolor,hyperref,bookmark,cleveref}
\usepackage{booktabs,longtable,tabularx,multirow,makecell,colortbl,threeparttable}
\usepackage{enumitem,fancyhdr,setspace,caption,subcaption,float,listings,ulem}
\usepackage{adjustbox,csquotes,natbib,parskip,wrapfig}
\geometry{margin=25mm}
\begin{document}
\chapter{宏包组合验证}\label{chap:test}
\href{https://example.com}{超链接} \cref{chap:test} \enquote{quoted}
\begin{enumerate}[label=\arabic*.]\item 中文列表\end{enumerate}
\begin{tabularx}{\linewidth}{lX}\toprule
\makecell{第一行\\第二行} & \textcolor{red}{测试}\\\bottomrule
\end{tabularx}
\begin{longtable}{ll}\toprule A&B\\\midrule C&D\\\bottomrule\end{longtable}
\begin{lstlisting}[language=Python]
print(42)
\end{lstlisting}
\rotatebox{15}{\fbox{Graphic transform}}
\end{document}`,
  plots: String.raw`\documentclass{article}
\usepackage{pgfplots}
\pgfplotsset{compat=1.18}
\usetikzlibrary{arrows.meta,calc,decorations.pathmorphing,shapes.geometric}
\begin{document}
\begin{tikzpicture}\begin{axis}[xlabel=$x$,ylabel=$y$]
\addplot[blue,domain=0:2]{x^2};
\end{axis}\end{tikzpicture}
\end{document}`,
  unicodeMath: String.raw`\documentclass{ctexbook}
\usepackage{unicode-math}
\setmathfont{latinmodern-math.otf}
\begin{document}
\chapter{Unicode 数学}
\[\symbf{x}\in\mathbb{R},\quad\int_0^1 x^2\,dx=\frac13\]
\end{document}`,
  additionalPackages: String.raw`\documentclass{article}
\usepackage{physics,stmaryrd,wasysym,xltxtra,fvextra,microtype}
\usepackage{algorithm,algorithmic,titlesec,titling,footmisc,threeparttable}
\usepackage{environ,newunicodechar,xurl}
\begin{document}
\[\dv{f}{x}=\braket{a}{b},\quad\llbracket x\rrbracket\]
\smiley
\begin{algorithm}\caption{Example}
\begin{algorithmic}\STATE $x\gets 1$\end{algorithmic}\end{algorithm}
\end{document}`,
};
if (process.argv[2]) fixtures.userDocument = fs.readFileSync(process.argv[2], 'utf8');
for (const [name, source] of Object.entries(fixtures)) {
  tex('flushcache');
  const prepared = prepareXeLaTeXSource(source);
  assert.equal(prepared.split('\n').length, source.split('\n').length, `${name}: error line numbers preserved`);
  assert.equal(prepareXeLaTeXSource(prepared), prepared, `${name}: preparation is idempotent`);
  if (!name.startsWith('legacy')) assert.equal(prepared, source, `${name}: no compatibility changes needed`);
  tex('writefile', { url: 'main.tex', src: prepared });
  for (let pass = 1; pass <= 2; pass++) {
    result = tex('compilelatex');
    assert.equal(result?.result, 'ok', `${name} pass ${pass}:\n${result?.log}`);
  }
  pdf('flushcache');
  pdf('writefile', { url: 'main.xdv', src: new Uint8Array(result.pdf) });
  result = pdf('compilepdf');
  assert.equal(result?.result, 'ok', `${name} PDF:\n${result?.log}`);
  assert.equal(Buffer.from(result.pdf).subarray(0, 5).toString(), '%PDF-');
  if (name === 'userDocument' && process.argv[3]) {
    fs.writeFileSync(process.argv[3], Buffer.from(result.pdf));
  }
  console.log(`Template ${name}: XeTeX → PDF passed`);
}
tex('flushcache');
tex('writefile', { url: 'main.tex', src: String.raw`\documentclass{article}
\usepackage{paperlite-deliberately-missing}\begin{document}Test\end{document}` });
result = tex('compilelatex');
assert.equal(result.result, 'failed', 'A genuinely missing package must still fail');
assert.match(result.log, /paperlite-deliberately-missing\.sty/);
assert.deepEqual(missingRequests, [], 'No HTTP requests for absent resources, including optional probes');
console.log(`${requests.size} distinct HTTP resources loaded; zero missing-resource requests`);

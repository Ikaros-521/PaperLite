/* PaperLite · 内置 XeLaTeX 编译器（WebAssembly，双 Worker）
 *
 * 管线与 SwiftLaTeX 官方 demo 一致：
 *   XeTeX(wasm) → XDV → dvipdfmx(wasm) → PDF
 * 引擎文件与 TeX 宏包镜像位于 public/xelatex/（见 NOTICE.md），
 * 编译时由引擎内的 kpathsea 钩子按需同步拉取 repo/xetex/<格式号>/<文件名>。
 *
 * 懒加载策略：App 挂载后空闲时调用 preloadEngine() 后台预热（Worker 创建 +
 * wasm 实例化都在 Worker 线程，不阻塞 UI）；编译前若未就绪则等待预热完成。
 * 引擎就绪后按 repo/warm.json（= 冷编译的请求顺序）在后台预取镜像文件填充
 * HTTP 缓存，首次编译的同步 XHR 因此几乎不产生网络往返。
 */

import { prepareXeLaTeXSource } from './xelatexCompatibility.js';

const BASE = ((import.meta.env && import.meta.env.BASE_URL) || '/') + 'xelatex/';
// Worker 里同步 XHR 的相对 URL 以 Worker 脚本位置为基准，必须在主线程解析成绝对地址
const REPO_URL = new URL(BASE + 'repo/', document.baseURI).href;
const FMT_KEY = '10/swiftlatexxetex.fmt';
const WARM_URL = REPO_URL + 'warm.json';
// 清单里的键沿用 manifest 的「格式号/文件名」，Worker 实际请求时才加 xetex/ 一层
const repoUrl = key => REPO_URL + 'xetex/' + key;
// 慢链路首编译要拉 ~31MB 格式文件 + 宏包字体，给足时间
const COMPILE_TIMEOUT = 900000;
// 后台预取并发：够填满带宽，又不至于饿死编译自身的请求
const PREFETCH_CONCURRENCY = 6;

let status = 'idle'; // idle | loading | ready | warming | busy | error
let loadPromise = null;
let texWorker = null;
let pdfWorker = null;
let warming = false;
const listeners = new Set();

function setStatus(s) {
  status = s;
  listeners.forEach(fn => { try { fn(s); } catch (e) { /* listener error ignored */ } });
}

export function engineStatus() { return status; }

export function onEngineStatus(fn) {
  listeners.add(fn);
  if (status !== 'idle') fn(status);
  return () => listeners.delete(fn);
}

// 拉完整个响应体才会真正落进 HTTP 缓存；用 reader 逐块丢弃，避免 31MB 常驻内存。
// 返回响应能否缓存，供调用方判断预取是否有意义。
async function prefetch(url) {
  const response = await fetch(url, { cache: 'force-cache' });
  // 托管服务常把未知路径兜底成 200 的 index.html，预取会把 HTML 当 TeX 资源缓存住
  if (!response.ok || /text\/html/i.test(response.headers.get('content-type') || '')) {
    throw new Error('HTTP ' + response.status);
  }
  const cacheable = !/no-store/i.test(response.headers.get('cache-control') || '');
  if (!response.body) { await response.arrayBuffer(); return cacheable; }
  const reader = response.body.getReader();
  while (!(await reader.read()).done) { /* 丢弃 */ }
  return cacheable;
}

async function warmFileList() {
  try {
    const response = await fetch(WARM_URL, { cache: 'no-cache' });
    const data = response.ok ? await response.json() : null;
    if (data && data.version === 1 && Array.isArray(data.files)) {
      return data.files.filter(key => key !== FMT_KEY);
    }
  } catch (e) { /* 没有预热清单时只预取格式文件 */ }
  return [];
}

// 后台预取首次编译要用的镜像文件。清单顺序即冷编译的请求顺序，默认文档所需的
// 格式文件与中文字体最先完成；单个资源失败只是回到按需拉取，不影响编译。
async function prefetchResources() {
  warming = true;
  setStatus('warming');
  try {
    const files = await warmFileList();
    let cacheable = true;
    try { cacheable = await prefetch(repoUrl(FMT_KEY)); } catch (e) { /* 交给编译时按需请求 */ }
    // vite dev 给所有响应加 no-store，此时预取只是白下载几十 MB，直接放弃
    if (!cacheable) return;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(PREFETCH_CONCURRENCY, files.length) }, async () => {
      while (next < files.length) {
        const key = files[next++];
        try { await prefetch(repoUrl(key)); } catch (e) { /* 继续下一个 */ }
      }
    }));
  } finally {
    warming = false;
    if (status === 'warming') setStatus('ready');
  }
}

// Worker 装载完成时胶水会 postMessage({result:'ok'})
function waitReady(w, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(label + ' engine load timeout')); }, 120000);
    function onmsg(ev) {
      const d = ev.data || {};
      if (d.result === 'ok') { cleanup(); resolve(); }
      else if (d.result === 'failed') { cleanup(); reject(new Error(label + ' engine failed to init')); }
    }
    function onerr(e) { cleanup(); reject(new Error(label + ' engine error: ' + (e.message || 'load failed'))); }
    function cleanup() { clearTimeout(timer); w.removeEventListener('message', onmsg); w.removeEventListener('error', onerr); }
    w.addEventListener('message', onmsg);
    w.addEventListener('error', onerr);
  });
}

// 后台预热（幂等）。失败后允许下次重试。
export function preloadEngine() {
  if (loadPromise) return loadPromise;
  if (typeof Worker === 'undefined') { setStatus('error'); return Promise.reject(new Error('no Worker support')); }
  setStatus('loading');
  loadPromise = (async () => {
    try {
      texWorker = new Worker(BASE + 'swiftlatexxetex.js');
      pdfWorker = new Worker(BASE + 'swiftlatexdvipdfm.js');
      const watch = w => { w.onerror = () => setStatus('error'); };
      watch(texWorker); watch(pdfWorker);
      const [, , manifest] = await Promise.all([
        waitReady(texWorker, 'XeTeX'),
        waitReady(pdfWorker, 'dvipdfmx'),
        fetch(REPO_URL + 'manifest.json', { cache: 'no-cache' }).then(async response => {
          if (!response.ok) throw new Error('TeX resource manifest load failed: HTTP ' + response.status);
          const data = await response.json();
          if (data.version !== 1 || !Array.isArray(data.files)) throw new Error('Invalid TeX resource manifest');
          return data;
        }),
      ]);
      // 默认端点是上游已失效的服务，改指同源静态镜像
      texWorker.postMessage({ cmd: 'settexliveurl', url: REPO_URL });
      pdfWorker.postMessage({ cmd: 'settexliveurl', url: REPO_URL });
      // kpathsea 会探测许多可选文件；清单中不存在的资源直接返回未找到，避免无效 HTTP 404。
      texWorker.postMessage({ cmd: 'settexlivemanifest', files: manifest.files });
      pdfWorker.postMessage({ cmd: 'settexlivemanifest', files: manifest.files });
      setStatus('ready');
      // 引擎可用后继续在后台预取，loadPromise 不等它——用户点编译不必等满 98MB
      prefetchResources();
    } catch (e) {
      setStatus('error');
      loadPromise = null;
      try { texWorker && texWorker.terminate(); } catch (e2) { /* noop */ }
      try { pdfWorker && pdfWorker.terminate(); } catch (e2) { /* noop */ }
      texWorker = pdfWorker = null;
      throw e;
    }
  })();
  return loadPromise;
}

// 调一次命令并等待特定回执（协议见胶水 onmessage）
function call(w, label, send, match, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(label + ' timeout')); }, timeoutMs || COMPILE_TIMEOUT);
    function onmsg(ev) {
      const d = ev.data || {};
      if (!match(d)) return;
      cleanup();
      resolve(d);
    }
    function onerr(e) { cleanup(); reject(new Error(label + ' crashed: ' + (e.message || 'worker error'))); }
    function cleanup() { clearTimeout(timer); w.removeEventListener('message', onmsg); w.removeEventListener('error', onerr); }
    w.addEventListener('message', onmsg);
    w.addEventListener('error', onerr);
    send();
  });
}

// 从 TeX 日志解析错误行（与 server.mjs 的 parseLog 保持同一形状）
function parseLog(log) {
  const errors = [];
  const lines = String(log || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const em = lines[i].match(/^!\s*(.*)/);
    if (em) {
      let line = null;
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const lm = lines[j].match(/^l\.(\d+)/);
        if (lm) { line = +lm[1] - 1; break; }
      }
      errors.push({ line, msg: em[1].trim() });
    }
  }
  return errors.slice(0, 30);
}

/** 编译 LaTeX 源码。返回 { ok, pdfBytes?, log, errors, engine:'builtin' } */
export async function compileXeLaTeX(source) {
  await preloadEngine();
  setStatus('busy');
  try {
    // 两遍编译：目录/交叉引用（与 server.mjs 行为一致）
    texWorker.postMessage({ cmd: 'writefile', url: 'main.tex', src: prepareXeLaTeXSource(source) });
    texWorker.postMessage({ cmd: 'setmainfile', url: 'main.tex' });
    let r1;
    try {
      r1 = await call(texWorker, 'XeTeX pass 1', () => texWorker.postMessage({ cmd: 'compilelatex' }), d => d.cmd === 'compile');
    } catch (e) {
      return { ok: false, log: '', errors: [{ line: null, msg: e.message || String(e) }], engine: 'builtin' };
    }
    if (r1.result !== 'ok' || r1.status !== 0) {
      const log = r1.log || '';
      return { ok: false, log, errors: parseLog(log), engine: 'builtin' };
    }
    let r2 = r1;
    try {
      r2 = await call(texWorker, 'XeTeX pass 2', () => texWorker.postMessage({ cmd: 'compilelatex' }), d => d.cmd === 'compile');
    } catch (e) { /* 第二遍失败不致命：沿用第一遍产物 */ }
    if (r2.result !== 'ok' || r2.status !== 0) {
      const log = r2.log || r1.log || '';
      return { ok: false, log, errors: parseLog(log), engine: 'builtin' };
    }
    const xdv = new Uint8Array(r2.pdf);

    pdfWorker.postMessage({ cmd: 'writefile', url: 'main.xdv', src: xdv });
    pdfWorker.postMessage({ cmd: 'setmainfile', url: 'main.xdv' });
    const r3 = await call(pdfWorker, 'dvipdfmx', () => pdfWorker.postMessage({ cmd: 'compilepdf' }), d => d.cmd === 'compile');
    if (r3.result !== 'ok' || !r3.pdf) {
      const log = r3.log || '';
      return { ok: false, log, errors: parseLog(log).concat([{ line: null, msg: 'dvipdfmx failed' }]), engine: 'builtin' };
    }
    return { ok: true, pdfBytes: new Uint8Array(r3.pdf), log: r2.log || '', errors: [], engine: 'builtin' };
  } finally {
    setStatus(loadPromise ? (warming ? 'warming' : 'ready') : 'idle');
  }
}

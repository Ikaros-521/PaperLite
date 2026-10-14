/* PaperLite · 内置 XeLaTeX 编译器（WebAssembly，双 Worker）
 *
 * 管线与 SwiftLaTeX 官方 demo 一致：
 *   XeTeX(wasm) → XDV → dvipdfmx(wasm) → PDF
 * 引擎文件与 TeX 宏包镜像位于 public/xelatex/（见 NOTICE.md），
 * 编译时由引擎内的 kpathsea 钩子按需同步拉取 repo/xetex/<格式号>/<文件名>。
 *
 * 懒加载策略：App 挂载后空闲时调用 preloadEngine() 后台预热（Worker 创建 +
 * wasm 实例化都在 Worker 线程，不阻塞 UI）；编译前若未就绪则等待预热完成。
 */

const BASE = ((import.meta.env && import.meta.env.BASE_URL) || '/') + 'xelatex/';
// Worker 里同步 XHR 的相对 URL 以 Worker 脚本位置为基准，必须在主线程解析成绝对地址
const REPO_URL = new URL(BASE + 'repo/', document.baseURI).href;
const FMT_URL = REPO_URL + 'xetex/10/swiftlatexxetex.fmt';
// 慢链路首编译要拉 ~31MB 格式文件 + 宏包字体，给足时间
const COMPILE_TIMEOUT = 900000;

let status = 'idle'; // idle | loading | ready | busy | error
let loadPromise = null;
let texWorker = null;
let pdfWorker = null;
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
      await Promise.all([waitReady(texWorker, 'XeTeX'), waitReady(pdfWorker, 'dvipdfmx')]);
      // 默认端点是上游已失效的服务，改指同源静态镜像
      texWorker.postMessage({ cmd: 'settexliveurl', url: REPO_URL });
      pdfWorker.postMessage({ cmd: 'settexliveurl', url: REPO_URL });
      setStatus('ready');
      // 空闲预热顺带预取 LaTeX 格式文件（31MB，最大头）：进 HTTP 缓存后，
      // 引擎首次编译时的同步 XHR 直接命中缓存，慢链路也能显著提速
      fetch(FMT_URL, { cache: 'force-cache' }).catch(() => { /* 预热失败不影响编译 */ });
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
    texWorker.postMessage({ cmd: 'writefile', url: 'main.tex', src: String(source) });
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
    setStatus(loadPromise ? 'ready' : 'idle');
  }
}

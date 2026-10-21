/* PaperLite · 内置 XeLaTeX 编译器（WebAssembly，双 Worker）
 *
 * 管线与 SwiftLaTeX 官方 demo 一致：
 *   XeTeX(wasm) → XDV → dvipdfmx(wasm) → PDF
 * 引擎文件与 TeX 宏包镜像位于 public/xelatex/（见 NOTICE.md），
 * 编译时由引擎内的 kpathsea 钩子按需同步拉取 repo/xetex/<格式号>/<文件名>。
 *
 * 懒加载策略：App 挂载后空闲时调用 warmEngine(source) 后台预热（Worker 创建 +
 * wasm 实例化都在 Worker 线程，不阻塞 UI）。预热分两步：先用当前文档跑完整编译管线
 * 把它真正要用的文件拉进 Worker 内存缓存，再按 repo/warm.json（= 内置模板冷编译的
 * 请求顺序）并行预取其余文件，直接写入对应 Worker 缓存，供切换模板时使用。
 */

import { prepareXeLaTeXSource } from './xelatexCompatibility.js';
import { prepareCompileGraphics } from '../compileGraphics.js';
import { stripTexComments } from '../texComments.js';

const BASE = ((import.meta.env && import.meta.env.BASE_URL) || '/') + 'xelatex/';
// Worker 里同步 XHR 的相对 URL 以 Worker 脚本位置为基准，必须在主线程解析成绝对地址
const REPO_URL = new URL(BASE + 'repo/', document.baseURI).href;
const FMT_KEY = '10/swiftlatexxetex.fmt';
const WARM_URL = REPO_URL + 'warm.json';
// 清单里的键沿用 manifest 的「格式号/文件名」，Worker 实际请求时才加 xetex/ 一层
const repoUrl = key => REPO_URL + 'xetex/' + key;
// 慢链路首编译要拉 ~31MB 格式文件 + 宏包字体，给足时间；再长就该由用户手动取消
const COMPILE_TIMEOUT = 300000;
// 后台预取并发：够填满带宽，又不至于饿死编译自身的请求
const PREFETCH_CONCURRENCY = 6;

let status = 'idle'; // idle | loading | ready | warming | busy | error
let loadPromise = null;
let texWorker = null;
let pdfWorker = null;
let warming = false;
let warmPromise = null;
let pendingWarmSource = null;
let resourcesWarmed = false;
let generation = 0;
let loadAbort = null;
// 引擎级互斥。Worker 的命令队列是串行的，两条命令序列交错就会双双错拿对方的 compile 回执。
// useCompile 的 compiling 是渲染期闭包值，同一 tick 内两次调用都读到 false，重入只能在引擎里挡。
let compileGuard = null;            // 占住编译槽的标记，再进一趟 compileXeLaTeX 直接拒绝
let workerLockTail = Promise.resolve(); // Worker 使用权队列，正式编译与定向预热共用
const workerLockReleases = new Set();   // cancelCompile 用它放行排队者，避免拆掉 Worker 后锁死
let nextReqId = 1;
const listeners = new Set();

function checkGeneration(expected) {
  if (generation !== expected) throw new Error('cancelled');
}

// 排队取 Worker 使用权：前一个持有者结算（成功/失败/取消）后才轮到下一个。
// run 一定会结算，所以锁不会因异常而漏放；cancelCompile 另有强制放行兜底。
function withWorkerLock(run) {
  const waiting = workerLockTail;
  let release;
  workerLockTail = new Promise(resolve => { release = resolve; });
  workerLockReleases.add(release);
  return waiting.then(async () => {
    try { return await run(); } finally { workerLockReleases.delete(release); release(); }
  });
}

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

async function fetchResource(url, signal) {
  const response = await fetch(url, { cache: 'force-cache', signal });
  // 托管服务常把未知路径兜底成 200 的 index.html，预取会把 HTML 当 TeX 资源缓存住
  if (!response.ok || /text\/html/i.test(response.headers.get('content-type') || '')) {
    throw new Error('HTTP ' + response.status);
  }
  return response.arrayBuffer();
}

async function warmFileList(signal) {
  try {
    const response = await fetch(WARM_URL, { cache: 'no-cache', signal });
    const data = response.ok ? await response.json() : null;
    if (data && data.version === 1 && Array.isArray(data.files)) {
      return data;
    }
  } catch (e) { /* 没有预热清单时只预取格式文件 */ }
  return { files: [FMT_KEY], incomplete: true };
}

// HTTP 缓存在 no-store/禁用缓存时不可用，资源必须写进引擎真正读取的缓存。
// 只给实际使用该文件的 Worker 一份，避免把大格式文件和字体无差别复制两遍。
async function prefetchResources() {
  if (resourcesWarmed) return;
  const expected = generation, signal = loadAbort?.signal;
  const list = await warmFileList(signal);
  checkGeneration(expected);
  const workers = [texWorker, pdfWorker];
  const cached = await Promise.all(workers.map(w => call(w, 'TeX cache inventory',
    reqId => w.postMessage({ cmd: 'gettexlivecache', reqId }), d => d.cmd === 'gettexlivecache')));
  const cacheKeys = cached.map(d => new Set(d.files));
  const usage = list.engines ? [new Set(list.engines.tex), new Set(list.engines.pdf)] : null;
  const files = list.files;
  let next = 0;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(PREFETCH_CONCURRENCY, files.length) }, async () => {
    while (next < files.length) {
      const key = files[next++];
      const targets = workers.filter((w, i) => !cacheKeys[i].has(key)
        && (usage ? usage[i].has(key) : (i === 0 || key !== FMT_KEY)));
      if (!targets.length) continue;
      try {
        const bytes = await fetchResource(repoUrl(key), signal);
        checkGeneration(expected);
        await Promise.all(targets.map(w => call(w, 'TeX cache upload',
          reqId => w.postMessage({ cmd: 'cachetexlivefile', key, src: bytes, reqId }),
          d => d.cmd === 'cachetexlivefile' && d.key === key).then(result => {
          if (result.result !== 'ok') throw new Error(result.error || 'TeX cache upload failed');
        })));
      } catch (e) { checkGeneration(expected); failed = true; /* 单个文件失败时保留按需下载兜底，后续允许重试 */ }
    }
  }));
  checkGeneration(expected);
  resourcesWarmed = !failed && !list.incomplete;
}

/**
 * 页面空闲时启动的后台预热，分两步：
 *   1) 用当前打开的文档跑完 XeTeX → dvipdfmx（结果丢弃），把真正要用的宏包/字体拉进
 *      Worker 内存缓存——包括 warm.json 未覆盖的文件（如 biblatex 的 .cbx）；
 *   2) 再按清单预取其余镜像文件进各自 Worker 缓存，供切换模板时使用。
 * 预热期间引擎已经可以编译；正式编译只需等第 1 步（它占着 Worker）。
 */
export function warmEngine(source) {
  pendingWarmSource = String(source || '');
  if (warmPromise) return warmPromise;
  const expected = generation;
  warmPromise = preloadEngine().then(async () => {
    checkGeneration(expected);
    warming = true;
    try {
      do {
        checkGeneration(expected);
        const text = pendingWarmSource;
        pendingWarmSource = null;
        // 切换文档时若正式编译尚未完成，warmUpDocument 在锁上排队，不会插进它的命令序列
        if (/\\documentclass/.test(text)) await warmUpDocument(text);
        checkGeneration(expected);
        // 预取阶段不独占 Worker：编译在跑时状态栏继续显示 busy，别把它盖成 warming
        if (status !== 'busy') setStatus('warming');
        await prefetchResources();
      } while (pendingWarmSource !== null);
    } finally {
      if (generation === expected) {
        warming = false;
        if (status === 'warming') setStatus('ready');
      }
    }
  }).finally(() => { if (generation === expected) warmPromise = null; });
  return warmPromise;
}

// 两个 Worker 各自持有资源缓存。必须走到 PDF 阶段，才能预热映射表和嵌入字体；
// 仅预取 HTTP 缓存无法覆盖 no-store 或开发者工具禁用缓存的情况。
async function warmUpDocument(source) {
  const expected = generation;
  // 预热要独占两个 Worker（flushcache 会清掉工作目录）：与正式编译共用同一把锁，
  // 编译侧排队等它，warm 的 flushcache/writefile 就不会打进正在进行的编译。
  try {
    await withWorkerLock(() => {
      checkGeneration(expected);
      // 拿到 Worker 才标 warming：排队等锁期间进行中的编译该继续显示 busy
      setStatus('warming');
      // /work 的辅助文件属于上一篇文档；/tex 的资源缓存由两个引擎继续复用。
      texWorker.postMessage({ cmd: 'flushcache' });
      pdfWorker.postMessage({ cmd: 'flushcache' });
      texWorker.postMessage({ cmd: 'writefile', url: 'main.tex', src: prepareXeLaTeXSource(source) });
      texWorker.postMessage({ cmd: 'setmainfile', url: 'main.tex' });
      return call(texWorker, 'XeTeX warm-up',
        reqId => texWorker.postMessage({ cmd: 'compilelatex', reqId }), d => d.cmd === 'compile')
        .then(result => {
          checkGeneration(expected);
          if (result.result !== 'ok' || result.status !== 0 || !result.pdf) return;
          pdfWorker.postMessage({ cmd: 'writefile', url: 'main.xdv', src: new Uint8Array(result.pdf) });
          pdfWorker.postMessage({ cmd: 'setmainfile', url: 'main.xdv' });
          return call(pdfWorker, 'dvipdfmx warm-up',
            reqId => pdfWorker.postMessage({ cmd: 'compilepdf', reqId }), d => d.cmd === 'compile');
        });
    });
  } catch (e) { /* 预热编译报错不影响，文件已经拉到了 */ }
}

// Worker 装载完成时胶水会 postMessage({result:'ok'})
function waitReady(w, label) {
  return call(w, label + ' engine load', () => {},
    d => !d.cmd && (d.result === 'ok' || d.result === 'failed'), 120000).then(d => {
    if (d.result !== 'ok') throw new Error(label + ' engine failed to init');
  });
}

// 后台预热（幂等）。失败后允许下次重试。
export function preloadEngine() {
  if (loadPromise) return loadPromise;
  if (typeof Worker === 'undefined') { setStatus('error'); return Promise.reject(new Error('no Worker support')); }
  const expected = generation;
  const abort = loadAbort = new AbortController();
  setStatus('loading');
  loadPromise = (async () => {
    try {
      texWorker = new Worker(BASE + 'tex-worker.js');
      pdfWorker = new Worker(BASE + 'pdf-worker.js');
      // 运行期崩溃（wasm OOM / worker 未捕获异常）不能只改状态：死 worker 仍被
      // loadPromise 视为可用，下次编译要挂满超时才报错。terminate 并清空句柄，
      // 让下次编译重新加载引擎。
      const watch = w => {
        w.onerror = () => {
          if (generation !== expected) return;
          setStatus('error');
          loadPromise = null;
          resourcesWarmed = false;
          try { w.terminate(); } catch (e2) { /* noop */ }
          if (texWorker === w) texWorker = null;
          if (pdfWorker === w) pdfWorker = null;
        };
      };
      watch(texWorker); watch(pdfWorker);
      const [, , manifest] = await Promise.all([
        waitReady(texWorker, 'XeTeX'),
        waitReady(pdfWorker, 'dvipdfmx'),
        fetch(REPO_URL + 'manifest.json', { cache: 'no-cache', signal: abort.signal }).then(async response => {
          if (!response.ok) throw new Error('TeX resource manifest load failed: HTTP ' + response.status);
          const data = await response.json();
          if (data.version !== 1 || !Array.isArray(data.files)) throw new Error('Invalid TeX resource manifest');
          return data;
        }),
      ]);
      checkGeneration(expected);
      // 默认端点是上游已失效的服务，改指同源静态镜像
      texWorker.postMessage({ cmd: 'settexliveurl', url: REPO_URL });
      pdfWorker.postMessage({ cmd: 'settexliveurl', url: REPO_URL });
      // kpathsea 会探测许多可选文件；清单中不存在的资源直接返回未找到，避免无效 HTTP 404。
      texWorker.postMessage({ cmd: 'settexlivemanifest', files: manifest.files });
      pdfWorker.postMessage({ cmd: 'settexlivemanifest', files: manifest.files });
      setStatus('ready');
    } catch (e) {
      checkGeneration(expected);
      abort.abort();
      setStatus('error');
      loadPromise = null;
      try { texWorker && texWorker.terminate(); } catch (e2) { /* noop */ }
      try { pdfWorker && pdfWorker.terminate(); } catch (e2) { /* noop */ }
      texWorker = pdfWorker = null;
      resourcesWarmed = false;
      throw e;
    }
  })();
  return loadPromise;
}

// 调一次命令并等待特定回执（协议见胶水 onmessage）
// 所有等待（包括初始化）共享取消和清理机制。
const inFlight = new Set();
function call(w, label, send, match, timeoutMs) {
  const reqId = nextReqId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(label + ' timeout'));
      // 超时说明 Worker 很可能卡在 wasm 死循环里。只 reject 不销毁的话，它会把
      // 后续 writeproject/compile 永远堵在命令队列里，用户每点一次都要再等满超时。
      if (w === texWorker || w === pdfWorker) {
        try { cancelCompile(); } catch (e) { /* 取消流程失败不掩盖超时 */ }
      }
    }, timeoutMs || COMPILE_TIMEOUT);
    function onmsg(ev) {
      const d = ev.data || {};
      // Worker 回带 reqId 时只认自己这条：上一趟超时后的迟到回执不能喂给这一条命令。
      // 缓存里的旧 Worker 脚本不带 reqId，那种情况退回原来的 cmd 匹配。
      if (d.reqId !== undefined && d.reqId !== reqId) return;
      if (!match(d)) return;
      cleanup();
      resolve(d);
    }
    function onerr(e) { cleanup(); reject(new Error(label + ' crashed: ' + (e.message || 'worker error'))); }
    function cancel() { cleanup(); reject(new Error('cancelled')); }
    function cleanup() { clearTimeout(timer); inFlight.delete(cancel); w.removeEventListener('message', onmsg); w.removeEventListener('error', onerr); }
    inFlight.add(cancel);
    w.addEventListener('message', onmsg);
    w.addEventListener('error', onerr);
    try { send(reqId); } catch (e) { cleanup(); reject(e); }
  });
}

/** 取消进行中的编译/预热：拒绝所有在途调用并销毁 Worker，下次编译重新装载（资源走 HTTP 缓存，秒级） */
export function cancelCompile() {
  generation++;
  loadAbort?.abort();
  loadAbort = null;
  [...inFlight].forEach(cancel => cancel());
  // 在途调用已被拒绝，排队者却可能还挂在锁上；强制放行后它们各自撞上 generation 检查退出
  [...workerLockReleases].forEach(release => release());
  workerLockReleases.clear();
  workerLockTail = Promise.resolve();
  compileGuard = null;
  try { texWorker && texWorker.terminate(); } catch (e) { /* noop */ }
  try { pdfWorker && pdfWorker.terminate(); } catch (e) { /* noop */ }
  texWorker = pdfWorker = null;
  loadPromise = null;
  warmPromise = null;
  pendingWarmSource = null;
  warming = false;
  resourcesWarmed = false;
  setStatus('idle');
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

// 用户取消不算报错：单独标记，让 UI 说「已取消」而不是甩一条红色异常
function cancelled(e) {
  return String(e && e.message || e) === 'cancelled'
    ? { ok: false, cancelled: true, log: '', errors: [], engine: 'builtin' } : null;
}

/**
 * 编译 LaTeX 源码。返回 { ok, pdfBytes?, log, errors, engine:'builtin' }
 * 引擎已被上一趟编译占住时返回 { ok:false, cancelled:false, error:'busy' }：
 * 正常 UI 走不到（useCompile 有 compiling 守卫），出现即为调用方逻辑错误。
 */
export async function compileXeLaTeX(source, files = []) {
  if (compileGuard) return { ok: false, cancelled: false, error: 'busy', log: '', errors: [], engine: 'builtin' };
  const guard = {};
  const expected = generation;
  compileGuard = guard;
  try {
    // 装载不占锁：它只建 Worker 与设端点，且和预热共用同一个 loadPromise，
    // 放到锁后面会让 Worker 的创建时机变成微任务，取消/替换的竞态就变了
    try {
      await preloadEngine();
      checkGeneration(expected);
    } catch (e) {
      const c = cancelled(e);
      if (c) return c;
      return compileError(e.message || String(e));
    }
    // 定向预热可能正占着两个 Worker：排队等它跑完，否则会错拿它的回执
    return await withWorkerLock(() => runCompile(source, files, expected));
  } finally {
    if (compileGuard === guard) compileGuard = null;
  }
}

function compileError(message) {
  return { ok: false, log: '', errors: [{ line: null, msg: message }], engine: 'builtin' };
}

async function runCompile(source, files, expected) {
  try {
    // 排队等锁期间可能已被取消：此时 Worker 已销毁，一条命令都不能再发
    checkGeneration(expected);
    setStatus('busy');
    source = prepareXeLaTeXSource(source);
    ({ source, files } = await prepareCompileGraphics(source, files));
    checkGeneration(expected);
    // 两遍编译：目录/交叉引用（与 server.mjs 行为一致）
    texWorker.postMessage({ cmd: 'flushcache' });
    pdfWorker.postMessage({ cmd: 'flushcache' });
    // XeTeX needs figure dimensions; dvipdfmx needs the original PDF/image bytes.
    for (const worker of [texWorker, pdfWorker]) {
      const uploaded = await call(worker, 'Project upload',
        reqId => worker.postMessage({ cmd: 'writeproject', files, reqId }), d => d.cmd === 'writeproject');
      checkGeneration(expected);
      if (uploaded.result !== 'ok') throw new Error(uploaded.error || 'Project upload failed');
    }
    texWorker.postMessage({ cmd: 'writefile', url: 'main.tex', src: source });
    texWorker.postMessage({ cmd: 'setmainfile', url: 'main.tex' });
    let r1;
    try {
      r1 = await call(texWorker, 'XeTeX pass 1',
        reqId => texWorker.postMessage({ cmd: 'compilelatex', reqId }), d => d.cmd === 'compile');
      checkGeneration(expected);
    } catch (e) {
      return cancelled(e) || compileError(e.message || String(e));
    }
    if (r1.result !== 'ok' || r1.status !== 0) {
      const log = r1.log || '';
      return { ok: false, log, errors: parseLog(log), engine: 'builtin' };
    }
    let r2 = r1;
    try {
      r2 = await call(texWorker, 'XeTeX pass 2',
        reqId => texWorker.postMessage({ cmd: 'compilelatex', reqId }), d => d.cmd === 'compile');
      checkGeneration(expected);
    } catch (e) {
      const c = cancelled(e);
      if (c) return c;
      /* 第二遍失败不致命：沿用第一遍产物 */
    }
    if (r2.result !== 'ok' || r2.status !== 0) {
      const log = r2.log || r1.log || '';
      return { ok: false, log, errors: parseLog(log), engine: 'builtin' };
    }
    // BibTeX writes the bibliography after a TeX pass. A third pass resolves
    // citation labels read from the bibliography on pass two. Test the
    // comment-stripped source: a commented-out \bibliography must not buy a
    // wasted third pass (seconds of worker time).
    if (/\\bibliography\s*\{/.test(stripTexComments(source))) {
      try {
        r2 = await call(texWorker, 'XeTeX pass 3',
          reqId => texWorker.postMessage({ cmd: 'compilelatex', reqId }), d => d.cmd === 'compile');
        checkGeneration(expected);
      } catch (error) {
        return cancelled(error) || { ok: false, log: r2.log || '',
          errors: [{ line: null, msg: error.message || String(error) }], engine: 'builtin' };
      }
      if (r2.result !== 'ok' || r2.status !== 0) {
        const log = r2.log || '';
        return { ok: false, log, errors: parseLog(log), engine: 'builtin' };
      }
    }
    const xdv = new Uint8Array(r2.pdf);

    pdfWorker.postMessage({ cmd: 'writefile', url: 'main.xdv', src: xdv });
    pdfWorker.postMessage({ cmd: 'setmainfile', url: 'main.xdv' });
    let r3;
    try {
      r3 = await call(pdfWorker, 'dvipdfmx',
        reqId => pdfWorker.postMessage({ cmd: 'compilepdf', reqId }), d => d.cmd === 'compile');
      checkGeneration(expected);
    } catch (e) {
      const c = cancelled(e);
      if (c) return c;
      return compileError('dvipdfmx: ' + (e.message || String(e)));
    }
    if (r3.result !== 'ok' || !r3.pdf) {
      const log = r3.log || '';
      return { ok: false, log, errors: parseLog(log).concat([{ line: null, msg: 'dvipdfmx failed' }]), engine: 'builtin' };
    }
    return { ok: true, pdfBytes: new Uint8Array(r3.pdf), log: r2.log || '', errors: [], engine: 'builtin' };
  } catch (e) {
    const c = cancelled(e);
    if (c) return c;
    throw e;
  } finally {
    if (generation === expected) setStatus(loadPromise ? (warming ? 'warming' : 'ready') : 'idle');
  }
}

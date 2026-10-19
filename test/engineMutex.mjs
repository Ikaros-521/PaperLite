// 引擎级互斥与迟到回执：mock Worker，跑 src/engines/xelatex.js 的真实编排逻辑。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const tick = () => new Promise(resolve => setImmediate(resolve));
const XDV = new Uint8Array([1, 2, 3, 4]).buffer;
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]).buffer; // %PDF-
const DOC = '\\documentclass{article}\\begin{document}hi\\end{document}';

// echoReqId=false 模拟缓存里的旧 Worker 脚本（不回带 reqId）；
// autoReply=false 时回执进队列，由测试逐条放行，用来把编译停在指定命令上。
function harness({ echoReqId = true, autoReply = true } = {}) {
  const workers = [], timers = new Map(), held = [];
  let timerId = 0;

  class MockWorker {
    listeners = new Map();
    messages = [];
    terminated = false;
    constructor(url) {
      this.url = url;
      workers.push(this);
      this.reply({ result: 'ok' }); // 胶水 wasm postRun 里的装载完成通知
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    emit(data) { for (const fn of [...(this.listeners.get('message') || [])]) fn({ data }); }
    postMessage(data) {
      assert.equal(this.terminated, false, 'Never send work to a terminated worker');
      this.messages.push(data);
      switch (data.cmd) {
        case 'writeproject': this.reply({ cmd: data.cmd, result: 'ok' }, data.reqId); break;
        case 'gettexlivecache': this.reply({ cmd: data.cmd, files: [] }, data.reqId); break;
        case 'cachetexlivefile': this.reply({ cmd: data.cmd, key: data.key, result: 'ok' }, data.reqId); break;
        case 'compilelatex': this.reply({ cmd: 'compile', result: 'ok', status: 0, log: 'xelatex log', pdf: XDV }, data.reqId); break;
        case 'compilepdf': this.reply({ cmd: 'compile', result: 'ok', status: 0, log: 'dvipdfmx log', pdf: PDF }, data.reqId); break;
        default: break; // flushcache / writefile / setmainfile / settexlive* 无回执
      }
    }
    reply(message, reqId) {
      const payload = echoReqId && message.cmd !== undefined && typeof reqId === 'number'
        ? Object.assign({}, message, { reqId }) : message;
      if (autoReply) queueMicrotask(() => { if (!this.terminated) this.emit(payload); });
      else held.push({ worker: this, payload });
    }
    terminate() { this.terminated = true; }
  }

  const code = readFileSync(new URL('../src/engines/xelatex.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/export /g, '')
    .replace(/import.meta.env/g, '({})');
  const engine = vm.runInNewContext(
    code + '\n({ compileXeLaTeX, warmEngine, cancelCompile, preloadEngine, engineStatus, onEngineStatus })', {
      document: { baseURI: 'https://paperlite.test/' }, URL, Worker: MockWorker, AbortController,
      setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; },
      clearTimeout: id => timers.delete(id),
      prepareXeLaTeXSource: text => text,
      prepareCompileGraphics: async (source, files) => ({ source, files }),
      fetch: async url => {
        if (String(url).endsWith('manifest.json')) return { ok: true, json: async () => ({ version: 1, files: [] }) };
        // 没有预热清单时引擎只预取格式文件，走不到断言路径
        if (String(url).endsWith('warm.json')) return { ok: false, json: async () => null };
        return { ok: true, headers: { get: () => 'application/octet-stream' }, arrayBuffer: async () => new ArrayBuffer(8) };
      },
    });

  const deliver = (count = 1) => {
    for (const { worker, payload } of held.splice(0, count)) if (!worker.terminated) worker.emit(payload);
  };
  const drain = async () => {
    for (let round = 0; round < 30 && held.length; round++) { deliver(held.length); await tick(); }
  };
  // 一条一条放行回执直到条件成立；条件一直不成立则由断言失败暴露卡死
  const stepUntil = async predicate => {
    for (let i = 0; i < 60 && !predicate(); i++) { if (held.length) deliver(1); await tick(); }
    assert.ok(predicate(), 'Engine never reached the expected state');
  };
  const clean = () => {
    assert.equal(timers.size, 0, 'Every settled wait clears its timer');
    for (const w of workers) for (const list of w.listeners.values()) {
      assert.equal(list.size, 0, 'Every settled wait removes its worker listener');
    }
  };
  return { ...engine, workers, held, deliver, drain, stepUntil, clean };
}

const messages = worker => worker?.messages || [];
const flushCount = worker => messages(worker).filter(m => m.cmd === 'flushcache').length;
const passCount = worker => messages(worker).filter(m => m.cmd === 'compilelatex').length;

// 同一 tick 内两次调用：React 的 compiling 是渲染期闭包值，两边都读到 false，
// 引擎必须自己拒绝第二趟，否则两次编译在同一个 compile 回执上双双 resolve。
let engine = harness();
let first = engine.compileXeLaTeX(DOC);
// 断言只比字段：引擎在 vm 里跑，返回对象的原型与本 realm 的 Object.prototype 不同名
let second = await engine.compileXeLaTeX(DOC);
assert.equal(second.ok, false);
assert.equal(second.cancelled, false, 'Busy is a programming error, not a user cancellation');
assert.equal(second.error, 'busy');
assert.equal(second.log, '');
assert.equal(second.errors.length, 0);
assert.equal(second.engine, 'builtin');
assert.equal(engine.workers.length, 2, 'Rejected compile sends no work');
let result = await first;
assert.equal(result.ok, true, JSON.stringify(result.errors));
assert.equal(Buffer.from(result.pdfBytes).subarray(0, 5).toString(), '%PDF-');
assert.equal(passCount(engine.workers[0]), 2, 'Both XeTeX passes ran');
// 锁在成功出口释放：下一趟照常编译
assert.equal((await engine.compileXeLaTeX(DOC)).ok, true, 'Lock is released on success');
engine.clean();

// 超时后的迟到回执不能喂给下一条命令：reqId 对不上号就丢弃，继续等自己这条。
engine = harness({ autoReply: false });
let running = engine.compileXeLaTeX(DOC);
await engine.stepUntil(() => passCount(engine.workers[0]) === 1);
const tex = engine.workers[0];
const pendingReqId = tex.messages.filter(m => m.cmd === 'compilelatex')[0].reqId;
assert.equal(typeof pendingReqId, 'number', 'Each command carries its request id');
tex.emit({ cmd: 'compile', result: 'ok', status: 0, log: 'stale', pdf: XDV, reqId: pendingReqId + 1000 });
let raced = await Promise.race([running.then(() => 'settled'), tick().then(() => 'pending')]);
assert.equal(raced, 'pending', 'A reply for another request cannot end the compile');
engine.deliver(); // pass 1 的正确回执
await engine.stepUntil(() => passCount(tex) === 2);
assert.notEqual(tex.messages.filter(m => m.cmd === 'compilelatex')[1].reqId, pendingReqId,
  'Each request gets a fresh id');
await engine.stepUntil(() => engine.workers[1].messages.some(m => m.cmd === 'compilepdf'));
await engine.drain();
assert.equal((await running).ok, true, 'Compile still completes after discarding the stale reply');
engine.clean();

// 旧 Worker 脚本不回带 reqId 时退回 cmd 匹配，编译照常。
engine = harness({ echoReqId: false });
assert.equal((await engine.compileXeLaTeX(DOC)).ok, true, 'Workers without reqId echo still compile');
engine.clean();

// 取消即归还锁：取消后立刻重编不该看到 busy。
engine = harness({ autoReply: false });
running = engine.compileXeLaTeX(DOC);
await engine.stepUntil(() => passCount(engine.workers[0]) === 1);
engine.cancelCompile();
assert.equal((await running).cancelled, true, 'Cancelled compile reports cancellation, not failure');
assert.equal(engine.engineStatus(), 'idle');
running = engine.compileXeLaTeX(DOC);
await tick();
assert.equal(engine.workers.length, 4, 'Compile after cancellation starts a reload instead of being refused');
await engine.drain();
assert.equal((await running).ok, true, 'Lock survives a cancel/reload cycle');
engine.clean();

// 正式编译进行中，切文档触发的预热不能把 flushcache 打进它的命令序列（两阶段共用的窄窗）。
engine = harness({ autoReply: false });
running = engine.compileXeLaTeX(DOC);
await engine.stepUntil(() => passCount(engine.workers[0]) === 1);
const flushing = flushCount(engine.workers[0]);
assert.equal(engine.engineStatus(), 'busy');
const warming = engine.warmEngine(DOC);
for (let i = 0; i < 8; i++) await tick();
assert.equal(flushCount(engine.workers[0]), flushing, 'Warm-up queues on the lock, never interrupts a compile');
assert.equal(engine.engineStatus(), 'busy', 'A queued warm-up must not relabel a running compile');
assert.equal(passCount(engine.workers[0]), 1);
await engine.drain();
assert.equal((await running).ok, true, 'Foreground compile wins against a queued warm-up');
await warming;
assert.ok(flushCount(engine.workers[0]) > flushing, 'Warm-up runs once the compile releases the lock');
assert.ok(messages(engine.workers[1]).some(m => m.cmd === 'compilepdf'),
  'Queued warm-up still reaches the PDF Worker, so the lock cannot starve it');
assert.equal(engine.engineStatus(), 'ready', 'Warm-up leaves the engine usable');
engine.cancelCompile();
engine.clean();

console.log('Engine mutex: re-entrancy rejected, stale replies dropped, lock released on success/cancel, warm-up serialized behind compiles.');

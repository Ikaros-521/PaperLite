/* AI 修复队列测试：停止要贯穿退避等待——睡醒后不得再多调一次 invoke；
 * 顺带钉住正常重试与限速 Retry-After 两条路径 */
import assert from 'node:assert/strict';
import { runFixQueue, backoffDelay } from '../src/workspace/aiFixQueue.js';

function abortSignal() {
  const listeners = new Set();
  return {
    aborted: false,
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
    abort() { this.aborted = true; for (const fn of [...listeners]) fn(); },
  };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1. 退避期间点停止：invoke 只被调用一次，状态收在 cancelled
{
  const calls = [];
  const signal = abortSignal();
  const updates = [];
  const run = runFixQueue({
    tasks: [{ id: 'a' }],
    invoke: async () => { calls.push('invoke'); throw Object.assign(new Error('boom'), { code: 'server' }); },
    signal,
    maxRetry: 3,
    baseDelay: 50,
    onUpdate: (id, patch) => updates.push(patch.status),
  });
  // 第一次 invoke 失败后进入退避（50ms 起步），在退避窗口内按停止
  await sleep(5);
  assert.equal(calls.length, 1, 'invoke 已执行过一次');
  signal.abort();
  await run;
  assert.equal(calls.length, 1, `退避睡醒后不得再调 invoke（实际 ${calls.length} 次）`);
  assert.equal(updates.at(-1), 'cancelled', '最终状态是 cancelled，而不是闪回 fixing');
}

// 2. 退避自然睡醒（未停止）：照常重试到成功
{
  let n = 0;
  const results = await runFixQueue({
    tasks: [{ id: 'b' }],
    invoke: async () => { if (++n < 2) throw Object.assign(new Error('flaky'), { code: 'server' }); },
    maxRetry: 2, baseDelay: 10,
  });
  assert.equal(n, 2);
  assert.equal(results.b.status, 'done');
}

// 3. 限速路径尊重 err.retryAfterMs（夹到 MAX 内），仍然可被停止打断
{
  assert.ok(backoffDelay(0, 800) >= 800, '退避基数不打折');
  const signal = abortSignal();
  let calls = 0;
  const run = runFixQueue({
    tasks: [{ id: 'c' }],
    invoke: async () => { calls++; throw Object.assign(new Error('rate'), { code: 'rate', retryAfterMs: 60_000 }); },
    signal, maxRetry: 1, baseDelay: 10,
  });
  await sleep(5);
  signal.abort();
  const results = await run;
  assert.equal(calls, 1, '限速退避中的停止同样立即生效');
  assert.equal(results.c.status, 'cancelled');
}

console.log('aiFixQueue: 停止贯穿退避、正常重试与限速路径通过');

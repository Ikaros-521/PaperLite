// AI 修复串行队列：逐条发送、单条含超时与指数退避重试、429 尊重 Retry-After、取消贯穿全程。
// 与界面解耦——invoke 由调用方注入（负责发起 llm.chat 与流式回填），onUpdate 汇报每条状态。
import { isRetryable } from '../llm.js';

const MAX_BACKOFF_MS = 30_000;

// 第 attempt 次重试（从 0 起）的等待：指数退避 + 轻微抖动，避免同批多请求同时撞限流
export function backoffDelay(attempt, baseMs) {
  const raw = baseMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseMs * 0.25;
  return Math.min(MAX_BACKOFF_MS, Math.round(raw + jitter));
}

// 可被取消打断的等待：退避期间用户点停止要立刻返回，而不是干等满一个 backoff
function sleep(ms, signal) {
  return new Promise(resolve => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', done);
      resolve();
    }
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * @param tasks      [{ id, ...任意上下文 }]，按顺序逐条处理
 * @param invoke     async (task, { signal }) => any；抛错时按 err.code 决定是否重试
 * @param signal     整轮取消信号（AbortSignal）；停止时打断当前请求与退避等待
 * @param maxRetry   单条额外重试次数（0 = 不重试）
 * @param baseDelay  退避基数（ms）
 * @param onUpdate   (id, patch) => void；patch: { status, attempt?, error?, code? }
 * @returns          { [id]: { status, attempt?, error?, code? } }
 */
export async function runFixQueue({
  tasks = [], invoke, signal, maxRetry = 2, baseDelay = 800, onUpdate = () => {}
}) {
  const aborted = () => !!(signal && signal.aborted);
  const results = {};

  for (const task of tasks) {
    const id = task.id;
    if (aborted()) {
      results[id] = { status: 'cancelled' };
      onUpdate(id, results[id]);
      continue;
    }

    let attempt = 0;
    while (true) {
      onUpdate(id, { status: attempt > 0 ? 'retrying' : 'fixing', attempt });
      try {
        results[id] = { status: 'done' };
        await invoke(task, { signal });
        onUpdate(id, results[id]);
        break;
      } catch (err) {
        // 用户取消优先判定：停止按钮打断当前请求，或退避期间被取消
        const cancelled = (err && err.code === 'cancelled') || aborted();
        if (cancelled) {
          results[id] = { status: 'cancelled' };
          onUpdate(id, results[id]);
          break;
        }
        if (isRetryable(err) && attempt < maxRetry) {
          attempt++;
          results[id] = { status: 'retrying', attempt, error: err.message, code: err.code };
          onUpdate(id, results[id]);
          // 限速按服务端建议退避（夹在合理区间），其余走指数退避
          const suggested = err.retryAfterMs;
          const wait = (err.code === 'rate' && suggested > 0)
            ? Math.min(suggested, MAX_BACKOFF_MS)
            : backoffDelay(attempt - 1, baseDelay);
          await sleep(wait, signal);
          // 退避被打断时 sleep 提前返回：直接按取消收尾，不再回到循环顶
          // 多调一次 invoke（那会闪回 fixing 态、对有副作用的实现等于多执行一轮）
          if (aborted()) {
            results[id] = { status: 'cancelled' };
            onUpdate(id, results[id]);
            break;
          }
          continue;
        }
        results[id] = { status: 'failed', error: err.message, code: err.code };
        onUpdate(id, results[id]);
        break;
      }
    }
  }

  return results;
}

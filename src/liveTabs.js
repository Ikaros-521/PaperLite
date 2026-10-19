/* 多窗口「活标签」注册表：哪些 historyKey 仍被某个打开的窗口引用着。
 *
 * localStorage 里的历史库是全窗口共享的，而「清理未打开的历史」只知道本窗口开了哪些
 * 标签——另一个窗口正开着的文件，在它看来就是「未打开」，一键清理会把这个窗口还
 * 在用的版本历史抹掉。storage 事件只能让对方的缓存失效，救不回已经删掉的键。
 * 所以清理前先问这张表：别的窗口心跳还在，它登记的键就不算「未打开」。
 *
 * 纯 localStorage + 无 React 依赖，Node 可直接单测（window 不存在时跳过 pagehide 注册）。
 */
const LS_KEY = 'paperlite.live-tabs.v1';
const TTL_MS = 10 * 60 * 1000;   // 心跳过期阈值：正常心跳 60s 一次，留足休眠/卡顿余量

let winId = null;

function readAll() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const data = raw ? JSON.parse(raw) : null;
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (e) { return {}; }
}

/** 本窗口身份：首次使用时生成，并在 pagehide 时把自己的条目摘掉（崩溃/强关由 TTL 兜底） */
function ensureWin() {
  if (winId) return winId;
  winId = globalThis.crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2));
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', () => {
      try {
        const all = readAll();
        delete all[winId];
        localStorage.setItem(LS_KEY, JSON.stringify(all));
      } catch (e) { /* 摘不掉就等 TTL 过期 */ }
    });
  }
  return winId;
}

/** 心跳：登记本窗口当前引用的 historyKey 集合，顺手清掉过期条目 */
export function noteLiveTabs(keys) {
  try {
    const id = ensureWin();
    const all = readAll();
    const now = Date.now();
    for (const k of Object.keys(all)) {
      const e = all[k];
      if (!e || typeof e !== 'object' || !Array.isArray(e.keys) || !(e.ts > now - TTL_MS)) delete all[k];
    }
    all[id] = { keys: [...new Set((keys || []).filter(k => typeof k === 'string' && k))], ts: now };
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch (e) { /* 注册表写不进：保护退化成仅本窗口，清理功能照常 */ }
}

/** 别的窗口仍活跃引用的键（过期心跳不算数） */
export function foreignLiveKeys() {
  const id = ensureWin();
  const now = Date.now();
  const out = new Set();
  for (const [k, e] of Object.entries(readAll())) {
    if (k === id || !e || typeof e !== 'object' || !Array.isArray(e.keys) || !(e.ts > now - TTL_MS)) continue;
    for (const key of e.keys) out.add(key);
  }
  return out;
}

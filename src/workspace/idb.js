/**
 * IndexedDB 最小封装（对话与任务状态的落库底座）。
 *
 * 为什么不用 localStorage：任务状态含执行审计（每步的工具调用与结果长度），对话记录
 * 含整段正文——localStorage 的 5MB 共享配额会被版本历史与草稿一起挤爆，而且它同步、
 * 整串读写，写一份大对象会直接卡住主线程。IndexedDB 是异步的、按记录存的。
 *
 * 这一层刻意只做四件事：开库、 put 、 get 、按索引扫描/删除。业务形状（裁剪、上限、
 * 案例）在 taskStore.js，那里要能在 Node 里用内存驱动测。
 */
export const DB_NAME = 'paperlite';
export const DB_VERSION = 1;
export const STORES = ['chats', 'tasks', 'cases'];

/** 建库：每个 store 都带一个 updatedAt 索引，用于「按时间倒序取前 N 条」与清理 */
export function openDb(indexedDB) {
  return new Promise((resolve) => {
    if (!indexedDB || typeof indexedDB.open !== 'function') { resolve(null); return; }
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (db.objectStoreNames.contains(name)) continue;
        const st = db.createObjectStore(name, { keyPath: 'id' });
        st.createIndex('updatedAt', 'updatedAt');
      }
    };
    // 被别的窗口占着、用户拒绝对隐私模式开库……都按「没有持久化」处理，不打断编辑
    req.onerror = () => resolve(null);
    req.onsuccess = () => resolve(req.result);
    req.onblocked = () => resolve(null);
  });
}

function tx(db, store, mode) {
  try { return db.transaction(store, mode).objectStore(store); } catch (e) { return null; }
}

function wrap(req) {
  return new Promise((resolve) => {
    if (!req) { resolve(null); return; }
    req.onsuccess = () => resolve(req.result === undefined ? null : req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

export function makeIdbDriver(db) {
  if (!db) return null;
  return {
    async put(store, value) { const t = tx(db, store, 'readwrite'); return t ? await wrap(t.put(value)) !== null : false; },
    async get(store, id) { const t = tx(db, store, 'readonly'); return wrap(t && t.get(id)); },
    async remove(store, id) { const t = tx(db, store, 'readwrite'); if (!t) return false; await wrap(t.delete(id)); return true; },
    async all(store) { const t = tx(db, store, 'readonly'); return (await wrap(t && t.getAll())) || []; },
    async count(store) { const t = tx(db, store, 'readonly'); const n = await wrap(t && t.count()); return n || 0; },
  };
}

/** 浏览器侧唯一入口；不支持时返回 null，调用方一律按「没有持久化」降级 */
export async function openDriver() {
  const db = await openDb(globalThis.indexedDB);
  return makeIdbDriver(db);
}

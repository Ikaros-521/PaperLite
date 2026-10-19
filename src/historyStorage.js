const HISTORY_KEY = 'paperlite.history.v1';
export const HISTORY_LIMITS = Object.freeze({ perFile: 20, total: 200, characters: 1000000 });
let cachedRaw, cachedStore;
let lastDropped = 0;

function historyStore() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY) || '{}';
    if (raw === cachedRaw && cachedStore) return cachedStore;
    const parsed = JSON.parse(raw);
    const data = Object.create(null);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, entries] of Object.entries(parsed)) {
        if (!Array.isArray(entries)) continue;
        const valid = entries.filter(v => v && typeof v.text === 'string' && typeof v.id === 'string' && Number.isFinite(v.date));
        if (valid.length) data[key] = valid.map(v => ({ id: v.id, date: v.date, text: v.text,
          label: typeof v.label === 'string' ? v.label.slice(0, 100) : '',
          reason: ['auto', 'manual', 'save', 'beforeRestore', 'restore'].includes(v.reason) ? v.reason : 'auto' }));
      }
    }
    cachedRaw = raw; cachedStore = data;
    return data;
  } catch { return Object.create(null); }
}

// One sort and a running size estimate replace repeated serialization of the full store.
// Writes, renames and Save As all share the same limits. Protected restore backups survive.
function persistHistory(input, protectedIds = []) {
  const protect = new Set(protectedIds);
  const all = Object.create(null);
  let capped = 0;
  for (const [key, entries] of Object.entries(input)) {
    const sorted = [...entries].sort((a, b) => b.date - a.date);
    const kept = sorted.filter(v => protect.has(v.id));
    for (const v of sorted) {
      if (protect.has(v.id)) continue;
      if (kept.length < HISTORY_LIMITS.perFile) kept.push(v); else capped++;
    }
    if (kept.length) all[key] = kept.sort((a, b) => b.date - a.date);
  }
  let count = Object.values(all).reduce((n, list) => n + list.length, 0);
  let size = JSON.stringify(all).length;
  const candidates = Object.entries(all).flatMap(([key, list]) => list.filter(v => !protect.has(v.id)).map(v => ({ key, v, size: JSON.stringify(v).length })));
  candidates.sort((a, b) => a.v.date - b.v.date);
  const dropped = new Set();
  let index = 0;
  while (count > HISTORY_LIMITS.total || size > HISTORY_LIMITS.characters) {
    const next = candidates[index++];
    if (!next) return false;
    dropped.add(next.v); count--; size -= next.size;
  }
  const materialize = () => {
    for (const key of Object.keys(all)) {
      all[key] = all[key].filter(v => !dropped.has(v));
      if (!all[key].length) delete all[key];
    }
    return JSON.stringify(all);
  };
  const write = raw => {
    localStorage.setItem(HISTORY_KEY, raw);
    cachedRaw = raw; cachedStore = all;
    lastDropped = dropped.size + capped;
  };
  try { write(materialize()); return true; }
  catch {
    if (!protectedIds.length) return false;
    // Browser quota is shared with other features. The old retry dropped *every*
    // unprotected version in the store, so renaming one label (protects 1 id) could
    // wipe every other file's history and still report ok:true. Drop oldest-first,
    // one at a time, and keep whatever the quota can still hold.
    for (const { v } of candidates) {
      if (protect.has(v.id)) continue;
      dropped.add(v);
      try { write(materialize()); return true; } catch { /* 还塞不下就再丢一条最旧的 */ }
    }
    return false;
  }
}

export function readHistory(key) { return historyStore()[key] || []; }
export function historyUsage(key) {
  const all = historyStore();
  return { bytes: (cachedRaw || '{}').length * 2, maxBytes: HISTORY_LIMITS.characters * 2,
    versions: Object.values(all).reduce((n, list) => n + list.length, 0),
    files: Object.keys(all).length, fileVersions: (all[key] || []).length };
}
export function recordVersion(key, text, { label = '', reason = 'auto', force = false, protectIds = [] } = {}) {
  lastDropped = 0;
  if (typeof text !== 'string' || text.length > HISTORY_LIMITS.characters) return { ok: false };
  const store = historyStore(), entries = store[key] || [];
  if (!force && !label.trim() && entries[0]?.text === text) {
    const lists = Object.values(store);
    const oversized = (cachedRaw || '').length > HISTORY_LIMITS.characters || lists.some(list => list.length > HISTORY_LIMITS.perFile) || lists.reduce((n, list) => n + list.length, 0) > HISTORY_LIMITS.total;
    const ok = oversized ? persistHistory(store, [entries[0].id, ...protectIds]) : true;
    return { ok, version: entries[0], dropped: lastDropped };
  }
  const version = { id: Date.now() + '-' + Math.random().toString(36).slice(2), date: Date.now(), text, label: label.trim().slice(0, 100), reason };
  const ok = persistHistory({ ...store, [key]: [version, ...entries] }, [version.id, ...protectIds]);
  return { ok, version, dropped: lastDropped };
}
export function renameVersion(key, id, label) {
  const all = historyStore();
  if (!all[key]?.some(v => v.id === id)) return false;
  return persistHistory({ ...all, [key]: all[key].map(v => v.id === id ? { ...v, label: label.trim().slice(0, 100) } : v) }, [id]);
}
// move=true 用于「迁移」（草稿转存为文件、磁盘改名换路径）：源键不再被任何标签引用，留下就是纯占共享配额
export function copyHistory(from, to, { move = false } = {}) {
  if (from === to) return true;
  const all = historyStore();
  const combined = [...(all[from] || []), ...(all[to] || [])];
  const versions = [...new Map(combined.map(v => [v.id, v])).values()].sort((a, b) => b.date - a.date);
  const next = { ...all, [to]: versions };
  if (move) delete next[from];
  return persistHistory(next, versions[0] ? [versions[0].id] : []);
}
// 没有任何打开标签引用的键（改名/转存留下的、旧版共用的、形状坏掉的）在面板里看不见，
// 却照样吃共享配额。keep 传当前全部标签的 historyKey。
function staleEntries(keep) {
  return Object.entries(historyStore()).filter(([key]) => !keep.has(key));
}
export function unusedHistory(keepKeys) {
  const stale = staleEntries(new Set(keepKeys));
  return { keys: stale.length, versions: stale.reduce((n, [, list]) => n + list.length, 0),
    bytes: JSON.stringify(Object.fromEntries(stale)).length * 2 };
}
export function pruneHistory(keepKeys) {
  const keep = new Set(keepKeys);
  const stale = staleEntries(keep);
  const versions = stale.reduce((n, [, list]) => n + list.length, 0);
  const next = Object.create(null);
  for (const [key, list] of Object.entries(historyStore())) if (keep.has(key)) next[key] = list;
  return { ok: persistHistory(next), keys: stale.length, versions };
}
export function deleteHistory(key, id) {
  const all = historyStore();
  if (!all[key]?.some(v => v.id === id)) return false;
  return persistHistory({ ...all, [key]: all[key].filter(v => v.id !== id) });
}
export function clearHistory(key) {
  const all = { ...historyStore() };
  if (key !== undefined) delete all[key];
  return persistHistory(key === undefined ? {} : all);
}

// 跨标签页：另一窗口写入历史时本页缓存立即失效。否则两个窗口各自持有旧快照，
// 后写的一方会用 read-modify-write 整体覆盖、静默抹掉对方刚记的版本
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', e => {
    if (!e.key || e.key === HISTORY_KEY) { cachedRaw = undefined; cachedStore = undefined; }
  });
}

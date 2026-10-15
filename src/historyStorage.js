const HISTORY_KEY = 'paperlite.history.v1';
export const HISTORY_LIMITS = Object.freeze({ perFile: 20, total: 200, characters: 1000000 });
let cachedRaw, cachedStore;

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
  for (const [key, entries] of Object.entries(input)) {
    const sorted = [...entries].sort((a, b) => b.date - a.date);
    const kept = sorted.filter(v => protect.has(v.id));
    for (const v of sorted) if (!protect.has(v.id) && kept.length < HISTORY_LIMITS.perFile) kept.push(v);
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
  };
  try { write(materialize()); return true; }
  catch {
    if (!protectedIds.length) return false;
    // Browser quota is shared with other features: try once more with only the
    // protected new version/backup. Failure leaves persisted history unchanged.
    for (const { v } of candidates) dropped.add(v);
    try { write(materialize()); return true; } catch { return false; }
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
  if (typeof text !== 'string' || text.length > HISTORY_LIMITS.characters) return { ok: false };
  const store = historyStore(), entries = store[key] || [];
  if (!force && !label.trim() && entries[0]?.text === text) {
    const lists = Object.values(store);
    const oversized = (cachedRaw || '').length > HISTORY_LIMITS.characters || lists.some(list => list.length > HISTORY_LIMITS.perFile) || lists.reduce((n, list) => n + list.length, 0) > HISTORY_LIMITS.total;
    return { ok: oversized ? persistHistory(store, [entries[0].id, ...protectIds]) : true, version: entries[0] };
  }
  const version = { id: Date.now() + '-' + Math.random().toString(36).slice(2), date: Date.now(), text, label: label.trim().slice(0, 100), reason };
  return { ok: persistHistory({ ...store, [key]: [version, ...entries] }, [version.id, ...protectIds]), version };
}
export function renameVersion(key, id, label) {
  const all = historyStore();
  if (!all[key]?.some(v => v.id === id)) return false;
  return persistHistory({ ...all, [key]: all[key].map(v => v.id === id ? { ...v, label: label.trim().slice(0, 100) } : v) }, [id]);
}
export function copyHistory(from, to) {
  if (from === to) return true;
  const all = historyStore();
  const combined = [...(all[from] || []), ...(all[to] || [])];
  const versions = [...new Map(combined.map(v => [v.id, v])).values()].sort((a, b) => b.date - a.date);
  return persistHistory({ ...all, [to]: versions }, versions[0] ? [versions[0].id] : []);
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

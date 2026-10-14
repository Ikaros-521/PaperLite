import { downloadFile } from './exporter.js';

export function validName(name) {
  return !!name && name !== '.' && name !== '..' && !/[\\/:*?"<>|\u0000-\u001f]/.test(name) && !/[. ]$/.test(name);
}

export function wordCount(text) {
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const words = (text.replace(/[\u3400-\u9fff]/g, ' ').match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || []).length;
  return { cjk, words, total: cjk + words, characters: [...text.replace(/\s/g, '')].length };
}

const HISTORY_KEY = 'paperlite.history.v1';
function historyStore() {
  try {
    const data = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return Object.fromEntries(Object.entries(data).filter(([, entries]) => Array.isArray(entries)).map(([key, entries]) => [key, entries.filter(v => v && typeof v.text === 'string' && typeof v.id === 'string' && Number.isFinite(v.date))]));
  } catch { return {}; }
}
export function readHistory(key) { return historyStore()[key] || []; }
export function recordVersion(key, text) {
  try {
    const all = historyStore();
    const entries = all[key] || [];
    if (entries[0]?.text === text) return;
    all[key] = [{ id: Date.now() + '-' + Math.random().toString(36).slice(2), date: Date.now(), text }, ...entries].slice(0, 20);
    // Bound browser storage across documents, retaining the newest versions first.
    while (JSON.stringify(all).length > 1000000) {
      const oldest = Object.keys(all).filter(k => all[k].length).sort((a, b) => all[a].at(-1).date - all[b].at(-1).date)[0];
      if (!oldest) break;
      all[oldest].pop();
      if (!all[oldest].length) delete all[oldest];
    }
    localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
  } catch { /* Editing and saving remain available when browser storage is full. */ }
}

// ZIP with stored entries: no compression dependency; preserves binary assets and UTF-8 paths.
export function sourceZip(entries) {
  const encoder = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  const names = new Set();
  for (const { name, bytes } of entries) {
    if (names.has(name)) throw new Error('Duplicate archive path: ' + name);
    names.add(name);
    const filename = encoder.encode(name);
    const data = typeof bytes === 'string' ? encoder.encode(bytes) : new Uint8Array(bytes);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = new Uint8Array(30), h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true);
    h.setUint16(12, 33, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, filename.length, true);
    chunks.push(header, filename, data);
    const directory = new Uint8Array(46), d = new DataView(directory.buffer);
    d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(8, 0x800, true); d.setUint16(14, 33, true);
    d.setUint32(16, crc, true); d.setUint32(20, data.length, true); d.setUint32(24, data.length, true); d.setUint16(28, filename.length, true); d.setUint32(42, offset, true);
    central.push(directory, filename);
    offset += header.length + filename.length + data.length;
  }
  const length = central.reduce((n, chunk) => n + chunk.length, 0);
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true); e.setUint32(12, length, true); e.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end], { type: 'application/zip' });
}
export function downloadSourceZip(name, entries) { downloadFile(name + '.zip', sourceZip(entries)); }

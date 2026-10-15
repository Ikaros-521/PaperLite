import { downloadFile } from './exporter.js';

export function validName(name) {
  return !!name && name !== '.' && name !== '..' && !/[\\/:*?"<>|\u0000-\u001f]/.test(name) && !/[. ]$/.test(name);
}

export function wordCount(text) {
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const words = (text.replace(/[\u3400-\u9fff]/g, ' ').match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || []).length;
  return { cjk, words, total: cjk + words, characters: [...text.replace(/\s/g, '')].length };
}

export { readHistory, recordVersion, renameVersion, copyHistory, deleteHistory, clearHistory, historyUsage } from './historyStorage.js';

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

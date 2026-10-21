import { downloadFile } from './exporter.js';

// Windows 保留设备名：带不带扩展名都算（con.tex 照样落到 CON 这个设备对象上），
// 不看大小写。旧校验放行后 createFile 会「成功」，UI 报已创建/已保存，
// 内容却读不回一个普通文件——用户以为存了，其实没有。
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function validName(name) {
  return !!name && name !== '.' && name !== '..' && !/[\\/:*?"<>|\u0000-\u001f]/.test(name) && !/[. ]$/.test(name)
    && !WIN_RESERVED.test(name);
}

/**
 * 模型/工具递过来的路径按段校验，返回 { path } 或 { code }。
 *
 * 为什么要单独成函数：Agent 建文件那条路自己内联写了一份检查，只挡了非法字符与点开头，
 * 于是 `NUL.tex`、`con.tex`、结尾点号这类名字从这条路上过去了——同一类问题在 c332f44
 * 已经给 UI 路径堵过。判据只留一份（validName），两条路径不可能再各写各的漂移。
 *
 * 顺序：先 validName 再隐藏路径。`..`/`.` 本身就被 validName 判成坏名字；而 `.latexmkrc`
 * 是合法名字、只是不该由模型写，落 hidden_path 那条更准确的文案上。
 */
export function agentPathCheck(path) {
  const segs = String(path || '').replace(/\/+/g, '/').split('/').filter(Boolean);
  if (!segs.length) return { code: 'bad_name' };
  if (segs.some(s => !validName(s))) return { code: 'bad_name' };
  if (segs.some(s => s.startsWith('.'))) return { code: 'hidden_path' };
  return { path: segs.join('/') };
}

export function wordCount(text) {
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const words = (text.replace(/[\u3400-\u9fff]/g, ' ').match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || []).length;
  return { cjk, words, total: cjk + words, characters: [...text.replace(/\s/g, '')].length };
}

export { readHistory, recordVersion, renameVersion, copyHistory, deleteHistory, clearHistory, historyUsage, unusedHistory, pruneHistory } from './historyStorage.js';

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

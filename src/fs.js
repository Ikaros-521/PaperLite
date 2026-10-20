/* PaperLite · 本地文件夹访问（File System Access API）
 * Chrome/Edge 支持；读写权限、目录遍历、增删改、根句柄 IndexedDB 持久化。
 */
import { t } from './i18n.js';

export function supported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

export async function pickDirectory() {
  if (!supported()) throw new Error(t('fs.noSupport'));
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  const perm = await handle.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') throw new Error(t('fs.noPerm'));
  return handle;
}

export async function queryPermission(handle, mode) {
  try { return await handle.queryPermission({ mode: mode || 'readwrite' }); } catch (e) { return 'denied'; }
}
export async function requestPermission(handle, mode) {
  try { return await handle.requestPermission({ mode: mode || 'readwrite' }); } catch (e) { return 'denied'; }
}

const JUNK = new Set(['.git', 'node_modules', 'dist', '.vite', '__pycache__', '.vscode-cache']);

// 列出目录条目（文件夹优先，按名称排序；跳过构建产物/缓存目录）
export async function listDir(dirHandle) {
  const out = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (JUNK.has(name)) continue;
    out.push({ name, kind: handle.kind, handle });
  }
  out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'zh') : a.kind === 'directory' ? -1 : 1));
  return out;
}

export async function readFileText(fileHandle, maxBytes) {
  const file = await fileHandle.getFile();
  if (file.size > (maxBytes || 2 * 1024 * 1024)) throw new Error(t('fs.tooLarge', { size: (file.size / 1048576).toFixed(1) }));
  const text = await file.text();
  if (text.includes('\u0000')) throw new Error(t('fs.binary'));
  return text;
}

/** 磁盘指纹（lastModified + size）：保存前比对它，才知道文件在外部被改过。
 *  拿不到就返回 null——权限掉线或测试夹具没有 getFile，此时不该拦下用户的保存。 */
export async function diskStamp(fileHandle) {
  try {
    const f = await fileHandle.getFile();
    return { m: f.lastModified, s: f.size };
  } catch (e) { return null; }
}

export async function writeFileText(fileHandle, text) {
  const w = await fileHandle.createWritable();
  try {
    await w.write(text);
    await w.close();
  } catch (e) {
    // 写失败（配额满/磁盘错/权限掉）必须 abort：不 abort 会留下交换文件，
    // Chrome 里表现为文件被占住、下次写入更慢
    try { await w.abort(); } catch (e2) { /* abort 本身失败不掩盖原始错误 */ }
    throw e;
  }
}

/** 写二进制（图片/附件）。与 writeFileText 同一套收尾：失败必须 abort 掉 writable，
 *  否则留着交换文件与句柄锁，下一次同名写入更慢甚至直接失败 */
export async function writeBlob(fileHandle, blob) {
  const w = await fileHandle.createWritable();
  try {
    await w.write(blob);
    await w.close();
  } catch (e) {
    try { await w.abort(); } catch (e2) { /* 同上 */ }
    throw e;
  }
}

export async function createFile(dirHandle, name) {
  return dirHandle.getFileHandle(name, { create: true });
}
export async function createDirectory(dirHandle, name) {
  return dirHandle.getDirectoryHandle(name, { create: true });
}
export async function removeEntry(dirHandle, name, recursive) {
  await dirHandle.removeEntry(name, { recursive: !!recursive });
}
// 重命名：Chrome 支持 handle.move(newName)
export function canRename(handle) {
  return typeof handle.move === 'function';
}
/**
 * 重命名，并返回「改名后」的句柄。
 * move 之后旧句柄在 Chrome 里仍指向同一文件，但文件树刷新后按新名字拿到的是另一份包装对象，
 * 而已打开标签的去重与保存都认句柄身份；这里按新名字重新取一次，标签才能和树里的条目对上。
 * 取不到（父目录句柄刚失效、实现不同）就退回旧句柄——盘已经改成功了，不该据此判定改名失败。
 */
export async function renameEntry(handle, newName, parentDir) {
  if (!canRename(handle)) throw new Error(t('fs.noRename'));
  await handle.move(newName);
  if (!parentDir) return handle;
  try {
    return handle.kind === 'directory'
      ? await parentDir.getDirectoryHandle(newName)
      : await parentDir.getFileHandle(newName);
  } catch (e) { return handle; }
}

export function fileBlobUrl(fileHandle) {
  return fileHandle.getFile().then(f => URL.createObjectURL(f));
}

/* ---- 根句柄持久化（IndexedDB）---- */
const DB = 'paperlite-fs';
const STORE = 'handles';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
// 连接复用：每次调用都 open 且从不 close，频繁切换目录会累积打开的 IDB 连接
// （Safari/旧内核有并发 open 上限，超了会 onerror → 根句柄「存不上」）
let dbPromise = null;
function idbOnce() {
  if (!dbPromise) {
    dbPromise = idb().catch(e => { dbPromise = null; throw e; });
  }
  return dbPromise;
}
async function tx(mode, fn) {
  const db = await idbOnce();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function saveRootHandle(handle) {
  try { await tx('readwrite', s => s.put(handle, 'root')); } catch (e) { /* 忽略持久化失败 */ }
}
export async function loadRootHandle() {
  try { return await tx('readonly', s => s.get('root')); } catch (e) { return null; }
}
export async function clearRootHandle() {
  try { await tx('readwrite', s => s.delete('root')); } catch (e) { /* ignore */ }
}

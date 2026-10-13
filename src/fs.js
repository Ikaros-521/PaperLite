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

export async function writeFileText(fileHandle, text) {
  const w = await fileHandle.createWritable();
  await w.write(text);
  await w.close();
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
export async function renameEntry(handle, newName) {
  if (!canRename(handle)) throw new Error(t('fs.noRename'));
  await handle.move(newName);
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
async function tx(mode, fn) {
  const db = await idb();
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

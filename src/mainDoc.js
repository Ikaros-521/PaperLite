/* PaperLite · 主文档（编译入口）解析
 *
 * 多文件项目（\input / \include 拆章）里，编译入口应是带 \documentclass 的主文件，
 * 而不是当前正在编辑的子文件——否则在子文件标签上编译会当成独立文档直接报错。
 *
 * 解析顺序：用户固定（设置里选过）> 当前标签（本身就是主文档）> 打开标签探测
 * > 文件夹扫描。纯逻辑、无 React/DOM 依赖，Node 可直接单测；
 * 持久化走 localStorage，按文件夹名隔离（不同项目各自的设置互不干扰）。
 */

const LS_KEY = 'paperlite.maindoc.v1';

export function loadMainDocSetting() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch (e) { return {}; }
}

/** path 为空/删除键 = 恢复「自动」；存不进去就当没固定过，不报错 */
export function saveMainDocSetting(folderKey, path) {
  const all = loadMainDocSetting();
  if (!path) delete all[folderKey];
  else all[folderKey] = path;
  try { localStorage.setItem(LS_KEY, JSON.stringify(all)); } catch (e) { /* ignore */ }
}

/**
 * 改名同步：pin 存的是 path，是唯一没跟着改名走的存储。
 * 不迁移的话，改名后 pin 静默失效（回退自动检测）；更糟的是旧路径日后被新文件占用时，
 * 编译根会静默切到那个新文件上。文件夹改名要整棵子树换前缀。
 * @returns {boolean} 是否真的改动了（没动就别惊动 React 状态）
 */
export function renameMainDocEntry(from, to) {
  const clean = (p) => String(p || '').replace(/^\.?\//, '').replace(/\/+/g, '/');
  const a = clean(from), b = clean(to);
  if (!a || !b || a === b) return false;
  const all = loadMainDocSetting();
  let changed = false;
  for (const [folderKey, path] of Object.entries(all)) {
    const p = clean(path);
    if (p === a) { all[folderKey] = b; changed = true; }
    else if (p.startsWith(a + '/')) { all[folderKey] = b + p.slice(a.length); changed = true; }
  }
  if (!changed) return false;
  try { localStorage.setItem(LS_KEY, JSON.stringify(all)); } catch (e) { return false; }
  return true;
}

/**
 * 删除同步：文件树里删掉的文件/文件夹可能是 pin 的目标（或整棵包含它）。
 * 不清掉的话旧路径留在 localStorage 里，日后同路径出现新文件时 pin 会静默指过去。
 * @returns {boolean} 是否真的改动了
 */
export function deleteMainDocEntry(path, isDir = false) {
  const clean = (p) => String(p || '').replace(/^\.?\//, '').replace(/\/+/g, '/');
  const a = clean(path);
  if (!a) return false;
  const hit = (p) => p === a || (isDir && p.startsWith(a + '/'));
  const all = loadMainDocSetting();
  let changed = false;
  for (const [folderKey, pinned] of Object.entries(all)) {
    if (hit(clean(pinned))) { delete all[folderKey]; changed = true; }
  }
  if (!changed) return false;
  try { localStorage.setItem(LS_KEY, JSON.stringify(all)); } catch (e) { return false; }
  return true;
}

// 探测前先抹注释，避免示例代码 / 被注释掉的导言区被误判成主文档
import { stripTexComments } from './texComments.js';

export function hasDocumentclass(text) {
  const src = stripTexComments(text);
  return /\\documentclass/.test(src);
}

/**
 * 解析编译入口。
 * @param pinned   用户在设置里固定的 path（相对根目录、统一斜杠；无则 null）
 * @param activePath 当前标签的 path（无文件夹时退化为标签名）
 * @param candidates [{ path, name, source, open, isMain }]
 *   - 打开的 tex 标签：source = 当前编辑内容（未保存的修改也参与编译），open = true
 *   - 磁盘扫描的 .tex：source = 磁盘文本，open = false，isMain = 扫描时探测过 \documentclass
 * 同一 path 同时打开又在磁盘上时，调用方应让 open 版本排在前面（编辑内容优先）。
 * @returns {path, source, open, via} | null；via ∈ pinned|active|open-guess|scan|active-fallback
 */
export function resolveMainDoc({ pinned, activePath, candidates }) {
  const list = (candidates || []).filter(c => c && c.path);
  if (pinned) {
    const hit = list.filter(c => c.path === pinned)[0]
      || list.filter(c => c.name === pinned)[0];
    if (hit) return { path: hit.path, source: hit.source, open: hit.open, via: 'pinned' };
    // 固定的文件被删/改名：退回自动，不把过期设置硬塞给编译
  }
  const active = list.filter(c => c.path === activePath)[0];
  if (active && hasDocumentclass(active.source)) return { path: active.path, source: active.source, open: active.open, via: 'active' };
  // main/paper/root.tex 是常见主文件命名，比「第一个探测到的」更可信
  const guess = list.filter(c => c.open && hasDocumentclass(c.source) && /^(main|paper|root)\.tex$/i.test(c.name))[0]
    || list.filter(c => c.open && hasDocumentclass(c.source))[0];
  if (guess) return { path: guess.path, source: guess.source, open: guess.open, via: 'open-guess' };
  const disk = list.filter(c => !c.open && c.isMain)[0];
  if (disk) return { path: disk.path, source: disk.source, open: false, via: 'scan' };
  // 没找到任何 \documentclass：保持旧行为（编译当前标签），让引擎自己报错
  if (active) return { path: active.path, source: active.source, open: active.open, via: 'active-fallback' };
  return null;
}

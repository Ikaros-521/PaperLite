/**
 * 标签与草稿的数据层（桌面 App.jsx 与移动端 #/m 共用一份）。
 *
 * 抽出来的原因：草稿的落盘形状、historyKey 规则、"脏"的判定都很微妙，
 * 两端各写一份迟早会漂（audit-1 那个 blocker 就是「只存了活动那一篇」造成的）。
 * 这里只放纯数据与 localStorage 读写；React 状态、提示与确认仍归调用方。
 */
import CodeMirror from 'codemirror';
import { samples } from '../engines/samples.js';
import { tr, getLang } from '../i18n.js';

/**
 * 磁盘改名后迁移 historyKey。makeTab 把 [scope, path] 编进 key，路径一变历史就「查无此键」。
 * 只在第二段确实等于旧路径时替换；形状不符（草稿键的第二段是 draftId）返回 null，
 * 让调用方保持原样——宁可少迁一个键，也不能把 A 文件的历史挂到 B 文件上。
 */
export function renameHistoryKey(key, from, to) {
  if (typeof key !== 'string' || !from || !to || from === to) return null;
  let parts;
  try { parts = JSON.parse(key); } catch (e) { return null; }
  if (!Array.isArray(parts) || parts.length !== 2 || parts[1] !== from) return null;
  return JSON.stringify([parts[0], to]);
}

/** 旧版单篇草稿键，仅用于回退读取 */
export const LS_DOC = 'paperlite.doc.v2';
/** 当前多草稿键：[{ id: draftId, name, text }] */
export const LS_DRAFTS = 'paperlite.drafts.v1';

let tabSeq = 0;

/**
 * 造一个标签。doc 是 CodeMirror Doc 实例（不是字符串），
 * 两端都要按这个形状走，否则 EditorPane / 历史 / 保存逻辑全要对齐两套。
 */
export function makeTab({ name, path, kind, handle, parentDir, text, modeSpec, saved, imageUrl, historyScope = '', draftId, updatedAt }) {
  const id = ++tabSeq;
  if (kind === 'draft') draftId ||= globalThis.crypto?.randomUUID?.() || `${Date.now()}-${id}-${Math.random().toString(36).slice(2)}`;
  const tab = {
    id, name, path: path || name, kind, handle: handle || null, parentDir: parentDir || null,
    draftId,
    historyKey: JSON.stringify([kind === 'draft' ? 'draft' : historyScope, kind === 'draft' ? draftId : path || name]),
    saved: saved !== undefined ? saved : (text || ''),
    imageUrl: imageUrl || null,
    // 移动端文稿列表要按「多久没动」排序与展示；桌面忽略这个字段
    updatedAt: typeof updatedAt === 'number' ? updatedAt : Date.now(),
    dirty: false, doc: null
  };
  if (text !== undefined && text !== null) tab.doc = new CodeMirror.Doc(text, modeSpec);
  return tab;
}

/** 启动恢复：优先多草稿键，退回旧单篇键，都没有给示例论文。读取阶段不截断，避免把原始数据写坏 */
export function readDrafts() {
  const nameOf = n => String(n || '').slice(0, 80);
  try {
    const arr = JSON.parse(localStorage.getItem(LS_DRAFTS) || 'null');
    if (Array.isArray(arr)) {
      const list = arr.filter(d => d && typeof d.text === 'string').map(d => ({
        name: nameOf(d.name),
        text: d.text,
        ...(typeof d.id === 'string' && d.id ? { id: d.id } : {}),
        ...(Number.isFinite(d.updated) ? { updated: d.updated } : {}),
      }));
      if (list.length) return list;
    }
  } catch (e) { /* 落盘格式坏了，退回旧键 */ }
  try { const s = localStorage.getItem(LS_DOC); if (s && s.trim()) return [{ name: '', text: s }]; } catch (e) { /* ignore */ }
  return [{ name: '', text: samples.demo }];
}

/** 恢复成可直接 setState 的标签数组 */
export function restoreDraftTabs(lang = getLang()) {
  return readDrafts().map(d => makeTab({
    name: d.name || tr(lang, 'app.draftName'),
    path: tr(lang, 'app.draftPath'),
    kind: 'draft',
    draftId: d.id,
    text: d.text,
    modeSpec: 'stex',
    saved: d.text,
    updatedAt: d.updated,
  }));
}

/** 落盘前的形状 */
export function draftsOf(tabs) {
  return tabs.filter(x => x.kind === 'draft' && x.doc).map(x => ({ id: x.draftId, name: x.name, text: x.doc.getValue(), updated: x.updatedAt || Date.now() }));
}

/** 写失败会抛（配额满/隐私模式），调用方必须把它变成可见提示，静默 catch 等于静默丢稿 */
export function persistDrafts(tabs) {
  localStorage.setItem(LS_DRAFTS, JSON.stringify(draftsOf(tabs)));
}

/** 落盘成功后推进 saved；只动 saved 不动 dirty —— ● 仍表示「没落到磁盘文件」，关标签照旧要确认。
 *  persisted（draftId → 已落盘文本）由调用方在写入 localStorage 的那一刻捕获：
 *  更新器在渲染期才执行，那时重读 doc 可能拿到更新的内容，制造一个
 *  beforeunload 不设防的丢稿窗口。 */
export function markDraftsStored(tabs, persisted) {
  let changed = false;
  const next = tabs.map(x => {
    if (x.kind !== 'draft' || !x.doc) return x;
    const value = persisted && persisted.has(x.draftId) ? persisted.get(x.draftId) : x.doc.getValue();
    if (x.saved === value && x.browserStored && !x.saveError) return x;
    changed = true;
    // 时间戳随内容推进；落盘读的是上一轮数组，最多滞后一个防抖周期（<1s），列表展示可接受
    return { ...x, saved: value, browserStored: true, saveError: '', updatedAt: Date.now() };
  });
  return changed ? next : tabs;
}

/** beforeunload 判据：草稿看内容与已存快照是否一致，文件标签看 dirty */
export function hasUnsavedWork(tabs) {
  return tabs.some(x => x.kind === 'draft' ? x.doc && x.doc.getValue() !== x.saved : x.dirty);
}

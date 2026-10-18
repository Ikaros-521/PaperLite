/* PaperLite · 自定义片段（snippets）存取与校验（纯逻辑，Node 可单测）
 *
 * 片段是用户自己沉淀的 LaTeX/Markdown 结构模板（定理环境、算法框架、信件抬头……），
 * 存 localStorage（键 paperlite.snippets.v1），从「插入 → 我的片段」点选插入光标处，
 * 在「管理片段」对话框里增删改。存储不可用时静默降级：读返回空、写返回 false。
 */

const KEY = 'paperlite.snippets.v1';

// Node（单测）里没有 localStorage：走注入或返回空存储
function defaultStore() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; }
}

/** @returns [{id, name, content}]；解析失败按空处理，不让坏数据炸掉界面 */
export function loadSnippets(storage) {
  const s = storage || defaultStore();
  if (!s) return [];
  try {
    const raw = s.getItem(KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data
      .filter(x => x && typeof x.name === 'string' && typeof x.content === 'string')
      .map(x => ({ id: String(x.id != null ? x.id : nextSnippetId()), name: x.name, content: x.content }));
  } catch (e) { return []; }
}

/** @returns true=落盘成功 */
export function saveSnippets(list, storage) {
  const s = storage || defaultStore();
  if (!s) return false;
  const clean = (Array.isArray(list) ? list : [])
    .filter(x => x && typeof x.name === 'string' && typeof x.content === 'string')
    .map(x => ({ id: String(x.id != null ? x.id : nextSnippetId()), name: x.name, content: x.content }));
  try { s.setItem(KEY, JSON.stringify(clean)); return true; } catch (e) { return false; }
}

export function nextSnippetId() {
  return 'sn' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * 新增/改名校验：名字必填、去首尾空白、与现有片段不重名（排除 excludeId 自己）。
 * @returns {ok: true, name} | {ok: false, error: 'empty'|'duplicate'}
 */
export function validateSnippetName(name, existing, excludeId) {
  const n = String(name || '').trim();
  if (!n) return { ok: false, error: 'empty' };
  const dup = (existing || []).some(s => s && s.id !== excludeId && s.name === n);
  if (dup) return { ok: false, error: 'duplicate' };
  return { ok: true, name: n };
}

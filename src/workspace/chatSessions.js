/**
 * 多会话与消息级操作（纯逻辑，可 Node 直测）。
 *
 * 为什么单独一层：会话「存在哪」是 taskStore/IndexedDB 的事，界面只想要
 * 「给我这批会话、把这一轮删掉、从这里分个支」。把数组运算与淘汰规则抽出来，
 * 才能不靠浏览器就把最容易出现歧义的语义钉死：
 *   - 「删除这一轮」删的是用户提问 + 它后面那段回答与工具回执，不是单条气泡；
 *   - 「编辑重发」= 先删掉这一轮再把原文放回输入框（重发即新分支，不原地改历史）；
 *   - 「分支到新会话」切到该条为止的前缀，标题带上来源，避免一堆同名会话；
 *   - 会话数有上限且**永不淘汰当前会话**——用户正在写的东西不能被自己的历史管理删掉。
 */
import { tr, getLang } from '../i18n.js';

// 每个项目只留最近这些会话：历史管理是「回头找那一句」，不是网盘
export const MAX_SESSIONS = 8;
const TITLE_MAX = 34;

/** 会话标题取第一条真实提问：工具回执也是 role=user，靠 kind 区分掉 */
export function deriveTitle(messages) {
  const L = getLang();
  const first = (messages || []).find(m => m && m.role === 'user' && !m.kind);
  const text = String((first && first.content) || '').replace(/\s+/g, ' ').trim();
  if (!text) return tr(L, 'chat.sessionUntitled');
  return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX) + '…' : text;
}

export function newSession(projectKey, now = Date.now()) {
  return { id: 's' + now.toString(36) + Math.random().toString(36).slice(2, 6), projectKey, title: '', createdAt: now, updatedAt: now, messages: [] };
}

/** 写回用的新对象：标题只在还没定过或第一轮变化时重算，避免用户改名后被覆盖 */
export function touchSession(session, messages, now = Date.now()) {
  const list = messages || [];
  return { ...session, messages: list, title: session.title || deriveTitle(list), updatedAt: now };
}

/**
 * 上限淘汰：按 updatedAt 倒序留 max 条，当前会话强制保留
 * （它可能刚好是最早创建的那条，被自动清掉是最糟糕的体验）。
 * 上限是硬的：把当前会话顶到队首再截断，而不是「max + 当前会话」多存一条。
 */
export function evictSessions(sessions, activeId, max = MAX_SESSIONS) {
  const list = sessions || [];
  if (list.length <= max) return list.slice();
  const sorted = [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const ordered = activeId
    ? [...sorted.filter(s => s.id === activeId), ...sorted.filter(s => s.id !== activeId)]
    : sorted;
  const keep = new Set(ordered.slice(0, Math.max(1, max)).map(s => s.id));
  return list.filter(s => keep.has(s.id));
}

export function sortSessions(sessions) {
  return [...(sessions || [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** 一条消息是不是「一轮的开头」：普通 user 提问 */
export function isTurnStart(m) {
  return !!(m && m.role === 'user' && !m.kind);
}

/** 该条消息所属轮次的范围 [start, end)：user 提问到下一条提问之前 */
export function turnRange(messages, i) {
  const list = messages || [];
  if (i < 0 || i >= list.length) return null;
  if (isTurnStart(list[i])) {
    let end = i + 1;
    while (end < list.length && !isTurnStart(list[end])) end++;
    return { start: i, end };
  }
  // 非提问条（回答 / 工具回执 / 摘要 / 评审）：只算它自己，
  // 往前吞掉整轮会把用户没点的东西一起删了
  return { start: i, end: i + 1 };
}

/** 删除一整轮（提问 + 其回答与回执）；单条回答则只删那条 */
export function dropTurn(messages, i) {
  const r = turnRange(messages, i);
  if (!r) return (messages || []).slice();
  const list = messages || [];
  return [...list.slice(0, r.start), ...list.slice(r.end)];
}

/** 编辑重发的准备：截掉这一轮 + 把原文交回输入框 */
export function editResend(messages, i) {
  const m = (messages || [])[i];
  return { list: dropTurn(messages, i), text: m && m.content ? String(m.content) : '' };
}

/**
 * 重新生成的准备：截掉这一轮（提问 + 回答 + 工具回执），把提问交回上层立即重发。
 * 与「编辑重发」的差别是它不经过输入框，所以要把「这一轮跑没跑过工具」带出来——
 * 重跑 Agent 等于重新执行它写过的盘，不能静默进行。
 * 只服务最后一轮：重发是往对话末尾追加，用在中间那轮等于悄悄把那段挪到最后，
 * 想改历史里的中间一轮该用「编辑重发」或「从这里分支」。
 * 摘要 / 评审 / 回执这类条不是「一次回答」，没有可重发的对象，返回 null。
 */
export function regenerateFrom(messages, i) {
  const list = messages || [];
  const m = list[i];
  if (!m || m.role !== 'assistant' || m.kind) return null;
  let start = -1;
  for (let j = i; j >= 0; j--) if (isTurnStart(list[j])) { start = j; break; }
  if (start < 0) return null;
  if (list.slice(start + 1).some(isTurnStart)) return null;
  const r = turnRange(list, start);
  const turn = list.slice(r.start, r.end);
  return {
    list: [...list.slice(0, r.start), ...list.slice(r.end)],
    question: String(list[r.start].content || ''),
    agent: turn.some(x => x && (x.kind === 'tool-result' || x.tool)),
  };
}

/** 分支：取到该条为止的前缀（含该条） */
export function forkMessages(messages, i) {
  const list = messages || [];
  return list.slice(0, Math.max(0, Math.min(list.length, i + 1)));
}

/** 分支会话的标题：带上来源，免得列表里全是同一个开头 */
export function forkTitle(source) {
  const L = getLang();
  const base = (source && source.title) || deriveTitle(source && source.messages);
  return tr(L, 'chat.sessionFork', { title: base });
}

/** 列表项视图（界面不需要整段消息） */
export function sessionBrief(s) {
  return {
    id: s.id,
    title: s.title || deriveTitle(s.messages),
    updatedAt: s.updatedAt || 0,
    count: (s.messages || []).length,
  };
}

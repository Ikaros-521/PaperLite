/**
 * 多会话状态（App 与移动端共用的单一所有者）。
 *
 * 会话列表是唯一的真相源：当前对话的消息就是「活动会话的 messages」，
 * 不再另存一份 chatMessages——两份状态各写各的正是「切会话丢内容 /
 * 保存了错的会话」这类 bug 的来源。界面拿到的 setMessages 只改活动会话那一条。
 *
 * 落库走 taskStore（IndexedDB），只在停下来 1.2 秒后写一次：流式中途每条增量都
 * 序列化一遍整段历史，代价肉眼可见。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_SESSIONS, newSession, evictSessions, deriveTitle, forkMessages, forkTitle, sessionBrief } from './chatSessions.js';

const POINTER_KEY = 'paperlite.chat.active.v1';
const SAVE_DEBOUNCE_MS = 1200;
// 写库失败的补写次数上限：库里塞不下时不该一直重试，但一次网络/配额抖动值得再来两下
const SAVE_RETRY_MAX = 3;

function readPointer() {
  try { return JSON.parse(localStorage.getItem(POINTER_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function writePointer(projectKey, sessionId) {
  if (!projectKey || !sessionId) return;
  try {
    const all = readPointer();
    if (all[projectKey] === sessionId) return;
    all[projectKey] = sessionId;
    localStorage.setItem(POINTER_KEY, JSON.stringify(all));
  } catch (e) { /* 存不下只是下次回到最新一条会话，不影响本轮对话 */ }
}

export function useChatSessions({ projectKey, persist = true }) {
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState('');
  const activeRef = useRef('');
  const keyRef = useRef(projectKey || '');
  const loadedRef = useRef('');
  const hydratedRef = useRef(false);
  const dirtyRef = useRef(new Set());      // 待落库的会话 id（切会话不能把它清掉）
  const retryRef = useRef(0);               // 连续补写次数
  const [retryTick, setRetryTick] = useState(0);   // 只用来在写失败后重新触发落库 effect
  const sessionsRef = useRef([]);
  sessionsRef.current = sessions;
  keyRef.current = projectKey || '';

  const setActive = (id) => { activeRef.current = id; setActiveId(id); writePointer(keyRef.current, id); };
  const upsert = (list, session) => {
    const i = list.findIndex(s => s.id === session.id);
    if (i < 0) return [session, ...list];
    const next = list.slice();
    next[i] = session;
    return next;
  };

  // 换项目（含首次进入）：读会话 → 升级旧单对话记录 → 一条都没有就开一条新的
  useEffect(() => {
    const key = projectKey || '';
    if (!persist || !key) return undefined;
    if (loadedRef.current === key) return undefined;
    loadedRef.current = key;
    import('./taskStore.js')
      .then(async m => {
        let list = await m.listSessions(key);
        if (!list.length) {
          const legacy = await m.adoptLegacyChat(key);
          if (legacy) list = [legacy];
        }
        if (keyRef.current !== key) { loadedRef.current = ''; return null; }
        if (!list.length) list = [newSession(key)];   // 空会话不写库，等它有了内容再说
        const want = readPointer()[key];
        const active = list.find(s => s.id === want) || list[0];
        setSessions(list);
        setActive(active.id);
        hydratedRef.current = true;
        return active;
      })
      .catch(() => { loadedRef.current = ''; });
    return undefined;
  }, [projectKey, persist]);

  // 落库 + 上限淘汰。用「脏集合」而不是只存当前会话：切会话会清掉上一会话还没
  // 到点的定时器，只写当前那条的话，刚聊完那轮的正文就永远留在内存里（实测会留下
  // 一堆有标题没内容的空行）。空会话也不写库——新建后没说话不该占历史。
  useEffect(() => {
    if (!persist || !projectKey || !hydratedRef.current) return undefined;
    if (!dirtyRef.current.size) return undefined;
    const timer = setTimeout(async () => {
      const ids = [...dirtyRef.current];
      dirtyRef.current.clear();
      try {
        const m = await import('./taskStore.js');
        for (const id of ids) {
          const s = sessionsRef.current.find(x => x.id === id);
          if (!s || !(s.messages || []).length) continue;
          // 写库失败不抛错，只回 false（配额满/事务被拦）。留原样不清脏集合就等于静默丢历史；
          // 但无限重试会在 permanently 写不进时变成后台常驻，所以按轮次封顶
          const saved = await m.saveSession({ ...s, projectKey });
          if (!saved && retryRef.current < SAVE_RETRY_MAX) {
            dirtyRef.current.add(id);
            retryRef.current++;
            setRetryTick(n => n + 1);
          }
        }
        if (!dirtyRef.current.size) retryRef.current = 0;
        // 淘汰以库为准：内存列表可能滞后一帧，按它算会留下多出来的旧行
        const rows = await m.listSessions(projectKey);
        const keep = evictSessions(rows, activeRef.current, MAX_SESSIONS);
        const keepIds = new Set(keep.map(s => s.id));
        const dropped = rows.filter(s => !keepIds.has(s.id));
        for (const d of dropped) await m.deleteSession(projectKey, d.id);
        setSessions(prev => evictSessions(prev, activeRef.current, MAX_SESSIONS));
      } catch (e) { ids.forEach(i => dirtyRef.current.add(i)); }
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [sessions, activeId, projectKey, persist, retryTick]);

  const setMessages = useCallback(fn => {
    dirtyRef.current.add(activeRef.current);
    setSessions(prev => prev.map(s => (s.id === activeRef.current
      ? (() => {
        const messages = typeof fn === 'function' ? fn(s.messages) : fn;
        // 标题在第一轮定下来后不再改：用户改过名字或分了支，不该被后续消息覆盖
        return { ...s, messages, title: s.title || deriveTitle(messages), updatedAt: Date.now() };
      })()
      : s)));
  }, []);

  const startSession = useCallback(async () => {
    const key = keyRef.current;
    if (!key) return null;
    const s = newSession(key);
    setSessions(prev => evictSessions([s, ...prev], s.id, MAX_SESSIONS));
    setActive(s.id);
    // 不立刻写库：新建后一个字都没说的会话不该占掉一条历史位
    return s;
  }, []);

  const switchSession = useCallback((id) => {
    if (sessions.some(s => s.id === id)) setActive(id);
  }, [sessions]);

  const deleteSession = useCallback(async (id) => {
    const key = keyRef.current;
    dirtyRef.current.delete(id);
    const rest = sessions.filter(s => s.id !== id);
    setSessions(rest);
    try { const m = await import('./taskStore.js'); await m.deleteSession(key, id); } catch (e) { /* 行没删掉也只是下次还能看见它 */ }
    if (id === activeId) {
      if (rest.length) setActive(rest[0].id);
      else { const s = newSession(key); setSessions([s]); setActive(s.id); }
    }
  }, [sessions, activeId]);

  /** 从某条消息处分一支：前缀进新会话并切过去，原会话一个字都不动 */
  const forkSession = useCallback(async (index) => {
    const key = keyRef.current;
    const source = sessions.find(s => s.id === activeId);
    if (!source) return null;
    const s = { ...newSession(key), messages: forkMessages(source.messages, index), title: forkTitle(source) };
    setSessions(prev => evictSessions([s, ...prev], s.id, MAX_SESSIONS));
    setActive(s.id);
    try { const m = await import('./taskStore.js'); await m.saveSession({ ...s, projectKey: key }); } catch (e) { /* 同上 */ }
    return s;
  }, [sessions, activeId]);

  const active = sessions.find(s => s.id === activeId) || null;
  return {
    messages: (active && active.messages) || [],
    setMessages,
    briefs: sessions.map(sessionBrief),
    activeId,
    available: !!persist && hydratedRef.current,
    onStart: startSession,
    onSwitch: switchSession,
    onDelete: deleteSession,
    onFork: forkSession,
  };
}

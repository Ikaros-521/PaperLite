/**
 * Agent 落库：对话、任务状态与案例（浏览器本地，无后端）。
 *
 * 这一层只管「存什么形状、存多少、怎么淘汰」，不碰 IndexedDB（那是 idb.js）。
 * 三条上限都是取舍而不是技术限制：
 *   - 对话只留最近 CHAT_MSG_MAX 条、单条正文截到 CHAT_BODY_MAX：长任务一轮就能产出
 *     几十条工具结果，全存下来既撑爆配额也让下次加载变慢；
 *   - 任务与案例各留最近几十条，超了按 updatedAt 淘汰最旧的——这是复盘用的样本库，
 *     不是账本，不需要无限保留。
 * 存的东西一律按「可能被别的窗口改过」处理：只 put 单条，不整库覆盖。
 */
import { openDriver } from './idb.js';

export const CHAT_MSG_MAX = 200;
export const CHAT_BODY_MAX = 6000;
export const CHAT_REASONING_MAX = 1500;
export const TASK_MAX = 40;
export const CASE_MAX = 20;

function clip(s, n) {
  const v = String(s == null ? '' : s);
  return v.length > n ? v.slice(0, n) + '…' : v;
}

/**
 * 落库前的消息裁剪：丢掉只在流式期间有意义的易变字段，正文截断。
 * 刻意保留 kind/tool/args/ok——恢复后 UI 要能画出工具卡片，不然历史看起来像半成品。
 */
export function trimMessages(list) {
  return (list || []).slice(-CHAT_MSG_MAX).map(m => {
    if (!m || typeof m !== 'object') return null;
    const out = { role: m.role, content: clip(m.content, m.role === 'assistant' ? CHAT_BODY_MAX : CHAT_BODY_MAX) };
    if (m.kind) out.kind = m.kind;
    if (m.tool) out.tool = m.tool;
    if (m.args) out.args = (() => { try { return JSON.parse(JSON.stringify(m.args)); } catch (e) { return {}; } })();
    if (typeof m.ok === 'boolean') out.ok = m.ok;
    if (m.ctxNote) out.ctxNote = clip(m.ctxNote, 200);
    if (m.count != null) out.count = m.count;
    if (m.fixId) out.fixId = m.fixId;
    // 评审结论与快照点要跟着对话走：恢复历史后仍要能看见验收结果、仍能回滚
    if (m.review) out.review = m.review;
    if (m.usage) out.usage = m.usage;
    if (m.reasoning) out.reasoning = clip(m.reasoning, CHAT_REASONING_MAX);
    if (m.running) out.running = false;   // 落库时不可能还在跑
    return out;
  }).filter(Boolean);
}

/** 案例：只留「能用来改规则」的骨架，正文与工具结果不进案例库 */
export function caseOf(task) {
  const failures = (task.audit || []).filter(a => a && !a.ok);
  const chain = (task.audit || []).map(a => a.tool + (a.ok ? '' : ':' + (a.code || 'fail')));
  return {
    id: task.id,
    updatedAt: Date.now(),
    goal: clip(task.goal, 400),
    phase: task.phase,
    circuit: task.circuit || null,
    steps: (task.steps || []).map(s => ({ n: s.n, title: clip(s.title, 120), status: s.status, deps: s.deps })),
    openSteps: (task.steps || []).filter(s => s.status !== 'done' && s.status !== 'skipped').map(s => s.n),
    counters: { ...(task.counters || {}) },
    failedCalls: failures.slice(-12).map(a => ({ tool: a.tool, code: a.code || '', step: a.step })),
    chain: chain.slice(-60),
    durationMs: Date.now() - (task.startedAt || Date.now()),
  };
}

/**
 * @param driver {{put,get,remove,all,count}|null} 没有驱动时所有写操作静默失败——
 * 持久化是加分项，不该让一次对话因为它失败。
 */
export function makeTaskStore(driver) {
  const ok = !!driver;
  // 同毫秒内的连续写入靠 updatedAt 分不出先后，淘汰时会随机留下几条、丢掉另几条
  // （批量收尾一轮长任务正好会撞上一条条紧挨着写）。加一个本地单调序号做并列时的次键。
  let tick = 0;
  const stamp = (row) => ({ ...row, updatedAt: Date.now(), seq: ++tick });
  /** 按 updatedAt（同值时按 seq）淘汰最旧的，返回值是被删掉的条数 */
  async function evict(store, max) {
    if (!ok) return 0;
    const all = await driver.all(store);
    if (!Array.isArray(all) || all.length <= max) return 0;
    const sorted = all.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || (b.seq || 0) - (a.seq || 0));
    const drop = sorted.slice(max);
    for (const d of drop) await driver.remove(store, d.id);
    return drop.length;
  }
  return {
    available: ok,
    async saveChat(key, messages) {
      if (!ok || !key) return false;
      return !!(await driver.put('chats', stamp({ id: 'c:' + key, key, messages: trimMessages(messages) })));
    },
    async loadChat(key) {
      if (!ok || !key) return null;
      const row = await driver.get('chats', 'c:' + key);
      return row && Array.isArray(row.messages) ? row.messages : null;
    },
    async forgetChat(key) {
      if (!ok || !key) return false;
      return driver.remove('chats', 'c:' + key);
    },
    async saveTask(task) {
      if (!ok || !task || !task.id) return false;
      // 审计与快照才是长任务的价值所在，但整轮正文不该跟着落库
      const row = stamp({ ...task, audit: (task.audit || []).slice(-200) });
      const done = await driver.put('tasks', row);
      await evict('tasks', TASK_MAX);
      return done;
    },
    async listTasks(limit = 20) {
      if (!ok) return [];
      const all = await driver.all('tasks');
      return (all || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || (b.seq || 0) - (a.seq || 0)).slice(0, limit);
    },
    async saveCase(task) {
      if (!ok || !task) return false;
      const row = task.phase ? caseOf(task) : task;
      const done = await driver.put('cases', stamp({ ...row, id: row.id }));
      await evict('cases', CASE_MAX);
      return done;
    },
    async listCases(limit = 20) {
      if (!ok) return [];
      const all = await driver.all('cases');
      return (all || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || (b.seq || 0) - (a.seq || 0)).slice(0, limit);
    },
    async usage() {
      if (!ok) return { available: false, chats: 0, tasks: 0, cases: 0 };
      return {
        available: true,
        chats: await driver.count('chats'),
        tasks: await driver.count('tasks'),
        cases: await driver.count('cases'),
      };
    },
  };
}

let shared = null;
/** 浏览器侧共享实例（App 与 ChatPanel 用同一个，避免重复开库） */
export async function getTaskStore() {
  if (shared) return shared;
  const driver = await openDriver();
  shared = makeTaskStore(driver);
  return shared;
}

/* 便捷入口：调用方不必自己拿实例；库不可用时一律返回 false/null，不抛错。 */
export async function saveTask(task) { return (await getTaskStore()).saveTask(task); }
export async function saveCase(task) { return (await getTaskStore()).saveCase(task); }
export async function saveChat(key, messages) { return (await getTaskStore()).saveChat(key, messages); }
export async function loadChat(key) { return (await getTaskStore()).loadChat(key); }

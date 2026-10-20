/**
 * 落库层：消息裁剪、对话往返、任务与案例的上限淘汰。
 * 用内存驱动跑（Node 里没有 IndexedDB），驱动接口与 idb.js 一致；
 * 真库的行为由浏览器侧验证，这里钉的是「存什么形状、留多少」。
 */
import assert from 'node:assert/strict';
import {
  trimMessages, caseOf, makeTaskStore,
  CHAT_MSG_MAX, CHAT_BODY_MAX, TASK_MAX, CASE_MAX,
} from '../src/workspace/taskStore.js';
import { createTask, setPlan, updateStep, noteChange, recordAudit } from '../src/workspace/agentTask.js';
import { setLang } from '../src/i18n.js';

setLang('zh');

function memoryDriver() {
  const stores = { chats: new Map(), tasks: new Map(), cases: new Map() };
  return {
    stores,
    async put(name, value) { stores[name].set(value.id, JSON.parse(JSON.stringify(value))); return value.id; },
    async get(name, id) { const v = stores[name].get(id); return v === undefined ? null : v; },
    async remove(name, id) { return stores[name].delete(id); },
    async all(name) { return [...stores[name].values()].map(v => JSON.parse(JSON.stringify(v))); },
    async count(name) { return stores[name].size; },
  };
}

/* ---------- 消息裁剪 ---------- */
{
  const big = 'x'.repeat(CHAT_BODY_MAX + 500);
  const list = [
    { role: 'user', content: '帮我改方法节' },
    { role: 'assistant', kind: null, content: big },
    { role: 'user', kind: 'tool-result', tool: 'read_file', args: { path: 'main.tex' }, ok: true, content: '正文', running: true },
    { role: 'assistant', kind: 'review', content: '评审原文', review: { goalOk: false, missing: ['少一节'] }, usage: { input: 10, output: 2 } },
    { role: 'assistant', kind: 'summary', count: 12, content: '摘要' },
  ];
  const t = trimMessages(list);
  assert.equal(t.length, 5);
  assert.ok(t[1].content.length <= CHAT_BODY_MAX + 1, '超长正文要截断');
  assert.ok(t[1].content.endsWith('…'), '截断要留标记');
  assert.equal(t[2].running, false, '易变的 running 不能存成 true（恢复后卡片会永远转圈）');
  assert.equal(t[2].tool, 'read_file');
  assert.equal(t[2].args.path, 'main.tex', '参数要留着，恢复后才知道当时调了什么');
  assert.deepEqual(t[3].review, { goalOk: false, missing: ['少一节'] }, '评审结论要能跟着对话恢复');
  assert.equal(t[4].count, 12);
  assert.equal(trimMessages(null).length, 0);
  assert.equal(trimMessages([null, 'x']).length, 0, '坏条目丢掉而不是让整段历史不可用');

  const many = Array.from({ length: CHAT_MSG_MAX + 60 }, (_, i) => ({ role: 'user', content: 'm' + i }));
  const capped = trimMessages(many);
  assert.equal(capped.length, CHAT_MSG_MAX, '只留最近 ' + CHAT_MSG_MAX + ' 条');
  assert.equal(capped[capped.length - 1].content, 'm' + (CHAT_MSG_MAX + 59));
  assert.equal(capped[0].content, 'm60', '截的是最早的那头');
}

/* ---------- 对话往返 ---------- */
{
  const driver = memoryDriver();
  const store = makeTaskStore(driver);
  assert.equal(store.available, true);
  await store.saveChat('dir:my-paper', [{ role: 'user', content: '第一句' }, { role: 'assistant', content: '答' }]);
  const back = await store.loadChat('dir:my-paper');
  assert.deepEqual(back.map(m => m.content), ['第一句', '答']);
  assert.equal((await store.loadChat('dir:other')) , null, '没存过的项目返回 null');
  await store.saveChat('dir:my-paper', []);
  assert.deepEqual(await store.loadChat('dir:my-paper'), [], '清空对话要真的把记录清掉');
}

/* ---------- 任务与案例的上限 ---------- */
{
  const store = makeTaskStore(memoryDriver());
  const mkTask = (i, phase = 'completed') => {
    const t = createTask({ goal: '目标 ' + i });
    setPlan(t, { goal: 'g', steps: [{ title: 't', deliverable: 'd', done_when: 'y' }] });
    if (phase === 'tripped') t.circuit = { reason: 'calls', n: 60 };
    updateStep(t, { step: 1, status: 'doing' });
    noteChange(t, 'main.tex', 'v' + i);
    recordAudit(t, { step: 0, tool: 'read_file', args: '{}', ok: true, chars: 20 });
    t.id = 'task-' + i;
    t.startedAt = Date.now() - i;
    return t;
  };
  for (let i = 0; i < TASK_MAX + 8; i++) await store.saveTask(mkTask(i));
  const tasks = await store.listTasks(100);
  assert.equal(tasks.length, TASK_MAX, '任务表按上限淘汰：' + tasks.length);
  assert.equal(tasks[0].id, 'task-' + (TASK_MAX + 7), '列表按最近优先');
  assert.ok(tasks[0].audit.length >= 1, '审计跟着任务存进去（复盘要看过程）');

  const one = (await store.listTasks(1))[0];
  assert.equal(one.updatedAt > 0, true);

  // 案例库：只留骨架，不留正文
  for (let i = 0; i < CASE_MAX + 5; i++) await store.saveCase(mkTask(i, i % 2 ? 'tripped' : 'failed'));
  const cases = await store.listCases(100);
  assert.equal(cases.length, CASE_MAX, '案例表按上限淘汰：' + cases.length);
  const c = cases[0];
  assert.ok(c.goal && c.phase && Array.isArray(c.chain), '案例含目标/阶段/链路');
  assert.ok(c.chain.includes('read_file'), '链路里能看见调过什么');
  assert.equal(JSON.stringify(c).includes('正文'), false, '正文不进案例库');
  assert.ok(c.counters && c.openSteps !== undefined, '熔断位置与未完成步骤要留下');

  const u = await store.usage();
  assert.deepEqual({ tasks: u.tasks, cases: u.cases }, { tasks: TASK_MAX, cases: CASE_MAX }, '两张表都收在上限内');
  assert.equal(u.chats, 0, '这一节的驱动里没有存对话');
}

/* ---------- 库不可用时的降级 ---------- */
{
  const store = makeTaskStore(null);
  assert.equal(store.available, false);
  assert.equal(await store.saveChat('k', [{ role: 'user', content: 'x' }]), false, '没有驱动时写操作安静返回 false');
  assert.equal(await store.loadChat('k'), null);
  assert.equal(await store.saveTask({ id: 't' }), false);
  assert.deepEqual(await store.listCases(5), []);
  assert.equal((await store.usage()).available, false);
}

/* ---------- caseOf 直接可测（不经过驱动） ---------- */
{
  const t = createTask({ goal: 'g' });
  setPlan(t, { goal: 'g', steps: [{ title: '读', deliverable: 'd', done_when: 'y' }, { title: '改', deliverable: 'd2', done_when: 'y2', deps: [1] }] });
  updateStep(t, { step: 1, status: 'done' });
  updateStep(t, { step: 2, status: 'blocked', note: '缺少数据' });
  const cs = caseOf(t);
  assert.deepEqual(cs.openSteps, [2], '未完成步号');
  assert.equal(cs.steps[1].status, 'blocked');
  assert.equal(cs.id, t.id);
}

console.log('taskStore: all tests passed');

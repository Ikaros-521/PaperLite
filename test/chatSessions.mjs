/**
 * 多会话与消息级操作的语义钉死处：删除到底删了哪几条、编辑重发留下什么、
 * 分支切在哪、上限淘汰会不会把当前会话删掉、会话落库与旧数据升级。
 */
import assert from 'node:assert/strict';
import {
  deriveTitle, newSession, touchSession, evictSessions, sortSessions, turnRange,
  dropTurn, editResend, forkMessages, forkTitle, sessionBrief, isTurnStart,
  MAX_SESSIONS,
} from '../src/workspace/chatSessions.js';
import { makeTaskStore } from '../src/workspace/taskStore.js';
import { setLang } from '../src/i18n.js';

setLang('zh');

const mk = (text = '回答', over = {}) => ({ role: 'assistant', content: text, ...over });
const ask = (text) => ({ role: 'user', content: text });

/* ---------- 标题 ---------- */
{
  assert.equal(deriveTitle([]), '（无标题）', '空对话给占位标题而不是空串');
  assert.equal(deriveTitle([ask('帮我把方法节的公式推导补完整')]), '帮我把方法节的公式推导补完整');
  // 工具回执也是 role=user，不能拿它当标题
  assert.equal(deriveTitle([{ role: 'user', kind: 'tool-result', content: '正文正文' }, ask('真提问')]), '真提问');
  const long = deriveTitle([ask('x'.repeat(80))]);
  assert.ok(long.length <= 35 && long.endsWith('…'), '超长标题截断：' + long.length);
  assert.equal(deriveTitle([ask('  多  空格\n换行  ')]), '多 空格 换行', '空白折叠成一行');
}

/* ---------- 会话对象与淘汰 ---------- */
{
  const s = newSession('dir:p1');
  assert.ok(s.id && s.projectKey === 'dir:p1' && s.messages.length === 0);
  assert.notEqual(newSession('dir:p1').id, s.id, '同项目两次新建不能同 id');

  const t1 = touchSession(s, [ask('第一句')]);
  assert.equal(t1.title, '第一句', '第一轮就把标题定下来');
  const t2 = touchSession({ ...t1, title: '我改过的名字' }, [ask('第一句'), mk('答')]);
  assert.equal(t2.title, '我改过的名字', '定过名字后不被后续消息覆盖');

  const many = Array.from({ length: MAX_SESSIONS + 5 }, (_, i) => ({ id: 'x' + i, updatedAt: 1000 + i, messages: [] }));
  const kept = evictSessions(many, 'x0');
  assert.equal(kept.length, MAX_SESSIONS, '只留最近 ' + MAX_SESSIONS + ' 条');
  assert.ok(kept.some(s2 => s2.id === 'x0'), '当前会话即使最旧也必须留下（正在写的不能被历史管理删掉）');
  assert.ok(!kept.some(s2 => s2.id === 'x1'), '比当前更旧的那条该被清掉');
  assert.equal(evictSessions(many.slice(0, 3), 'x0').length, 3, '没到上限原样返回');
  assert.deepEqual(sortSessions([{ id: 'a', updatedAt: 1 }, { id: 'b', updatedAt: 9 }]).map(x => x.id), ['b', 'a']);
}

/* ---------- 轮次语义 ---------- */
{
  const list = [
    ask('问题一'), mk('答一'),
    { role: 'user', kind: 'tool-result', tool: 'read_file', content: '回执' }, mk('答一续'),
    ask('问题二'), mk('答二'),
  ];
  assert.equal(isTurnStart(list[0]), true);
  assert.equal(isTurnStart(list[2]), false, '工具回执不是新一轮');
  assert.deepEqual(turnRange(list, 0), { start: 0, end: 4 }, '点第一条提问 = 吞掉它到下一条提问之前');
  assert.deepEqual(dropTurn(list, 0).map(m => m.content), ['问题二', '答二'], '删除整轮');
  assert.deepEqual(dropTurn(list, 1).map(m => m.content), ['问题一', '回执', '答一续', '问题二', '答二'], '点回答只删那一条');
  assert.deepEqual(dropTurn(list, 5).map(m => m.content), ['问题一', '答一', '回执', '答一续', '问题二'], '删最后一条回答');

  const r = editResend(list, 4);
  assert.equal(r.text, '问题二', '编辑重发要把原文交回输入框');
  assert.deepEqual(r.list.map(m => m.content), ['问题一', '答一', '回执', '答一续'], '原这一轮先移除');
  assert.deepEqual(editResend(list, 99), { list: list.slice(), text: '' }, '越界不改任何东西');

  assert.deepEqual(forkMessages(list, 1).map(m => m.content), ['问题一', '答一'], '分支含所选这条');
  assert.equal(forkMessages(list, 0).length, 1);
  assert.equal(forkMessages(list, -3).length, 0, '负下标不炸');
  assert.equal(forkMessages(list, 99).length, list.length, '越界就是整份');
  assert.ok(forkTitle({ title: '帮我把方法节写清楚' }).startsWith('分支：'), '分支标题带上来源');
  assert.deepEqual(sessionBrief({ id: 'a', messages: [ask('q'), mk('a')], updatedAt: 5 }),
    { id: 'a', title: 'q', updatedAt: 5, count: 2 });
}

/* ---------- 会话落库与旧数据升级 ---------- */
{
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
  const driver = memoryDriver();
  const store = makeTaskStore(driver);

  await store.saveSession({ id: 's1', projectKey: 'dir:A', title: '甲项目第一句', createdAt: 1, updatedAt: 10, messages: [ask('甲项目第一句'), mk('答')] });
  await store.saveSession({ id: 's2', projectKey: 'dir:B', title: '乙项目', createdAt: 2, updatedAt: 20, messages: [ask('乙项目')] });
  const a = await store.listSessions('dir:A');
  assert.equal(a.length, 1, '一个项目只看得到自己的会话');
  assert.equal(a[0].id, 's1');
  assert.equal(a[0].messages.length, 2);
  assert.equal((await store.listSessions('dir:B'))[0].id, 's2');

  await store.saveSession({ id: 's3', projectKey: 'dir:A', title: '后写的', createdAt: 3, updatedAt: 30, messages: [ask('后写的')] });
  assert.deepEqual((await store.listSessions('dir:A')).map(s => s.id), ['s3', 's1'], '列表按最近使用倒序');
  assert.equal(await store.deleteSession('dir:A', 's3'), true);
  assert.deepEqual((await store.listSessions('dir:A')).map(s => s.id), ['s1']);

  // 旧版「一个项目一份对话」升级成会话，并且旧行被吃掉（留着会被下一次保存当成空历史覆盖）
  await store.saveChat('dir:A', [ask('旧记录'), mk('旧回答')]);
  const legacy = await store.adoptLegacyChat('dir:A');
  assert.ok(legacy && legacy.messages.length === 2, '旧记录被读成一条会话');
  assert.equal(await store.loadChat('dir:A'), null, '旧行读过就没了');
  assert.deepEqual(await store.listSessions('dir:C'), [], '没存过的项目返回空数组');
  assert.equal(await store.adoptLegacyChat('dir:C'), null);

  // 文件夹名键 → UUID：会话行与旧版单对话行一起搬
  await store.saveSession({ id: 's4', projectKey: 'dir:same', title: '同名目录', createdAt: 4, updatedAt: 40, messages: [ask('同名目录')] });
  await store.saveChat('dir:same', [ask('旧单对话'), mk('旧答')]);
  assert.equal(await store.migrateSessions('dir:same', 'p-same'), 2, '会话与旧单对话都搬');
  assert.deepEqual(await store.listSessions('dir:same'), [], '旧项目键清空');
  assert.equal((await store.listSessions('p-same'))[0].id, 's4', '新项目键能读到会话');
  assert.ok(await store.loadChat('p-same'), '旧单对话跟着搬到新键');
  assert.equal(await store.migrateSessions('dir:same', 'p-same'), 0, '重复迁移不重复搬');

  // 目标键已有新会话时仍要合并旧会话（上次迁一半失败/后来先落了新会话）
  await store.saveSession({ id: 's5', projectKey: 'dir:more', title: '旧会话', createdAt: 5, updatedAt: 50, messages: [ask('旧会话')] });
  await store.saveSession({ id: 's6', projectKey: 'p-more', title: '新会话', createdAt: 6, updatedAt: 60, messages: [ask('新会话')] });
  assert.equal(await store.migrateSessions('dir:more', 'p-more'), 1, '目标非空也要把旧会话补进来');
  assert.deepEqual((await store.listSessions('p-more')).map(s => s.id).sort(), ['s5', 's6']);
}

console.log('chatSessions: all tests passed');

console.log('chatSessions: all tests passed');

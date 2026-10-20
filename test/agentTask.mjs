/**
 * Agent 任务状态机：计划结构校验、依赖与状态迁移、快照原料、跑偏拦截、熔断条件、
 * 注入请求的结构化简报。这里钉的是「状态归框架持有」这件事的规则本身——
 * 模型只能提议动作，合法性由这些函数判。
 */
import assert from 'node:assert/strict';
import {
  createTask, setPlan, updateStep, noteChange, noteCreate, takeSnapshot, recordAudit,
  writeDrift, checkCircuit, stepProgress, taskBrief, taskSummary, goalOverlap,
  PLAN_MAX_STEPS, CIRCUIT_LIMITS, TASK_PHASES, STEP_STATUSES,
} from '../src/workspace/agentTask.js';
import { setLang, tr } from '../src/i18n.js';

setLang('zh');

const goodSteps = () => ([
  { title: '读原文', deliverable: 'main.tex 的当前正文', done_when: 'read_file 成功' },
  { title: '改方法节', deliverable: 'main.tex 中 \\section{Method} 的替换文本', done_when: 'edit_file 成功', deps: [1] },
  { title: '复查诊断', deliverable: '诊断清单', done_when: 'get_diagnostics 返回 0 条', deps: [2] },
]);

/* ---------- 计划结构 ---------- */
{
  const t = createTask({ goal: '把方法节改清楚' });
  assert.equal(t.phase, 'planning', '新建任务处在待规划');
  assert.equal(setPlan(t, {}).ok, false, '没有 steps 直接拒');
  assert.equal(setPlan(t, { goal: 'g', steps: [] }).ok, false, '空数组拒');
  assert.equal(setPlan(t, { goal: 'g', steps: [{ title: '只做一件事' }] }).code, undefined, '错误通过 error 文本返回而不是 code');

  // 缺交付物 / 缺完成判定 / 缺标题
  const e1 = setPlan(t, { goal: 'g', steps: [{ title: '读原文', done_when: '读过' }] });
  assert.ok(!e1.ok && e1.error.includes('交付物'), '没有交付物要指名道姓：' + e1.error);
  const e2 = setPlan(t, { goal: 'g', steps: [{ title: '读原文', deliverable: '正文' }] });
  assert.ok(!e2.ok && e2.error.includes('完成判定'), '没有完成判定要拒绝：' + e2.error);
  const e3 = setPlan(t, { goal: 'g', steps: [{ deliverable: '正文', done_when: 'x' }] });
  assert.ok(!e3.ok, '没有标题要拒绝');
  assert.equal(t.steps.length, 0, '被拒的计划不该留下半成品');

  // 依赖只允许指向更早的步：前向依赖与自依赖都拒绝（环因此不可能出现）
  assert.ok(!setPlan(t, { goal: 'g', steps: [
    { title: 'a', deliverable: 'x', done_when: 'y', deps: [2] },
    { title: 'b', deliverable: 'x', done_when: 'y' },
  ] }).ok, '依赖后面的步是前向依赖');
  assert.ok(!setPlan(t, { goal: 'g', steps: [
    { title: 'a', deliverable: 'x', done_when: 'y', deps: [1] },
  ] }).ok, '依赖自己同样拒绝');

  const r = setPlan(t, { goal: 'g', steps: goodSteps() });
  assert.ok(r.ok, '合法计划登记成功');
  assert.equal(t.phase, 'executing');
  assert.deepEqual(t.steps.map(s => s.n), [1, 2, 3]);
  assert.deepEqual(t.steps[1].deps, [1]);
  assert.equal(t.steps[0].deps.length, 0);

  // 空白与超长：折叠换行、按上限截断而不是原样入库
  const long = setPlan(createTask({ goal: 'g' }), { goal: 'g', steps: [
    { title: '  多 行\n标题  ', deliverable: 'd'.repeat(PLAN_MAX_STEPS * 40), done_when: 'y' },
  ] });
  assert.ok(long.ok);
  assert.equal(long.steps[0].title, '多 行 标题', '标题里的换行要折叠');
  assert.ok(long.steps[0].deliverable.length <= 300, '超长字段要截断');

  assert.ok(!setPlan(createTask({ goal: 'g' }), { goal: 'g', steps: Array.from({ length: PLAN_MAX_STEPS + 1 }, () => ({ title: 't', deliverable: 'd', done_when: 'y' })) }).ok, '步数封顶');
}

/* ---------- 状态迁移：依赖闸与不可逆 ---------- */
{
  const t = createTask({ goal: 'g' });
  setPlan(t, { goal: 'g', steps: goodSteps() });
  assert.ok(!updateStep(t, { step: 2, status: 'doing' }).ok, '前置未完成不许开工');
  assert.ok(!updateStep(t, { step: 9, status: 'doing' }).ok, '没有第 9 步');
  assert.ok(!updateStep(t, { step: 1, status: 'finished' }).ok, '状态只认枚举');
  assert.equal(t.currentStep, null, '被拒的迁移不改状态');

  assert.ok(updateStep(t, { step: 1, status: 'doing' }).ok);
  assert.equal(t.currentStep, 1);
  assert.ok(updateStep(t, { step: 1, status: 'done' }).ok);
  assert.equal(t.counters.steps, 1, '完成的子任务计数');
  assert.ok(updateStep(t, { step: 2, status: 'doing' }).ok, '前置完成后才放行');
  const back = updateStep(t, { step: 1, status: 'doing' });
  assert.ok(!back.ok && /不可逆|不能改回/.test(back.error), '已完成不许回退：' + back.error);

  assert.ok(updateStep(t, { step: 2, status: 'blocked', note: '缺参考文献' }).ok);
  assert.equal(t.steps[1].note, '缺参考文献', '受阻要留下原因');
  assert.ok(updateStep(t, { step: 2, status: 'skipped' }).ok);
  assert.ok(updateStep(t, { step: 3, status: 'skipped' }).ok, '依赖被跳过的步可以跳过');
  assert.equal(t.phase, 'completed', '全部 done/skipped 即任务完成');
}

/* ---------- 快照：本步第一次改动的「改前版本」才是快照原料 ---------- */
{
  const t = createTask({ goal: 'g' });
  setPlan(t, { goal: 'g', steps: goodSteps() });
  updateStep(t, { step: 1, status: 'doing' });
  assert.equal(takeSnapshot(t, 1), null, '没改文件就没有快照');
  noteChange(t, 'main.tex', 'v1');
  noteChange(t, 'main.tex', 'v2');          // 同一路径本步内只记第一次
  noteChange(t, 'refs.bib', 'b1');
  const s = takeSnapshot(t, 1);
  assert.deepEqual(s.files, { 'main.tex': 'v1', 'refs.bib': 'b1' });
  assert.equal(takeSnapshot(t, 1), null, '取完就清空，第二步重新攒');
  assert.deepEqual(t.touched, { 'main.tex': 'v2', 'refs.bib': 'b1' }, 'touched 是累计视图（记最近一次改前版本，回滚用的是快照不是它）');

  // 本轮新建的文件没有「改前」，单列出来告知用户（回滚不删用户目录里的东西）
  updateStep(t, { step: 2, status: 'doing' });
  noteCreate(t, 'new/sec.tex');
  const s2 = takeSnapshot(t, 2);
  assert.deepEqual(s2.files, {}, '新建文件不进 files');
  assert.deepEqual(s2.created, ['new/sec.tex']);
  assert.equal(s2.step, 2, '快照记住它属于哪一步');

  // 快照条数封顶：长任务不能攒出无限历史
  for (let i = 0; i < 30; i++) { noteChange(t, 'a.tex', 'x' + i); takeSnapshot(t, i + 1); }
  assert.ok(t.snapshots.length <= 12, '只留最近 12 个快照点：' + t.snapshots.length);
}

/* ---------- 跑偏拦截（前置校验的落点侧） ---------- */
{
  const plain = createTask({ goal: '帮我润色一下' });
  assert.equal(writeDrift(plain, 'main.tex'), false, '没有计划就不设这道闸');
  setPlan(plain, { goal: 'g', steps: [{ title: '润色', deliverable: '更好的句子', done_when: '改完' }] });
  assert.equal(writeDrift(plain, 'main.tex'), false, '计划里没出现过任何文件名 → 放行（拦了只会让模型白绕一圈）');

  const t = createTask({ goal: 'g' });
  setPlan(t, { goal: 'g', steps: goodSteps() });
  updateStep(t, { step: 1, status: 'doing' });
  assert.equal(writeDrift(t, 'main.tex'), false, '计划里写过的落点放行');
  assert.equal(writeDrift(t, 'ch1/main.tex'), false, '只写文件名时按尾段匹配');
  assert.equal(writeDrift(t, 'secrets.tex'), true, '没写过的文件算跑偏');
  noteChange(t, 'draft.md', 'v9');
  assert.equal(writeDrift(t, 'draft.md'), false, '本轮已经改过的文件不再重复拦');

  const done = createTask({ goal: 'g' });
  setPlan(done, { goal: 'g', steps: [{ title: 'x', deliverable: 'a.tex', done_when: 'y' }] });
  updateStep(done, { step: 1, status: 'done' });
  assert.equal(done.phase, 'completed');
  assert.equal(writeDrift(done, 'other.tex'), false, '计划已收尾时不再拦（该收的是最终回答）');
}

/* ---------- 目标重合度与熔断 ---------- */
{
  assert.ok(goalOverlap('把方法节的公式推导补完整', '补全 \\section{Method} 的推导') > 0.25, '正当复述不该被误判');
  assert.ok(goalOverlap('把方法节的公式推导补完整', 'rewrite the bibliography entries') < 0.1, '复述跑偏要能看出来');
  assert.equal(goalOverlap('', '任何东西'), 1, '分不出词就不判');

  const t = createTask({ goal: 'g' });
  assert.equal(checkCircuit(t, {}), null);
  for (let i = 0; i < CIRCUIT_LIMITS.calls; i++) t.counters.calls++;
  assert.deepEqual(checkCircuit(t, {}).reason, 'calls', '调用数上限是硬闸');
  const t2 = createTask({ goal: 'g' });
  t2.counters.noProgress = CIRCUIT_LIMITS.noProgress;
  assert.equal(checkCircuit(t2, {}).reason, 'no_progress', '零推进也要熔断');
  const t3 = createTask({ goal: 'g', now: Date.now() - 3_600_000 });
  assert.equal(checkCircuit(t3, { deadlineMs: 60_000 }).reason, 'time', '挂钟超时');
  assert.equal(checkCircuit(t3, {}), null, '没传 deadline 就不判时间（循环自己另有挂钟）');

  stepProgress(t2, false);
  assert.equal(t2.counters.noProgress, CIRCUIT_LIMITS.noProgress + 1);
  stepProgress(t2, true);
  assert.equal(t2.counters.noProgress, 0, '一旦推进就清零');
}

/* ---------- 简报：只给状态，不给正文 ---------- */
{
  const t = createTask({ goal: '把 main.tex 的方法节改清楚，别动实验章节' });
  setPlan(t, { goal: 'g', steps: goodSteps() });
  updateStep(t, { step: 1, status: 'doing' });
  noteChange(t, 'main.tex', 'v1');
  t.counters.calls = 4; t.counters.writes = 1; t.counters.cacheHits = 2;
  recordAudit(t, { step: 0, tool: 'read_file', args: '{"path":"main.tex"}', ok: true, chars: 20 });
  const brief = taskBrief(t, 8);
  assert.ok(brief.includes('把 main.tex 的方法节改清楚'), '目标锚定要在简报里');
  assert.ok(brief.includes('读原文') && brief.includes('read_file 成功'), '当前子任务的交付物与完成判定');
  assert.ok(brief.includes('0/3 完成'), '进度');
  assert.ok(brief.includes('main.tex'), '已改动文件');
  assert.ok(brief.includes('8'), '剩余额度');
  assert.ok(brief.includes('2'), '重复读取折叠数');
  assert.ok(brief.length < 600, '简报必须短：' + brief.length);
  assert.ok(!brief.includes('v1'), '版本 id 不进简报（那是回滚用的，不是模型要的）');

  const phases = TASK_PHASES.map(p => tr('zh', 'agent.phase.' + p));
  assert.ok(phases.every(s => s && !s.startsWith('agent.')), '每个阶段都要有中文名');
  assert.equal(new Set(STEP_STATUSES).size, 5);

  const s = taskSummary(t);
  assert.equal(s.goal, t.goal);
  assert.deepEqual(s.openSteps, [1, 2, 3], '没收到 done/skipped 的步骤都算未完成（含正在做的第 1 步）');
  assert.equal(s.audit.length, 1);
  assert.ok(s.durationMs >= 0);
}

console.log('agentTask: all tests passed');

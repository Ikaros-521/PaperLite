/**
 * Agent 执行循环：mock 一个 OpenAI 兼容 SSE 接口，钉住「工具调用 → 执行 → 结果回传 → 终答」
 * 的多步行为，以及 UI 消息形状（tool-result 卡片数据）与预算管线（tool-result 按普通
 * user 消息进入 buildPayload）。
 */
import assert from 'node:assert/strict';
import { runAgentLoop, agentSystemPrompt, loadAgentSettings, saveAgentSettings, AGENT_TOOLS_PER_STEP, AGENT_WRITES_PER_RUN } from '../src/workspace/agentRuntime.js';
import { contentSig } from '../src/workspace/toolRegistry.js';
import * as ctxBudget from '../src/context.js';
import { setLang } from '../src/i18n.js';

setLang('zh');

// 极简 OpenAI SSE 响应：把 content 一次性吐成一个 delta，之后再 EOF
function sseResponse(content) {
  const payload = JSON.stringify({ choices: [{ delta: { content } }] });
  const body = 'data: ' + payload + '\n\ndata: [DONE]\n\n';
  const chunk = new TextEncoder().encode(body);
  let sent = false;
  return {
    ok: true, status: 200,
    headers: new Map(),
    body: {
      getReader: () => ({
        read: async () => (sent++ ? { done: true } : { done: false, value: chunk }),
      }),
    },
  };
}

const executed = [];
const execute = async (name, args) => {
  executed.push({ name, args });
  return { ok: true, result: 'TOOL-OK(' + name + '): main.tex 的内容' };
};

// mock 渠道：第一轮输出工具调用，看到工具结果后给终答
let step = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, opts) => {
  const body = JSON.parse(opts.body);
  const hasToolResult = body.messages.some(m => m.role === 'user' && String(m.content).includes('TOOL-OK'));
  step++;
  const content = hasToolResult
    ? '已经读取完毕，这是最终回答。'
    : '我先读一下文件：\n```tool\n{"tool":"read_file","args":{"path":"main.tex"}}\n```';
  return sseResponse(content);
};

const channel = { protocol: 'openai', baseUrl: 'http://mock.test/v1', chatModel: 'mock-model', apiKey: '' };
const updates = [];
const { usage } = await runAgentLoop({
  channel,
  messages: [{ role: 'user', content: '帮我看看 main.tex' }],
  system: agentSystemPrompt(),
  docHeader: 'brief:',
  doc: '当前编辑 main.tex',
  summaryHeader: 'summary:',
  budget: ctxBudget.inputBudget(channel),
  execute,
  onUpdate: list => updates.push(list.length),
  signal: undefined,
});
globalThis.fetch = realFetch;

assert.equal(executed.length, 1, '工具必须恰好执行一次');
assert.equal(executed[0].name, 'read_file');
assert.equal(executed[0].args.path, 'main.tex');
assert.equal(step, 2, '两步：工具调用 + 终答');

// onUpdate 序列非递减（流式增量重复推送同一长度是正常的），最终消息数 = 提问+2条assistant+1条tool-result
assert.ok(updates.length >= 4, '至少推送 4 次状态');
for (let i = 1; i < updates.length; i++) assert.ok(updates[i] >= updates[i - 1], '消息只增不减');
assert.equal(Math.max(...updates), 4, '最终 4 条消息：user + assistant(工具) + tool-result + assistant(终答)');

// 验证发送给模型的载荷里 tool-result 确实作为 user 消息存在（fetch mock 已隐式验证 hasToolResult），
// 再独立验证 buildPayload 对 tool-result 形状的兼容
const built = ctxBudget.buildPayload({
  system: 's', docHeader: 'd', doc: '', summaryHeader: 'sum',
  history: [
    { role: 'user', content: '问题' },
    { role: 'assistant', content: '```tool\n{"tool":"x"}\n```' },
    { role: 'user', kind: 'tool-result', tool: 'x', args: {}, content: '结果' },
  ],
  budget: 8000,
});
assert.equal(built.messages.filter(m => m.role === 'user').length, 2, 'tool-result 按普通 user 消息装配');

// 步数上限 + 工具结果渐进式披露：模型每轮都坚持调工具时，循环必须在 maxSteps 收口；
// 且第 3 条工具结果出现后，最早一条在请求侧被占位替换（UI 侧不变），最近两条保持全文。
let loops = 0;
const requests = [];
let seq = 0;
globalThis.fetch = async (u, opts) => {
  loops++;
  requests.push(JSON.parse(opts.body).messages);
  return sseResponse('```tool\n{"tool":"read_selection","args":{}}\n```');
};
const updates2 = [];
const uiLists = [];
await runAgentLoop({
  channel,
  messages: [{ role: 'user', content: 'go' }],
  system: 's', docHeader: 'd', doc: '', summaryHeader: 'sum',
  budget: ctxBudget.inputBudget(channel),
  maxSteps: 3,
  keepResults: 2,   // 显式钉住保留条数：本段验证的是披露机制本身，不随默认值漂移
  execute: async () => ({ ok: true, result: 'RESULT-' + (++seq) }),
  onUpdate: list => { updates2.push(list); uiLists.push(list); },
});
globalThis.fetch = realFetch;
assert.equal(loops, 4, 'maxSteps=3 时最多 4 次模型调用（3 步工具 + 1 次收口终答）');
const kinds = updates2[updates2.length - 1].map(m => m.kind).filter(Boolean);
assert.ok(kinds.includes('tool-result'), '工具结果要在消息流里');
assert.ok(updates2[updates2.length - 1].some(m => m.kind === 'agent-limit'), '收口提示要在消息流里');

// 请求侧：第 4 次调用的历史里，RESULT-1 已占位、RESULT-2/3 保留全文
const lastReq = requests[requests.length - 1];
const reqText = lastReq.map(m => m.content).join('\n');
assert.ok(!reqText.includes('RESULT-1'), '最早的工具结果必须从请求中省略');
assert.ok(reqText.includes('RESULT-2') && reqText.includes('RESULT-3'), '最近两条工具结果保留全文');
assert.ok(reqText.includes('已省略') || reqText.includes('omitted'), '占位说明要在');
// UI 侧：完整结果始终可见
const uiText = uiLists[uiLists.length - 1].map(m => m.content || '').join('\n');
assert.ok(uiText.includes('RESULT-1'), 'UI 消息流仍保留完整结果');

// keepResults 可配置（AI 设置 → Agent 子页）：请求侧全文保留条数走 opts 而非固定常量
let seq3 = 0;
const requests3 = [];
globalThis.fetch = async (u, opts) => {
  requests3.push(JSON.parse(opts.body).messages);
  return sseResponse('```tool\n{"tool":"read_selection","args":{}}\n```');
};
await runAgentLoop({
  channel,
  messages: [{ role: 'user', content: 'go' }],
  system: 's', docHeader: 'd', doc: '', summaryHeader: 'sum',
  budget: ctxBudget.inputBudget(channel),
  maxSteps: 3,
  keepResults: 1,
  execute: async () => ({ ok: true, result: 'KEEP-' + (++seq3) }),
  onUpdate: () => {},
});
globalThis.fetch = realFetch;
const keepReq = requests3[requests3.length - 1].map(m => m.content).join('\n');
assert.ok(!keepReq.includes('KEEP-1') && !keepReq.includes('KEEP-2'), 'keepResults=1 时更早的结果要从请求中省略');
assert.ok(keepReq.includes('KEEP-3'), '最近 1 条保持全文');

// Agent 行为设置的持久化：读回 + 越界钳制 + 损坏数据回退默认值
const memStore = {};
globalThis.localStorage = {
  getItem: k => (k in memStore ? memStore[k] : null),
  setItem: (k, v) => { memStore[k] = String(v); },
};
saveAgentSettings({ maxSteps: 999, keepResults: 0 });
assert.deepEqual(loadAgentSettings(), { maxSteps: 50, keepResults: 1, approval: 'auto', plan: true, review: false, persist: true }, '越界值要钳制到合法区间');
saveAgentSettings({ maxSteps: 12, keepResults: 4, approval: 'ask', plan: false });
assert.deepEqual(loadAgentSettings(), { maxSteps: 12, keepResults: 4, approval: 'ask', plan: false, review: false, persist: true }, '合法值要原样读回');
saveAgentSettings({ approval: 'yolo-full-access' });
assert.equal(loadAgentSettings().approval, 'auto', '野档位回默认档，不能因为拼错就变成完全访问');
memStore['paperlite.agentSettings.v1'] = '{oops';
assert.deepEqual(loadAgentSettings(), { maxSteps: 15, keepResults: 5, approval: 'auto', plan: true, review: false, persist: true }, '损坏数据回退默认值');
delete globalThis.localStorage;

// 单步工具数与整轮改盘次数：畸形或自我循环的输出不该一口气改几十处，
// 而且被拒的每一条都要有「未执行」回执（UI 照样画卡片，模型不能以为已经改过）
{
  const did = [];
  let n = 0;
  globalThis.fetch = async () => sseResponse(
    Array.from({ length: 10 }, () => '```tool\n{"tool":"edit_file","args":{"old_text":"x' + (++n) + '","new_text":"y"}}\n```').join('\n')
  );
  const lists = [];
  await runAgentLoop({
    channel, messages: [{ role: 'user', content: 'go' }], system: 's', docHeader: 'd', doc: '', summaryHeader: 'sum',
    budget: 4000, maxSteps: 6, keepResults: 6,
    execute: async (name, args) => { did.push(args.old_text); return { ok: true, result: 'EDIT-OK' }; },
    onUpdate: l => lists.push(l),
  });
  globalThis.fetch = realFetch;
  const receipts = lists[lists.length - 1].filter(m => m.kind === 'tool-result');
  assert.ok(did.length <= AGENT_WRITES_PER_RUN, '整轮改盘不超过上限：' + did.length);
  assert.equal(did.length, AGENT_WRITES_PER_RUN, '上限内的改动手要真的执行');
  // 6 个执行步 + 1 个收口步，每步 10 条调用都要有回执（收口步只回执不执行）
  assert.equal(receipts.length, 70, '每条调用都要有回执');
  assert.ok(receipts.filter(m => !m.ok && /未执行/.test(m.content)).length >= 70 - AGENT_WRITES_PER_RUN,
    '被拦下的调用标注未执行');
  assert.equal(receipts.filter(m => /单步/.test(m.content)).length, (10 - AGENT_TOOLS_PER_STEP) * 6,
    '每步超额的两条都用「分批」文案');
}

// ---------- 权限档位：ask 逐个确认（可拒）、auto 不打断、full 免整轮改盘配额 ----------
{
  const editBatch = (n) => sseResponse(Array.from({ length: n }, (_, k) =>
    '```tool\n{"tool":"edit_file","args":{"path":"main.tex","old_text":"a' + k + '","new_text":"b"}}\n```').join('\n'));
  const describe = (name, args) => ({ mutates: true, tool: name, path: String(args.path || ''), detail: '「a」改成「b」' });

  const run = async ({ approval, approve, steps = 1, perStep = 1 }) => {
    let asked = 0, ran = 0;
    const infos = [];
    globalThis.fetch = async () => editBatch(perStep);
    await runAgentLoop({
      channel, messages: [{ role: 'user', content: 'go' }], system: 's', docHeader: 'd', doc: '', summaryHeader: 'sum',
      budget: 6000, maxSteps: steps, keepResults: 9, approval,
      requestApproval: async (info) => { asked++; infos.push(info); return approve; },
      execute: Object.assign(async (name) => { ran++; return { ok: true, result: 'APPLIED' }; }, { describe }),
      onUpdate: () => {},
    });
    globalThis.fetch = realFetch;
    return { asked, ran, infos };
  }

  const denied = await run({ approval: 'ask', approve: false });
  assert.equal(denied.asked, 1, '「每次审核」档每个改动手问一次');
  assert.equal(denied.ran, 0, '被拒的改动手不执行');
  assert.equal(denied.infos[0].path, 'main.tex', '确认信息用工具自己的落点解析');
  assert.ok(denied.infos[0].detail.includes('改成'), '确认信息带改动摘要');

  const allowed = await run({ approval: 'ask', approve: true });
  assert.equal(allowed.asked, 1, '确认后照常执行');
  assert.equal(allowed.ran, 1, '批准的改动手落地');

  const auto = await run({ approval: 'auto', approve: false });
  assert.equal(auto.asked, 0, '「自动审核」不打断');
  assert.equal(auto.ran, 1, '「自动审核」照常改');

  // 完全访问档免掉「整轮改盘次数」这道刹车（每步仍受单步 8 条与步数上限约束）
  const capped = await run({ approval: 'auto', approve: true, steps: 3, perStep: 10 });
  assert.equal(capped.ran, AGENT_WRITES_PER_RUN, '默认档整轮改盘封顶');
  const wide = await run({ approval: 'full', approve: true, steps: 3, perStep: 10 });
  assert.equal(wide.ran, AGENT_TOOLS_PER_STEP * 3, '「完全访问」不受改盘次数限制');
}

/* ---------- 框架侧拦截：非法参数不进执行器、同内容重读瘦身、重复失败关掉死路 ---------- */
{
  const call = (t, a) => '```tool\n' + JSON.stringify({ tool: t, args: a }) + '\n```';

  // A) edit_file 缺 new_text：执行器一次都不该被调用，回执要带缺的参数与下一步
  {
    const ran = [], lists = [];
    let n = 0;
    globalThis.fetch = async () => {
      n++;
      return sseResponse(n === 1 ? call('edit_file', { old_text: '只有旧串' }) : '改好了。');
    };
    await runAgentLoop({
      channel, messages: [{ role: 'user', content: 'go' }], system: 's', docHeader: 'd', doc: '', summaryHeader: 'sum',
      budget: 6000, maxSteps: 4, keepResults: 9,
      execute: async (name) => { ran.push(name); return { ok: true, result: 'SHOULD-NOT-RUN' }; },
      onUpdate: l => lists.push(l),
    });
    globalThis.fetch = realFetch;
    assert.equal(ran.length, 0, '非法参数不进执行器');
    const rec = lists[lists.length - 1].find(m => m.kind === 'tool-result');
    assert.ok(rec && !rec.ok, '非法调用要有失败回执');
    assert.ok(rec.content.includes('new_text'), '回执要指出缺哪个参数：' + rec.content);
    assert.ok(rec.content.includes('下一步'), '回执要带降级建议');
  }

  // B) 同一个 read_file 重读且内容未变：第二次回执换成一行「与第 N 步相同」，
  //    正文不再进上下文（长任务里这是最省 token 的一道）
  {
    const lists = [], sig = contentSig('main.tex 的正文');
    let n = 0;
    globalThis.fetch = async () => {
      n++;
      return sseResponse(n <= 2 ? call('read_file', { path: 'main.tex' }) : '读完了。');
    };
    await runAgentLoop({
      channel, messages: [{ role: 'user', content: 'go' }], system: 's', docHeader: 'd', doc: '', summaryHeader: 'sum',
      budget: 6000, maxSteps: 4, keepResults: 9,
      execute: async () => ({ ok: true, result: 'main.tex 的正文', sig }),
      onUpdate: l => lists.push(l),
    });
    globalThis.fetch = realFetch;
    const recs = lists[lists.length - 1].filter(m => m.kind === 'tool-result');
    assert.equal(recs.length, 2, '两次调用两条回执');
    assert.equal(recs[0].content, 'main.tex 的正文', '第一次给全文');
    assert.ok(/完全相同/.test(recs[1].content), '第二次只给一行相同说明：' + recs[1].content);
    assert.ok(!recs[1].content.includes('main.tex 的正文'), '重复正文不进上下文');
  }

  // C) 内容变了就必须给新结果（判重只在真的没变时生效）
  {
    const lists = [];
    let n = 0;
    globalThis.fetch = async () => {
      n++;
      return sseResponse(n <= 2 ? call('read_file', { path: 'main.tex' }) : '读完了。');
    };
    await runAgentLoop({
      channel, messages: [{ role: 'user', content: 'go' }], system: 's', docHeader: 'd', doc: '', summaryHeader: 'sum',
      budget: 6000, maxSteps: 4, keepResults: 9,
      execute: async () => { const v = n === 1 ? '改之前' : '改之后'; return { ok: true, result: v, sig: contentSig(v) }; },
      onUpdate: l => lists.push(l),
    });
    globalThis.fetch = realFetch;
    const recs = lists[lists.length - 1].filter(m => m.kind === 'tool-result');
    assert.deepEqual(recs.map(m => m.content), ['改之前', '改之后'], '内容变了就是新结果');
  }

  // D) 同一条失败调用连着三次后，框架不再执行它（模型在跟自己绕圈）
  {
    const ran = [], lists = [];
    let n = 0;
    // 同一步里连发四条一模一样的失败调用：前三条真的执行（各记一次失败），第四条起
    // 框架按台账拦下——放在同一步是为了把「重复调用拦截」与「零推进熔断」分开验
    globalThis.fetch = async () => {
      n++;
      return sseResponse(n === 1
        ? call('read_file', { path: 'nope.tex' }) + call('read_file', { path: 'nope.tex' })
          + call('read_file', { path: 'nope.tex' }) + call('read_file', { path: 'nope.tex' })
        : '放弃这条路。');
    };
    await runAgentLoop({
      channel, messages: [{ role: 'user', content: 'go' }], system: 's', docHeader: 'd', doc: '', summaryHeader: 'sum',
      budget: 6000, maxSteps: 6, keepResults: 9,
      execute: async (name) => { ran.push(name); return { ok: false, result: '未找到文件', code: 'file_not_found' }; },
      onUpdate: l => lists.push(l),
    });
    globalThis.fetch = realFetch;
    assert.equal(ran.length, 3, '三次之后不再执行：' + ran.length);
    const recs = lists[lists.length - 1].filter(m => m.kind === 'tool-result');
    assert.equal(recs.length, 4, '被拦下的调用同样要有回执');
    assert.ok(/失败 3 次/.test(recs[3].content), '第四条说明是被框架拦下：' + recs[3].content);
    assert.ok(recs[0].content.includes('list_files'), '失败建议按错误码追加：' + recs[0].content);
  }

  // E) 零推进熔断：连续几步既没成功调用也没推进计划 → 框架终止，不再陪模型绕圈
  {
    let n = 0, ran = 0;
    const lists = [];
    globalThis.fetch = async () => {
      n++;
      // 每步换一个不同的失败参数：重复拦截管不到它，只能靠零推进收口
      return sseResponse(call('read_file', { path: 'nope' + n + '.tex' }));
    };
    await runAgentLoop({
      channel, messages: [{ role: 'user', content: 'go' }], system: 's', docHeader: 'd', doc: '', summaryHeader: 'sum',
      budget: 6000, maxSteps: 12, keepResults: 9,
      execute: async () => { ran++; return { ok: false, result: '未找到文件', code: 'file_not_found' }; },
      onUpdate: l => lists.push(l),
    });
    globalThis.fetch = realFetch;
    assert.equal(ran, 3, '三步无推进即熔断：' + ran);
    assert.ok(lists[lists.length - 1].some(m => m.kind === 'agent-limit' && /熔断/.test(m.content)),
      '熔断原因要写进收口提示');
  }
}

/* ---------- 计划块：状态归框架持有，快照在子任务完成时打，跑偏改动被拦 ---------- */
{
  const seq = [
    { tool: 'set_plan', args: { goal: '修完 main.tex 的语法', steps: [
      { title: '读原文', deliverable: 'main.tex 的当前正文', done_when: 'read_file 成功' },
      { title: '改第一行', deliverable: 'main.tex 第一行的替换文本', done_when: 'edit_file 成功', deps: [1] },
    ] } },
    { tool: 'update_plan', args: { step: 2, status: 'doing' } },        // 前置 1 未完成 → 拒
    { tool: 'update_plan', args: { step: 1, status: 'doing' } },
    { tool: 'read_file', args: { path: 'main.tex' } },
    { tool: 'update_plan', args: { step: 1, status: 'done' } },
    { tool: 'update_plan', args: { step: 2, status: 'doing' } },        // 现在才允许
    { tool: 'edit_file', args: { old_text: 'a', new_text: 'b' } },      // 落点 main.tex，计划里出现过
    { tool: 'edit_file', args: { path: 'secret.tex', old_text: 'x', new_text: 'y' } },  // 跑偏
    { tool: 'update_plan', args: { step: 2, status: 'done' } },         // 触发快照
  ];
  let n = 0;
  const ran = [];
  const requests = [];
  const lists = [];
  const tasks = [];
  globalThis.fetch = async (u, opts) => {
    requests.push(JSON.parse(opts.body).messages);
    const c = seq[n++];
    if (!c) return sseResponse('全部完成。');
    return sseResponse('```tool\n' + JSON.stringify(c) + '\n```');
  };
  const { task } = await runAgentLoop({
    channel, messages: [{ role: 'user', content: '修完 main.tex 的语法' }],
    system: 's', docHeader: 'd', doc: '', summaryHeader: 'sum',
    budget: 8000, maxSteps: 14, keepResults: 9, plan: true,
    activePath: () => 'main.tex',
    onTask: t => tasks.push(t),
    execute: async (name, args) => {
      ran.push(name + ':' + (args.path || ''));
      if (name === 'edit_file') return { ok: true, result: '已替换', file: args.path || 'main.tex', versionId: 'ver-1' };
      return { ok: true, result: '正文' };
    },
    onUpdate: l => lists.push(l),
  });
  globalThis.fetch = realFetch;

  assert.equal(ran.filter(x => /^(set_plan|update_plan)/.test(x)).length, 0, '计划类动作不进文件执行器');
  assert.deepEqual(ran, ['read_file:main.tex', 'edit_file:'], '跑偏的 edit_file 没被执行');

  const last = lists[lists.length - 1];
  const rec = last.filter(m => m.kind === 'tool-result');
  assert.ok(rec.some(m => m.tool === 'update_plan' && !m.ok && /前置/.test(m.content)), '前置未完成要拒绝开工');
  assert.ok(rec.some(m => m.tool === 'set_plan' && m.ok && /计划已登记/.test(m.content)), '计划登记成功');
  assert.ok(rec.some(m => /已存快照/.test(m.content)), '子任务完成要打快照');
  assert.ok(rec.some(m => !m.ok && /与当前子任务无关/.test(m.content)), '跑偏改动被拦并说明原因');

  // 请求侧带的是结构化状态而不是整段历史重述
  const briefs = requests.map(ms => ms.map(m => m.content).join('\n'));
  assert.ok(briefs[5].includes('任务目标'), '简报要有目标锚定');
  assert.ok(briefs[5].includes('完成判定'), '简报要带上当前子任务的交付物与完成判定');
  assert.ok(briefs[8].includes('1/2 完成'), '简报里的进度由框架统计（跑到第 9 个动作时）');
  assert.ok(briefs[9].includes('2/2 完成'), '子任务全部标记完成后进度才进位');

  const view = tasks[tasks.length - 1];
  assert.equal(view.phase, 'completed');
  assert.deepEqual(view.steps.map(s => s.status), ['done', 'done']);
  assert.equal(view.snapshots.length, 1, '只有改了文件的那一步留下快照');
  assert.deepEqual(view.snapshots[0].files, { 'main.tex': 'ver-1' }, '快照存的是改前版本 id');
  assert.equal(view.counters.blocked, 1, '拦下过一次跑偏');
  assert.equal(task.doneSteps.length, 2);
  assert.equal(task.touched.join(','), 'main.tex', '被拦下的落点不该记进已改动清单');
}

console.log('agentRuntime: all tests passed');

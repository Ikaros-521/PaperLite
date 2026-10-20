/**
 * Agent 执行循环：mock 一个 OpenAI 兼容 SSE 接口，钉住「工具调用 → 执行 → 结果回传 → 终答」
 * 的多步行为，以及 UI 消息形状（tool-result 卡片数据）与预算管线（tool-result 按普通
 * user 消息进入 buildPayload）。
 */
import assert from 'node:assert/strict';
import { runAgentLoop, agentSystemPrompt, loadAgentSettings, saveAgentSettings, AGENT_TOOLS_PER_STEP, AGENT_WRITES_PER_RUN } from '../src/workspace/agentRuntime.js';
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
assert.deepEqual(loadAgentSettings(), { maxSteps: 50, keepResults: 1, approval: 'auto' }, '越界值要钳制到合法区间');
saveAgentSettings({ maxSteps: 12, keepResults: 4, approval: 'ask' });
assert.deepEqual(loadAgentSettings(), { maxSteps: 12, keepResults: 4, approval: 'ask' }, '合法值要原样读回');
saveAgentSettings({ approval: 'yolo-full-access' });
assert.equal(loadAgentSettings().approval, 'auto', '野档位回默认档，不能因为拼错就变成完全访问');
memStore['paperlite.agentSettings.v1'] = '{oops';
assert.deepEqual(loadAgentSettings(), { maxSteps: 15, keepResults: 5, approval: 'auto' }, '损坏数据回退默认值');
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

console.log('agentRuntime: all tests passed');

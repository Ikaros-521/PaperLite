/**
 * 渠道层安全面：Base URL 校验、重定向策略、SSE 收尾。
 * 这些都关系到 API Key 会不会离开本机、坏服务端能不能把标签页拖死。
 */
import assert from 'node:assert/strict';
import { chat, fetchModels, testConnection, baseUrlProblem, thinkingSwitch, loadChannels, saveChannels, newChannel, PLATFORM_PRESETS } from '../src/llm.js';
import { setLang } from '../src/i18n.js';

setLang('zh');
const realFetch = globalThis.fetch;
const okJson = obj => ({ ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(obj), json: async () => obj });
let seen = [];

// ---- Base URL：漏写协议会被解析成同源相对路径，Key 就发给托管本站的服务器 ----
assert.equal(baseUrlProblem('https://api.deepseek.com/v1'), '');
assert.equal(baseUrlProblem('http://localhost:8788/v1'), '', '本机 http 渠道要放行');
for (const bad of ['api.openai.com/v1', '//evil.test/v1', 'javascript:alert(1)', 'data:text/plain,x', 'ftp://h/v1', '']) {
  assert.notEqual(baseUrlProblem(bad), '', '应拒绝：' + bad);
}

// ---- 每个请求都不许跟重定向：跨源 302 只剥 Authorization，x-api-key 是原样转发的 ----
globalThis.fetch = async (u, opts) => {
  seen.push({ u, redirect: opts.redirect, headers: opts.headers, signal: opts.signal });
  return okJson({ choices: [{ message: { content: 'ok', reasoning_content: '' } }], usage: null });
};
const openaiCh = { protocol: 'openai', baseUrl: 'https://x.test/v1', chatModel: 'm', apiKey: 'k' };
const anthropicCh = { protocol: 'anthropic', baseUrl: 'https://x.test', chatModel: 'm', apiKey: 'k' };
await chat(openaiCh, [{ role: 'user', content: 'hi' }], { stream: false });
assert.equal(seen[0].redirect, 'error', 'OpenAI 路径不跟重定向');
assert.equal(seen[0].headers.Authorization, 'Bearer k');
await chat(anthropicCh, [{ role: 'user', content: 'hi' }], { stream: false });
assert.equal(seen[1].u, 'https://x.test/v1/messages', 'Anthropic 自动补 /v1');
assert.equal(seen[1].redirect, 'error', 'Anthropic 路径同样不跟重定向');
assert.equal(seen[1].headers['x-api-key'], 'k');
await fetchModels(openaiCh);
assert.equal(seen[2].redirect, 'error', '拉模型列表也不跟重定向');
assert.ok(seen[2].signal, '拉模型列表要带超时 signal，否则挂起的端点把「测试连接」永久钉在转圈上');

// 明文 http 只放行本机回环：远程主机走 http 时 Key 与整篇文稿都是过网裸奔
assert.equal(baseUrlProblem('http://127.0.0.1:1234/v1'), '', 'LM Studio 这类本机明文要放行');
assert.equal(baseUrlProblem('http://[::1]:11434/v1'), '', 'IPv6 回环同样放行');
for (const bad of ['http://evil.example.com/v1', 'http://10.0.0.5:8000/v1']) {
  assert.notEqual(baseUrlProblem(bad), '', '远程明文应拒绝：' + bad);
}
seen = [];
await assert.rejects(chat({ ...openaiCh, baseUrl: 'http://evil.example.com/v1' }, [{ role: 'user', content: 'hi' }], { stream: false }));
assert.equal(seen.length, 0, '远程明文渠道一个字节都不该发出去');

// URL 不合法时一个字节都不该发出去
seen = [];
await assert.rejects(chat({ ...openaiCh, baseUrl: 'api.openai.com/v1' }, [{ role: 'user', content: 'hi' }], { stream: false }), /http/);
assert.equal(seen.length, 0, '校验失败不该已经发出请求');

// ---- SSE：抛错也要关掉读流，否则连接一直挂在那儿 ----
{
  let cancelled = false;
  const chunk = new TextEncoder().encode('data: {"type":"message_start","message":{"usage":{}}}\n\n'
    + 'data: {"type":"error","error":{"message":"上游炸了"}}\n\n');
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: new Map(),
    body: {
      getReader: () => {
        let sent = 0;
        return { read: async () => (sent++ ? { done: true } : { done: false, value: chunk }), cancel: async () => { cancelled = true; } };
      },
    },
  });
  await assert.rejects(chat(anthropicCh, [{ role: 'user', content: 'hi' }], { stream: true }), /上游炸了/);
  assert.equal(cancelled, true, '异常路径必须 cancel 读流');
}

// ---- 正常流式：正文与思维链按 delta 累积，[DONE] 不进气泡 ----
{
  const body = new TextEncoder().encode(
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'
    + 'data: {"choices":[{"delta":{"reasoning_content":"想想"}}]}\n\n'
    + 'data: 坏 JSON 该行被忽略\n\n'
    + 'data: {"choices":[{"delta":{"content":"，世界"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n'
    + 'data: [DONE]\n\n');
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Map(), body: { getReader: () => {
    let sent = 0;
    return { read: async () => (sent++ ? { done: true } : { done: false, value: body }), cancel: async () => {} };
  } } });
  let streamed = '';
  const res = await chat(openaiCh, [{ role: 'user', content: 'hi' }], { stream: true, onDelta: d => { streamed += d; } });
  assert.equal(res.content, '你好，世界', '跨块的正文按顺序拼好');
  assert.equal(res.reasoning, '想想');
  assert.equal(streamed, '你好，世界', 'onDelta 与返回值一致');
  assert.deepEqual(res.usage, { input: 3, output: 2, cached: 0 });
  assert.equal(res.incomplete, false, '收到 [DONE] 才算完整');
}

// ---- SSE 没有结束标记：必须标记 incomplete，不能当完整回答 ----
{
  const body = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"半截"}}]}\n\n');
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Map(), body: { getReader: () => {
    let sent = 0;
    return { read: async () => (sent++ ? { done: true } : { done: false, value: body }), cancel: async () => {} };
  } } });
  const res = await chat(openaiCh, [{ role: 'user', content: 'hi' }], { stream: true });
  assert.equal(res.content, '半截');
  assert.equal(res.incomplete, true, '没有 [DONE]/finish_reason 要提示未完整');
}

// ---- 只发 finish_reason 也算完整收尾（兼容不吐 [DONE] 的网关） ----
{
  const body = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"完整"},"finish_reason":"stop"}]}\n\n');
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Map(), body: { getReader: () => {
    let sent = 0;
    return { read: async () => (sent++ ? { done: true } : { done: false, value: body }), cancel: async () => {} };
  } } });
  const res = await chat(openaiCh, [{ role: 'user', content: 'hi' }], { stream: true });
  assert.equal(res.content, '完整');
  assert.equal(res.incomplete, false, 'finish_reason 本身就是结束标记');
}

// ---- Anthropic 的 message_stop 同样是结束标记 ----
{
  const body = new TextEncoder().encode(
    'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n'
    + 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"收到"}}\n\n'
    + 'data: {"type":"message_stop"}\n\n');
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Map(), body: { getReader: () => {
    let sent = 0;
    return { read: async () => (sent++ ? { done: true } : { done: false, value: body }), cancel: async () => {} };
  } } });
  const res = await chat(anthropicCh, [{ role: 'user', content: 'hi' }], { stream: true });
  assert.equal(res.content, '收到');
  assert.equal(res.incomplete, false, 'message_stop 后不报截断');
}

// ---- 非流式坏 JSON：给一句人话而不是 SyntaxError ----
{
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Map(), text: async () => '<html>网关挂了</html>' });
  await assert.rejects(chat(openaiCh, [{ role: 'user', content: 'hi' }], { stream: false }), /JSON/);
}

// ---- 思维链开关要真的落到请求上：不勾选时对支持的渠道显式请求关闭推理 ----
{
  const bodies = [];
  globalThis.fetch = async (u, opts) => {
    bodies.push(JSON.parse(opts.body));
    return okJson({ choices: [{ message: { content: 'ok' } }] });
  };
  const think = (model, cot, opts = {}) => chat({ ...openaiCh, chatModel: model, cot },
    [{ role: 'user', content: 'hi' }], { stream: false, ...opts });

  await think('glm-4.5', false);
  assert.deepEqual(bodies[0].thinking, { type: 'disabled' }, 'GLM-4.5 默认思考，关的时候要发显式关闭字段');
  await think('qwen3-30b', false);
  assert.equal(bodies[1].enable_thinking, false, 'Qwen3 走 enable_thinking');
  await think('deepseek-r1', false);
  assert.equal(bodies[2].enable_thinking, undefined, 'R1 没有可关的开关，不发假字段');
  assert.equal(bodies[2].thinking, undefined);
  await think('gpt-4o', false);
  assert.deepEqual([bodies[3].thinking, bodies[3].enable_thinking], [undefined, undefined], '普通模型什么都不加');
  await think('glm-4.5', true);
  assert.equal(bodies[4].thinking, undefined, '勾选启用时不能同时发关闭字段');
  assert.ok(String(bodies[4].messages[0].content).includes('推理'), '启用时带思维链引导的系统提示');
  await think('qwen3-30b', false, { noReasoning: true });
  assert.equal(bodies[5].enable_thinking, false, '摘要这类机械任务也走同一条关闭路径');
  // noReasoning 要连 system 提示一起关：只关 thinking 字段、仍注入“逐步推理”等于没关
  await think('glm-4.5', true, { noReasoning: true });
  assert.deepEqual(bodies[6].thinking, { type: 'disabled' }, 'noReasoning 仍显式关闭推理');
  assert.ok(!bodies[6].messages.some(m => m.role === 'system' && /推理/.test(m.content)), 'noReasoning 不该再注入思维链系统提示');

  // 开关识别与界面口径一致
  assert.equal(thinkingSwitch('glm-4.5'), 'thinking');
  assert.equal(thinkingSwitch('GLM-Z1-Air'), 'thinking');
  assert.equal(thinkingSwitch('qwen3-235b-a22b'), 'enable_thinking');
  assert.equal(thinkingSwitch('deepseek-r1'), null, 'R1 属于「无法关闭」，界面要如实说明');
  assert.equal(thinkingSwitch('gpt-4o'), null);
}

// ---- 不认关闭字段的网关：400 后去掉可选字段重试一次，而不是整条请求失败 ----
{
  let n = 0;
  globalThis.fetch = async (u, opts) => {
    n++;
    const body = JSON.parse(opts.body);
    if (n === 1 && body.enable_thinking !== undefined) {
      return { ok: false, status: 400, headers: new Map(), text: async () => 'unknown field enable_thinking' };
    }
    seen.push(body);
    return okJson({ choices: [{ message: { content: '重试成功' } }] });
  };
  const r = await chat({ ...openaiCh, chatModel: 'qwen3-30b', cot: false }, [{ role: 'user', content: 'hi' }], { stream: false });
  assert.equal(r.content, '重试成功', '降级重试照常出结果');
  assert.equal(n, 2, '一次 400 一次重试');
  assert.equal(seen[seen.length - 1].enable_thinking, undefined, '重试时把可选扩展字段去掉');
}

// ---- 测试连接不能只看 /models：Anthropic 协议必须真打 /v1/messages ----
{
  const calls = [];
  globalThis.fetch = async (u, opts) => {
    calls.push({ u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (u.endsWith('/models')) return okJson({ data: [{ id: 'claude-x' }] });
    return okJson({ type: 'message', content: [{ type: 'text', text: 'pong' }], usage: { input_tokens: 1, output_tokens: 1 } });
  };
  const r = await testConnection({ ...anthropicCh, cot: true });
  assert.equal(r.ok, true);
  const m = calls.filter(c => c.u.endsWith('/messages'))[0];
  assert.ok(m, 'Anthropic 协议测试必须真的请求 /v1/messages');
  assert.equal(m.method, 'POST');
  assert.equal(m.body.max_tokens, 5, '测试用最小对话');
  assert.equal(m.body.thinking, undefined, '测试连接不能启用 thinking 预算');
}

// ---- /models 200 + 空列表不能当成功：再真打一次最小对话 ----
{
  let chatCalls = 0;
  globalThis.fetch = async (u) => {
    if (String(u).endsWith('/models')) return okJson({ data: [] });
    chatCalls++;
    return okJson({ choices: [{ message: { content: 'pong' } }] });
  };
  const r = await testConnection({ ...openaiCh, baseUrl: 'https://x.test/v1' });
  assert.equal(r.ok, true);
  assert.equal(chatCalls, 1, '空模型列表必须真打一次对话');
  globalThis.fetch = async (u) => String(u).endsWith('/models')
    ? okJson({ data: [] })
    : { ok: false, status: 500, headers: new Map(), text: async () => 'boom' };
  const bad = await testConnection({ ...openaiCh, baseUrl: 'https://x.test/v1' });
  assert.equal(bad.ok, false, '列表为空且对话失败时必须报红');
}

// ---- 200 里裹着业务错误也要报出来（智谱 Anthropic /models 实测行为） ----
{
  globalThis.fetch = async () => okJson({ code: 401, msg: '令牌已过期或验证不正确', success: false });
  await assert.rejects(fetchModels(anthropicCh), /令牌已过期/);
  // code:1 这类成功码不能被误判，空列表照常返回
  globalThis.fetch = async () => okJson({ code: 1, data: [] });
  assert.deepEqual(await fetchModels(anthropicCh), []);
}

// ---- /models 成功不能掩盖 /v1/messages 失败 ----
{
  globalThis.fetch = async (u) => {
    if (u.endsWith('/models')) return okJson({ data: [{ id: 'claude-x' }] });
    return { ok: false, status: 403, headers: new Map(), text: async () => 'CORS blocked' };
  };
  const r = await testConnection(anthropicCh);
  assert.equal(r.ok, false, '模型列表成功不代表真正对话可用');
  assert.match(r.msg, /403/);
}

globalThis.fetch = realFetch;

// ---- 深度思考默认开启：新建渠道直接 true，存量渠道只翻一次 ----
{
  const store = new Map();
  store.set('paperlite.llm.channels.v1', JSON.stringify([{ id: 'a', protocol: 'openai', baseUrl: 'https://x.test/v1', chatModel: 'm', cot: false }]));
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const first = loadChannels();
  assert.equal(first[0].cot, true, '首次加载把存量渠道翻成开启');
  saveChannels(first);
  assert.equal(loadChannels()[0].cot, true, '应用侧回写后（App 的保存效果），重启仍是开启');
  saveChannels([{ ...first[0], cot: false }]);
  assert.equal(loadChannels()[0].cot, false, '迁移只发生一次：用户手动关掉后不会再被启动翻回来');
  assert.equal(newChannel().cot, true, '新建渠道默认开启深度思考');
  delete globalThis.localStorage;
}

// ---- 非流式响应体也要「边读边限」：先 await r.text() 再比长度等于已经整块缓冲完才拒 ----
{
  let cancelled = false;
  const big = new Uint8Array(9 * 1024 * 1024);
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: new Map(),
    body: { getReader: () => {
      let sent = 0;
      return { read: async () => (sent++ ? { done: true } : { done: false, value: big }), cancel: async () => { cancelled = true; } };
    } },
  });
  await assert.rejects(chat(openaiCh, [{ role: 'user', content: 'hi' }], { stream: false }), /过大|too large/);
  assert.equal(cancelled, true, '超限路径关掉读流');
  // 错误体同样受限：坏网关可以用一整页 HTML 把标签页撑满
  globalThis.fetch = async () => ({
    ok: false, status: 500, headers: new Map(),
    body: { getReader: () => {
      let sent = 0;
      return { read: async () => (sent++ ? { done: true } : { done: false, value: big }), cancel: async () => {} };
    } },
  });
  await assert.rejects(chat(openaiCh, [{ role: 'user', content: 'hi' }], { stream: false }));
  globalThis.fetch = realFetch;
}

// ---- Coding Plan 预设必须走第三方工具的独立端点 ----
{
  const zc = PLATFORM_PRESETS.find(p => p.id === 'zhipu-coding');
  assert.ok(zc && zc.protocol === 'openai' && zc.baseUrl === 'https://open.bigmodel.cn/api/coding/paas/v4', '智谱 Coding Plan 用 OpenAI 兼容的 coding 端点');
  const mm = PLATFORM_PRESETS.find(p => p.id === 'minimax-coding');
  assert.ok(mm && mm.protocol === 'openai' && mm.baseUrl === 'https://api.minimax.cn/v1', 'MiniMax Coding Plan 预设');
}

console.log('LLM channel: base URL validation, redirect policy on every path, SSE cancel-on-error and delta parsing passed.');

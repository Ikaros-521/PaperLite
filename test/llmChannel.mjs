/**
 * 渠道层安全面：Base URL 校验、重定向策略、SSE 收尾。
 * 这些都关系到 API Key 会不会离开本机、坏服务端能不能把标签页拖死。
 */
import assert from 'node:assert/strict';
import { chat, fetchModels, baseUrlProblem, thinkingSwitch } from '../src/llm.js';
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
  seen.push({ u, redirect: opts.redirect, headers: opts.headers });
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

globalThis.fetch = realFetch;
console.log('LLM channel: base URL validation, redirect policy on every path, SSE cancel-on-error and delta parsing passed.');

/**
 * 渠道层安全面：Base URL 校验、重定向策略、SSE 收尾。
 * 这些都关系到 API Key 会不会离开本机、坏服务端能不能把标签页拖死。
 */
import assert from 'node:assert/strict';
import { chat, fetchModels, baseUrlProblem } from '../src/llm.js';
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

globalThis.fetch = realFetch;
console.log('LLM channel: base URL validation, redirect policy on every path, SSE cancel-on-error and delta parsing passed.');

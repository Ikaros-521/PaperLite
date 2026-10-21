/* PaperLite · LLM 多渠道接入（OpenAI 兼容协议 + Anthropic Claude 协议）
 * 渠道配置存 localStorage；支持流式对话（含思维链 reasoning/thinking）、
 * 嵌入检索（可选检索模型）、模型列表拉取、内置平台预设、测试连接。
 * 用户可见消息经 i18n 模块级 t() 输出（App 渲染时同步当前语言）。
 */
import { t, getLang } from './i18n.js';

const LS_KEY = 'paperlite.llm.channels.v1';
// 「深度思考」默认值从关改成开，对存量渠道只做一次迁移；标记先落盘，
// 用户之后手动关掉就不会每次启动被翻回来
const COT_DEFAULT_KEY = 'paperlite.llm.cotDefault.v1';

// ---------------- 协议与平台预设 ----------------

export const PROTOCOLS = [
  { id: 'openai', label: 'OpenAI 兼容', labelEn: 'OpenAI-compatible', desc: 'OpenAI / DeepSeek / GLM / 通义 / Kimi / Ollama 等' },
  { id: 'anthropic', label: 'Anthropic (Claude)', desc: 'Claude 官方 API 及 Claude 协议网关' }
];

export function protocolOf(channel) {
  return channel && channel.protocol === 'anthropic' ? 'anthropic' : 'openai';
}

// 内置常用平台：选预设自动填 Base URL / 协议 / 常用模型（模型仅供参考，可手输或拉取列表）
export const PLATFORM_PRESETS = [
  { id: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini', 'text-embedding-3-small', 'text-embedding-3-large'] },
  { id: 'anthropic', name: 'Anthropic Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5', 'claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest'] },
  { id: 'deepseek', name: 'DeepSeek 深度求索', nameEn: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'zhipu', name: '智谱 GLM', nameEn: 'Zhipu GLM', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.5', 'glm-4.5-air', 'glm-4-plus', 'glm-4-flash', 'embedding-3'] },
  // Coding Plan 走独立端点，Anthropic 端点只给 Claude Code，第三方工具用会报 1113
  { id: 'zhipu-coding', name: '智谱 GLM Coding Plan', nameEn: 'Zhipu GLM Coding Plan', protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', models: ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flash[1m]'] },
  { id: 'qwen', name: '通义千问 Qwen', nameEn: 'Alibaba Qwen', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long', 'text-embedding-v3'] },
  { id: 'moonshot', name: 'Kimi (月之暗面)', nameEn: 'Kimi (Moonshot)', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0905-preview', 'kimi-latest', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  { id: 'minimax-coding', name: 'MiniMax Coding Plan', protocol: 'openai', baseUrl: 'https://api.minimax.cn/v1',
    models: ['MiniMax-M3.1-Flash'] },
  { id: 'siliconflow', name: '硅基流动 SiliconFlow', nameEn: 'SiliconFlow', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct', 'BAAI/bge-m3'] },
  { id: 'openrouter', name: 'OpenRouter 聚合', nameEn: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openai/gpt-4o', 'anthropic/claude-sonnet-4.5', 'google/gemini-2.0-flash-001', 'deepseek/deepseek-chat'] },
  { id: 'ollama', name: 'Ollama（本机）', nameEn: 'Ollama (local)', protocol: 'openai', baseUrl: 'http://localhost:11434/v1',
    models: ['qwen2.5', 'llama3.1', 'deepseek-r1'] },
  { id: 'lmstudio', name: 'LM Studio（本机）', nameEn: 'LM Studio (local)', protocol: 'openai', baseUrl: 'http://localhost:1234/v1', models: [] },
  { id: 'mock', name: 'PaperLite Mock（本机演示）', nameEn: 'PaperLite Mock (local demo)', protocol: 'openai', baseUrl: 'http://localhost:8788/v1',
    models: ['paperlite-mock', 'paperlite-mock-pro', 'paperlite-mock-embed'] }
];

// 按当前协议 + Base URL 反查命中的预设（用于回显预设下拉、提供候选模型）
export function matchPreset(channel) {
  const base = String(channel.baseUrl || '').replace(/\/+$/, '');
  return PLATFORM_PRESETS.find(p => p.protocol === protocolOf(channel) && p.baseUrl === base) || null;
}

// ---------------- 渠道存取 ----------------

// 采样温度归一：空/非法 → null（不发送该参数）；否则夹到 0–2
export function normTemperature(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(2, Math.max(0, n)) : null;
}

// 实际发送的温度：请求级 opts 优先，其次渠道配置，都没有则 undefined（跟随模型默认）
function resolveTemperature(channel, opts) {
  if (opts && opts.temperature !== undefined && opts.temperature !== null) return opts.temperature;
  const ct = channel && channel.temperature;
  return ct === null || ct === undefined ? undefined : ct;
}

export function loadChannels() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    if (!Array.isArray(arr)) return [];
    let migrateCot = false;
    try {
      if (!localStorage.getItem(COT_DEFAULT_KEY)) {
        localStorage.setItem(COT_DEFAULT_KEY, '1');
        migrateCot = true;
      }
    } catch (e) { /* 存储写不进去就不迁移：否则每次启动都会盖掉用户手动关掉的开关 */ }
    return arr.map(c => {
      const next = {
        ...c,
        protocol: c.protocol === 'anthropic' ? 'anthropic' : 'openai',
        // 0 = 按模型自动推断窗口；旧版按字符的 contextLimit 已废弃
        ctxWindow: +c.ctxWindow || 0,
        // 采样温度：null = 不发送该参数、跟随模型默认（GLM 等思考模型只接受特定值，留空最稳）
        temperature: normTemperature(c.temperature)
      };
      delete next.contextLimit;
      if (migrateCot && !next.cot) next.cot = true;
      return next;
    });
  } catch (e) { return []; }
}
export function saveChannels(list) {
  // 配额满/隐私模式下保存会抛：静默吞掉等于让用户改的渠道与 API Key 无声丢失，
  // 至少留一条 console 证据供排查（UI 侧无独立保存按钮可挂提示）
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); }
  catch (e) { console.warn('[paperlite] 渠道配置保存失败（localStorage 不可用或已满）：', e); }
}
export function newChannel() {
  return {
    id: 'ch-' + Date.now().toString(36),
    name: t('llm.newChannel'),
    protocol: 'openai',
    baseUrl: 'http://localhost:8788/v1',
    apiKey: '',
    chatModel: 'paperlite-mock',
    embedModel: '',
    // 深度思考默认开启：机械类请求（摘要、批量校对）自己带 noReasoning 关掉，不受这里影响
    cot: true,
    temperature: null,
    ctxWindow: 0
  };
}

// ---------------- URL / 请求头 ----------------

/** Base URL 必须是带协议的绝对 http(s) 地址。漏写协议（api.openai.com/v1）会被解析成
 *  同源相对路径，Bearer / x-api-key 就原样发给托管本站的服务器了；javascript:、data:
 *  之类同理挡掉。返回 '' 表示没问题，否则是一条可以直接显示的文案。
 *  明文 http 只放行本机回环：Ollama / LM Studio / 伴随服务都是本地明文，
 *  而远程主机走 http 时 Key 与整篇文稿都是过网裸奔，https 没有理由省。 */
const LOCAL_HTTP_HOSTS = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/i;
export function baseUrlProblem(base) {
  const s = String(base || '').trim();
  if (!s) return t('llm.needBaseUrl');
  let u;
  try { u = new URL(s); } catch (e) { return t('llm.badBaseUrl'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return t('llm.badBaseUrl');
  if (!u.hostname) return t('llm.badBaseUrl');
  if (u.protocol === 'http:' && !LOCAL_HTTP_HOSTS.test(u.hostname)) return t('llm.httpLocalOnly');
  return '';
}

function checkedBase(channel) {
  const base = String(channel.baseUrl || '').replace(/\/+$/, '');
  const problem = baseUrlProblem(base);
  if (problem) throw new Error(problem);
  return base;
}

function url(channel, path) {
  return checkedBase(channel) + path;
}
// Anthropic：Base URL 视为服务根（自动补 /v1，已带 /v1 则直接拼）
function anthropicUrl(channel, name) {
  let base = checkedBase(channel);
  if (!/\/v1$/.test(base)) base += '/v1';
  return base + '/' + name;
}
function headers(channel) {
  if (protocolOf(channel) === 'anthropic') {
    return {
      'Content-Type': 'application/json',
      ...(channel.apiKey ? { 'x-api-key': channel.apiKey } : {}),
      'anthropic-version': '2023-06-01',
      // 官方 API 默认拒绝浏览器 CORS，需显式声明允许浏览器直连
      'anthropic-dangerous-direct-browser-access': 'true'
    };
  }
  return {
    'Content-Type': 'application/json',
    ...(channel.apiKey ? { Authorization: 'Bearer ' + channel.apiKey } : {})
  };
}

// 一次性请求的默认超时：挂起的端点会把「测试连接」永久钉在转圈上，关掉弹窗也撤不掉。
// 对话流不能套总超时（长回答本来就要几十秒），所以只给这类短请求兜底。
const ONESHOT_TIMEOUT_MS = 20000;
function timeoutSignal(explicit) {
  if (explicit) return explicit;
  return typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ONESHOT_TIMEOUT_MS) : undefined;
}

// ---------------- 模型列表 ----------------

// 拉取渠道可用模型（兼容 {data:[{id}]} / {models:[…]} / [string] 等常见返回）
export async function fetchModels(channel, opts = {}) {
  const u = protocolOf(channel) === 'anthropic'
    ? anthropicUrl(channel, 'models')
    : url(channel, '/models');
  const signal = timeoutSignal(opts.signal);
  // redirect:'error'：跨源重定向只剥 Authorization/Cookie，自定义头（Anthropic 的
  // x-api-key）是原样转发的——跟着 302 走就等于把 Key 交给重定向目标
  const r = await fetch(u, { headers: headers(channel), redirect: 'error', signal });
  if (!r.ok) throw new Error('HTTP ' + r.status + '：' + (await cappedText(r).catch(() => '')).slice(0, 160));
  // 上限走 cappedText：模型列表端点没有理由比对话响应更值得信任，r.json() 是整块缓冲
  const j = await readJson(r);
  const arr = (j && (j.data || j.models)) || (Array.isArray(j) ? j : []);
  const ids = arr
    .map(m => (typeof m === 'string' ? m : (m && (m.id || m.name || m.model))))
    .filter(Boolean);
  // 网关可能 HTTP 200 裹着业务错误（智谱 Anthropic 的 /models 对无效 Key
  // 回 200 + {code:401,msg}）；只判 r.ok 会让「获取模型 / 测试连接」假绿
  if (!ids.length) {
    const msg = apiErrorMessage(j);
    if (msg) throw new Error(msg.slice(0, 160));
  }
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

// 常见错误体：{error:{message}} / {success:false,msg} / {code:非200,msg}
function apiErrorMessage(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return '';
  const e = j.error;
  if (e) {
    if (typeof e === 'string') return e;
    if (e.message) return String(e.message);
    if (e.code) return String(e.code);
  }
  if (j.success === false) return String(j.msg || j.message || j.code || '');
  if (j.code !== undefined && j.code !== null && j.code !== '') {
    const code = Number(j.code);
    // 数字只认 4xx/5xx；非数字只放过常见的成功词，避免把 code:1 这类成功码当错误
    if (Number.isFinite(code) ? code >= 400 : !/^(ok|success|succeed|true)$/i.test(String(j.code))) {
      return String(j.msg || j.message || ('code ' + j.code));
    }
  }
  return '';
}

// ---------------- 测试连接 ----------------

// Anthropic 的 /models 只证明列表接口可达，真正对话走 /v1/messages；
// 网关可能只给列表配了 CORS（智谱就是这样），所以必须真发一次最小对话。
// OpenAI 兼容路径优先 /models，失败或返回空列表时再发一条极短对话：
// 无效 Key 被网关包成 200 + data:[] 时，只看列表会把测试连接判绿。
export async function testConnection(channel, opts = {}) {
  try {
    if (protocolOf(channel) === 'anthropic') {
      await chat(channel, [{ role: 'user', content: 'ping' }], {
        maxTokens: 5, noReasoning: true, signal: timeoutSignal(opts.signal)
      });
      let ids = [], listErr = '';
      try { ids = (await fetchModels(channel, opts)).slice(0, 5); }
      catch (e) { listErr = e.message || String(e); }
      if (!ids.length && listErr) return { ok: true, msg: t('llm.okChatOnly', { msg: listErr }) };
      return { ok: true, msg: ids.length ? t('llm.ok', { models: t('llm.okModels', { models: ids.join(getLang() === 'en' ? ', ' : '、') }) }) : t('llm.ok', { models: '' }) };
    }
    let ids = [];
    try {
      ids = (await fetchModels(channel, opts)).slice(0, 5);
    } catch (e) {
      await chat(channel, [{ role: 'user', content: 'ping' }], { maxTokens: 5, signal: timeoutSignal(opts.signal) });
      return { ok: true, msg: t('llm.okChatOnly', { msg: e.message || e }) };
    }
    if (!ids.length) {
      // 200 + 空列表不等于可用：真发一条最小对话，失败会走外层 catch 判红
      await chat(channel, [{ role: 'user', content: 'ping' }], { maxTokens: 5, signal: timeoutSignal(opts.signal) });
      return { ok: true, msg: t('llm.ok', { models: '' }) };
    }
    return { ok: true, msg: t('llm.ok', { models: t('llm.okModels', { models: ids.join(getLang() === 'en' ? ', ' : '、') }) }) };
  } catch (e) {
    return { ok: false, msg: t('llm.fail', { msg: e.message || e }) };
  }
}

// ---------------- 对话 ----------------

function chatOpenAI(channel, messages, opts) {
  const body = {
    model: channel.chatModel || 'gpt-3.5-turbo',
    messages,
    stream: !!opts.stream
  };
  // 流式默认不回计量，需显式声明；个别网关不认识该字段会在解析层降级重试
  if (body.stream) body.stream_options = { include_usage: true };
  // 摘要这类机械任务不需要推理，等价于「明确关到底」
  if (!channel.cot || opts.noReasoning) disableThinking(body);
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  const temp = resolveTemperature(channel, opts);
  if (temp !== undefined) body.temperature = temp;
  // noReasoning 是「连提示词一起关」：只关 thinking 字段、仍塞一段“逐步推理”的
  // system 提示，对摘要/校对这类机械任务等于没关
  if (channel.cot && !opts.noReasoning) {
    body.messages = [
      { role: 'system', content: t('ai.systemCoT') },
      ...body.messages
    ];
  }

  return parseOpenAIStream(url(channel, '/chat/completions'), channel, body, opts);
}

/**
 * 关掉思维链要真的关掉：只加一句「请不要展示推理」关不掉网关默认开启的推理输出
 * （GLM-4.5 / Qwen3 这类是「默认思考」模型，reasoning_content 照样回来），
 * 所以这里按模型家族发对应家族的显式关闭字段。
 * @returns {'thinking'|'enable_thinking'|null} 用哪个字段关的；null 表示这个模型
 *   没有可关的开关（DeepSeek-R1 这类只会思考），界面要如实说明而不是假装关掉了。
 */
export function thinkingSwitch(model) {
  const m = String(model || '');
  if (/glm-4\.5|glm-z1|glm4\.5|glm-5/i.test(m)) return 'thinking';
  // DashScope 兼容口径：enable_thinking=false；非流式或部分网关不认这个字段，
  // 由 OPTIONAL_FIELDS 的 400 降级重试兜住。DeepSeek-R1 这类「只会思考」的模型不在这里列
  // ——它没有可关的开关，界面要按「无法关闭」如实说明，而不是发一个被忽略的字段
  if (/qwen3|qwq|-thinking/i.test(m)) return 'enable_thinking';
  return null;
}

export function disableThinking(body) {
  const kind = thinkingSwitch(body.model);
  if (kind === 'thinking') body.thinking = { type: 'disabled' };
  else if (kind === 'enable_thinking') body.enable_thinking = false;
  return !!kind;
}

// Anthropic /v1/messages：system 独立传参、角色需交替、max_tokens 必填；思维链映射为 thinking
function chatAnthropic(channel, messages, opts) {
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const rest = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = rest[rest.length - 1];
    if (last && last.role === role) last.content += '\n\n' + m.content;
    else rest.push({ role, content: m.content });
  }
  if (!rest.length) rest.push({ role: 'user', content: 'ping' });

  const body = {
    model: channel.chatModel || 'claude-sonnet-4-5',
    messages: rest,
    max_tokens: opts.maxTokens || 4096,
    stream: !!opts.stream
  };
  if (sys) body.system = sys;
  if (channel.cot && !opts.noReasoning) {
    body.thinking = { type: 'enabled', budget_tokens: 4000 };
    if (body.max_tokens <= 4000) body.max_tokens = 8000;
  } else {
    const temp = resolveTemperature(channel, opts);
    if (temp !== undefined) body.temperature = temp;
  }

  return parseAnthropicStream(anthropicUrl(channel, 'messages'), channel, body, opts);
}

export async function chat(channel, messages, opts = {}) {
  // 统一异常归类，供上层判断「能否重试」；timeoutMs 存在时把超时与外部取消合并到同一个 signal。
  // 只在显式传入 timeoutMs 时才设超时定时器：普通对话是长时间流式，不能被整体掐断。
  const timeoutMs = opts.timeoutMs;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = timeoutMs ? setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs) : null;
  const onExternal = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', onExternal);
  }
  const o = { ...opts, signal: ctrl.signal };
  try {
    return protocolOf(channel) === 'anthropic'
      ? await chatAnthropic(channel, messages, o)
      : await chatOpenAI(channel, messages, o);
  } catch (err) {
    throw normalizeError(err, { timedOut, externallyAborted: !!(opts.signal && opts.signal.aborted) });
  } finally {
    if (timer) clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onExternal);
  }
}

// 把 fetch/SSE 抛出的异常规约为带 code 的错误：cancelled|timeout|rate|server|network|client
// 用户取消仍沿用 name='AbortError'，兼容既有 `e.name !== 'AbortError'` 判断，同时补 code 供队列区分。
function normalizeError(err, { timedOut, externallyAborted }) {
  if (err && err.__llm) return err;               // postJson 已归类（含 status / retryAfterMs）
  if (externallyAborted) {
    const e = new Error(t('llm.cancelled')); e.name = 'AbortError'; e.code = 'cancelled'; e.__llm = true; return e;
  }
  if (err && err.name === 'AbortError') {
    const e = new Error(timedOut ? t('llm.timeout') : t('llm.cancelled'));
    e.code = timedOut ? 'timeout' : 'cancelled'; e.__llm = true;
    if (!timedOut) e.name = 'AbortError';
    return e;
  }
  const e = err instanceof Error ? err : new Error(String(err));
  e.code = 'network'; e.__llm = true;
  return e;
}

// 429 常带 Retry-After(-ms)，优先按服务端建议退避，避免盲重试继续撞限流
function retryAfterMs(headers) {
  try {
    const ms = headers.get('retry-after-ms');
    if (ms) { const n = parseFloat(ms); if (!Number.isNaN(n)) return Math.max(0, Math.round(n)); }
    const s = headers.get('retry-after');
    if (s) {
      const n = parseFloat(s);
      if (!Number.isNaN(n)) return Math.max(0, Math.round(n * 1000));
      const d = Date.parse(s);
      if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
    }
  } catch (e) { /* Headers 不可用则忽略 */ }
  return 0;
}

export function isRetryable(err) {
  const code = err && err.code;
  return code === 'timeout' || code === 'network' || code === 'rate' || code === 'server';
}

// ---- 请求 + 解析（两种协议各自归一化 usage，缺字段时返回 null 由界面降级估算） ----
// stream_options / thinking / enable_thinking 都是可选扩展字段，个别网关不认识会回 400，去掉后重试一次而不是让整个请求失败
const OPTIONAL_FIELDS = ['stream_options', 'thinking', 'enable_thinking'];

async function postJson(u, channel, body, opts) {
  const send = () => fetch(u, {
    method: 'POST', headers: headers(channel), body: JSON.stringify(body), signal: opts.signal, redirect: 'error'
  });
  let r = await send();
  // 判断用「字段存在」而不是「字段为真」：enable_thinking:false 本身就是假值，
  // 用真值判断等于「显式关闭推理的请求一旦 400 就不重试」
  if (!r.ok && r.status === 400 && OPTIONAL_FIELDS.some(f => body[f] !== undefined)) {
    OPTIONAL_FIELDS.forEach(f => { delete body[f]; });
    r = await send();
  }
  if (!r.ok) {
    const text = (await cappedText(r).catch(() => '')).slice(0, 200);
    const e = new Error('HTTP ' + r.status + '：' + text);
    e.status = r.status;
    e.code = r.status === 429 ? 'rate' : (r.status >= 500 || r.status === 408) ? 'server' : 'client';
    e.retryAfterMs = retryAfterMs(r.headers);
    e.__llm = true;
    throw e;
  }
  return r;
}

// 响应体上限：服务端发一条超长 data: 行不该把整个标签页的内存吃掉
const MAX_STREAM_BYTES = 8 * 1024 * 1024;

function bodyOversize() {
  const e = new Error(t('llm.streamTooLarge'));
  e.code = 'client';
  e.__llm = true;
  return e;
}

// SSE 统一从这里读：字节数封顶 + 无论正常收尾还是抛错都 cancel 读流。
// 旧写法在解析抛错时既不 cancel 也不 abort，连接就一直挂着
async function* sseData(r) {
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', seen = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += (value && value.length) || 0;
      if (seen > MAX_STREAM_BYTES) throw bodyOversize();
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const ln = line.trim();
        if (!ln.startsWith('data:')) continue;
        const payload = ln.slice(5).trim();
        if (payload && payload !== '[DONE]') yield payload;
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    throw e;
  } finally {
    try { reader.cancel(); } catch (e) { /* 已经关了 */ }
  }
}

/** 非流式响应：先按上限取文本再解析，坏 JSON 给一句人话而不是 SyntaxError */
async function readJson(r) {
  const text = await cappedText(r);
  try { return JSON.parse(text); }
  catch (e) { const err = new Error(t('llm.badJson')); err.code = 'client'; err.__llm = true; throw err; }
}

/** 带上限地读完整响应体。上限必须在字节进内存之前判：先 await r.text() 再比长度，
 *  等于已经整块缓冲完才拒，恶意/异常网关照样把标签页撑爆。桩对象没有可读流时退回 text()。 */
async function cappedText(r, max = MAX_STREAM_BYTES) {
  const reader = r.body && typeof r.body.getReader === 'function' ? r.body.getReader() : null;
  if (!reader) {
    const text = await r.text();
    if (text.length > max) throw bodyOversize();
    return text;
  }
  const dec = new TextDecoder();
  const parts = [];
  let seen = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += (value && value.length) || 0;
      if (seen > max) throw bodyOversize();
      parts.push(dec.decode(value, { stream: true }));
    }
    parts.push(dec.decode());
    return parts.join('');
  } finally {
    try { reader.cancel(); } catch (e) { /* 已经关了 */ }
  }
}

function openAIUsage(u) {
  if (!u) return null;
  const input = +u.prompt_tokens || 0;
  const output = +u.completion_tokens || 0;
  if (!input && !output) return null;
  return { input, output, cached: +(u.prompt_tokens_details || {}).cached_tokens || 0 };
}
// Anthropic 把缓存命中/写入单列，都算作已占用的输入
function anthropicUsage(u) {
  if (!u) return null;
  const raw = +u.input_tokens || 0;
  const cacheRead = +u.cache_read_input_tokens || 0;
  const cacheWrite = +u.cache_creation_input_tokens || 0;
  const input = raw + cacheRead + cacheWrite;
  const output = +u.output_tokens || 0;
  if (!input && !output) return null;
  return { input, output, cached: cacheRead };
}

// ---- OpenAI 兼容：POST + 解析（含 SSE，delta.content / delta.reasoning_content） ----
async function parseOpenAIStream(u, channel, body, opts) {
  const r = await postJson(u, channel, body, opts);

  if (!body.stream) {
    const j = await readJson(r);
    const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
    return { content: msg.content || '', reasoning: msg.reasoning_content || '', usage: openAIUsage(j.usage) };
  }

  let content = '', reasoning = '', usage = null;
  for await (const payload of sseData(r)) {
    let j;
    try { j = JSON.parse(payload); } catch (e) { continue; }
    const d = (j.choices && j.choices[0] && j.choices[0].delta) || {};
    if (d.content) { content += d.content; opts.onDelta && opts.onDelta(d.content); }
    if (d.reasoning_content) { reasoning += d.reasoning_content; opts.onReasoning && opts.onReasoning(d.reasoning_content); }
    if (j.usage) usage = openAIUsage(j.usage) || usage;
  }
  return { content, reasoning, usage };
}

// ---- Anthropic：POST /v1/messages + 解析（SSE content_block_delta：text_delta / thinking_delta） ----
async function parseAnthropicStream(u, channel, body, opts) {
  const r = await postJson(u, channel, body, opts);

  if (!body.stream) {
    const j = await readJson(r);
    if (j.type === 'error') throw new Error((j.error && j.error.message) || t('llm.anthropicErr'));
    let content = '', reasoning = '';
    for (const b of j.content || []) {
      if (b.type === 'text') content += b.text || '';
      else if (b.type === 'thinking') reasoning += b.thinking || '';
    }
    return { content, reasoning, usage: anthropicUsage(j.usage) };
  }

  let content = '', reasoning = '', usage = null;
  for await (const payload of sseData(r)) {
    let j;
    try { j = JSON.parse(payload); } catch (e) { continue; }
    if (j.type === 'error') throw new Error((j.error && j.error.message) || t('llm.anthropicErr'));
    // message_start 带输入计量，message_delta 带输出计量，需分别合并
    if (j.type === 'message_start') usage = anthropicUsage((j.message || {}).usage) || usage;
    else if (j.type === 'message_delta') {
      const d = anthropicUsage(j.usage);
      if (d && usage) usage = { ...usage, output: d.output, cached: d.cached || usage.cached };
      else if (d) usage = d;
    }
    if (j.type !== 'content_block_delta') continue;
    const d = j.delta || {};
    if (d.type === 'text_delta' && d.text) { content += d.text; opts.onDelta && opts.onDelta(d.text); }
    else if (d.type === 'thinking_delta' && d.thinking) { reasoning += d.thinking; opts.onReasoning && opts.onReasoning(d.thinking); }
  }
  return { content, reasoning, usage };
}

// 压缩上下文：把较早的对话交给同一渠道生成摘要（失败由调用方回退本地裁剪）
// 输出上限单独夹住：给到窗口比例会让摘要模型一直生成、压缩一次等上一分钟
export async function summarize(channel, text, budget) {
  const maxTokens = Math.min(1200, Math.max(400, Math.round((budget || 900) / 2)));
  const r = await chat(channel, [
    { role: 'system', content: t('ai.compactSystem') },
    { role: 'user', content: t('ai.compactPrompt') + '\n\n' + text }
  ], { temperature: 0.2, maxTokens, noReasoning: true });
  return { content: String(r.content || '').trim(), usage: r.usage };
}

// ---------------- 嵌入检索 ----------------

// 嵌入（用于文档检索增强）；Anthropic 协议无嵌入接口 → 返回 null（调用方降级为全文截断）
export async function embed(channel, texts, opts = {}) {
  if (!channel.embedModel || protocolOf(channel) === 'anthropic') return null;
  try {
    const r = await fetch(url(channel, '/embeddings'), {
      method: 'POST',
      headers: headers(channel),
      body: JSON.stringify({ model: channel.embedModel, input: texts }),
      // 检索是在「发送」之前跑的：没超时的挂起端点会让整次发送无限等下去
      signal: timeoutSignal(opts.signal),
      redirect: 'error'
    });
    if (!r.ok) return null;
    const j = await readJson(r);   // 不用 r.json()：嵌入响应是几百个浮点数组，得先过上限
    return (j.data || []).map(d => d.embedding);
  } catch (e) { return null; }
}

function cosine(a, b) {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return s / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// 检索：文档分块 → 嵌入 → top-k；失败返回 null（调用方降级）
export function chunkDoc(text, size) {
  size = size || 700;
  const paras = String(text).split(/\n\s*\n/);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if ((cur + p).length > size && cur) { chunks.push(cur); cur = p; }
    else cur = cur ? cur + '\n\n' + p : p;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.filter(c => c.trim());
}

export async function retrieve(channel, query, docText, k) {
  const chunks = chunkDoc(docText).slice(0, 80);
  if (!chunks.length) return null;
  const vecs = await embed(channel, [query, ...chunks]);
  if (!vecs) return null;
  const qv = vecs[0];
  return chunks.map((c, i) => ({ c, score: cosine(qv, vecs[i + 1]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k || 6)
    .map(x => x.c);
}

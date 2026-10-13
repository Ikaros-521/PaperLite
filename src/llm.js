/* PaperLite · LLM 多渠道接入（OpenAI 兼容协议 + Anthropic Claude 协议）
 * 渠道配置存 localStorage；支持流式对话（含思维链 reasoning/thinking）、
 * 嵌入检索（可选检索模型）、模型列表拉取、内置平台预设、测试连接。
 */

const LS_KEY = 'paperlite.llm.channels.v1';

// ---------------- 协议与平台预设 ----------------

export const PROTOCOLS = [
  { id: 'openai', label: 'OpenAI 兼容', desc: 'OpenAI / DeepSeek / GLM / 通义 / Kimi / Ollama 等' },
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
  { id: 'deepseek', name: 'DeepSeek 深度求索', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'zhipu', name: '智谱 GLM', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.5', 'glm-4.5-air', 'glm-4-plus', 'glm-4-flash', 'embedding-3'] },
  { id: 'qwen', name: '通义千问 Qwen', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long', 'text-embedding-v3'] },
  { id: 'moonshot', name: 'Kimi (月之暗面)', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0905-preview', 'kimi-latest', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  { id: 'siliconflow', name: '硅基流动 SiliconFlow', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct', 'BAAI/bge-m3'] },
  { id: 'openrouter', name: 'OpenRouter 聚合', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openai/gpt-4o', 'anthropic/claude-sonnet-4.5', 'google/gemini-2.0-flash-001', 'deepseek/deepseek-chat'] },
  { id: 'ollama', name: 'Ollama（本机）', protocol: 'openai', baseUrl: 'http://localhost:11434/v1',
    models: ['qwen2.5', 'llama3.1', 'deepseek-r1'] },
  { id: 'lmstudio', name: 'LM Studio（本机）', protocol: 'openai', baseUrl: 'http://localhost:1234/v1', models: [] },
  { id: 'mock', name: 'PaperLite Mock（本机演示）', protocol: 'openai', baseUrl: 'http://localhost:8788/v1',
    models: ['paperlite-mock', 'paperlite-mock-pro', 'paperlite-mock-embed'] }
];

// 按当前协议 + Base URL 反查命中的预设（用于回显预设下拉、提供候选模型）
export function matchPreset(channel) {
  const base = String(channel.baseUrl || '').replace(/\/+$/, '');
  return PLATFORM_PRESETS.find(p => p.protocol === protocolOf(channel) && p.baseUrl === base) || null;
}

// ---------------- 渠道存取 ----------------

export function loadChannels() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    if (!Array.isArray(arr)) return [];
    return arr.map(c => ({
      ...c,
      protocol: c.protocol === 'anthropic' ? 'anthropic' : 'openai',
      contextLimit: +c.contextLimit || 24000
    }));
  } catch (e) { return []; }
}
export function saveChannels(list) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
}
export function newChannel() {
  return {
    id: 'ch-' + Date.now().toString(36),
    name: '新渠道',
    protocol: 'openai',
    baseUrl: 'http://localhost:8788/v1',
    apiKey: '',
    chatModel: 'paperlite-mock',
    embedModel: '',
    cot: false,
    contextLimit: 24000
  };
}

// ---------------- URL / 请求头 ----------------

function url(channel, path) {
  return String(channel.baseUrl || '').replace(/\/+$/, '') + path;
}
// Anthropic：Base URL 视为服务根（自动补 /v1，已带 /v1 则直接拼）
function anthropicUrl(channel, name) {
  let base = String(channel.baseUrl || '').replace(/\/+$/, '');
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

// ---------------- 模型列表 ----------------

// 拉取渠道可用模型（兼容 {data:[{id}]} / {models:[…]} / [string] 等常见返回）
export async function fetchModels(channel) {
  const u = protocolOf(channel) === 'anthropic'
    ? anthropicUrl(channel, 'models')
    : url(channel, '/models');
  const r = await fetch(u, { headers: headers(channel) });
  if (!r.ok) throw new Error('HTTP ' + r.status + '：' + (await r.text()).slice(0, 160));
  const j = await r.json().catch(() => null);
  const arr = (j && (j.data || j.models)) || (Array.isArray(j) ? j : []);
  const ids = arr
    .map(m => (typeof m === 'string' ? m : (m && (m.id || m.name || m.model))))
    .filter(Boolean);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

// ---------------- 测试连接 ----------------

// 优先 /models，失败则发一条极短对话
export async function testConnection(channel) {
  try {
    let ids = [];
    try {
      ids = (await fetchModels(channel)).slice(0, 5);
    } catch (e) {
      await chat(channel, [{ role: 'user', content: 'ping' }], { maxTokens: 5 });
      return { ok: true, msg: '连接成功（对话接口可用；/models 不可用：' + (e.message || e) + '）' };
    }
    return { ok: true, msg: '连接成功' + (ids.length ? '，可用模型：' + ids.join('、') : '') };
  } catch (e) {
    return { ok: false, msg: '失败：' + (e.message || e) };
  }
}

// ---------------- 对话 ----------------

function chatOpenAI(channel, messages, opts) {
  const body = {
    model: channel.chatModel || 'gpt-3.5-turbo',
    messages,
    stream: !!opts.stream
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (channel.cot) {
    body.messages = [
      { role: 'system', content: '你是一个严谨的学术写作助手。请先在内部逐步推理（思维链），再输出最终答案。最终答案中不要展示推理过程。' },
      ...body.messages
    ];
  }

  return parseOpenAIStream(url(channel, '/chat/completions'), channel, body, opts);
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
  if (channel.cot) {
    body.thinking = { type: 'enabled', budget_tokens: 4000 };
    if (body.max_tokens <= 4000) body.max_tokens = 8000;
  } else if (opts.temperature !== undefined) {
    body.temperature = opts.temperature;
  }

  return parseAnthropicStream(anthropicUrl(channel, 'messages'), channel, body, opts);
}

export async function chat(channel, messages, opts = {}) {
  return protocolOf(channel) === 'anthropic'
    ? chatAnthropic(channel, messages, opts)
    : chatOpenAI(channel, messages, opts);
}

// ---- OpenAI 兼容：POST + 解析（含 SSE，delta.content / delta.reasoning_content） ----
async function parseOpenAIStream(u, channel, body, opts) {
  const r = await fetch(u, {
    method: 'POST',
    headers: headers(channel),
    body: JSON.stringify(body),
    signal: opts.signal
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + '：' + (await r.text()).slice(0, 200));

  if (!body.stream) {
    const j = await r.json();
    const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
    return { content: msg.content || '', reasoning: msg.reasoning_content || '' };
  }

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', content = '', reasoning = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      let j;
      try { j = JSON.parse(payload); } catch (e) { continue; }
      const d = (j.choices && j.choices[0] && j.choices[0].delta) || {};
      if (d.content) { content += d.content; opts.onDelta && opts.onDelta(d.content); }
      if (d.reasoning_content) { reasoning += d.reasoning_content; opts.onReasoning && opts.onReasoning(d.reasoning_content); }
    }
  }
  return { content, reasoning };
}

// ---- Anthropic：POST /v1/messages + 解析（SSE content_block_delta：text_delta / thinking_delta） ----
async function parseAnthropicStream(u, channel, body, opts) {
  const r = await fetch(u, {
    method: 'POST',
    headers: headers(channel),
    body: JSON.stringify(body),
    signal: opts.signal
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + '：' + (await r.text()).slice(0, 200));

  if (!body.stream) {
    const j = await r.json();
    if (j.type === 'error') throw new Error((j.error && j.error.message) || 'Anthropic 错误');
    let content = '', reasoning = '';
    for (const b of j.content || []) {
      if (b.type === 'text') content += b.text || '';
      else if (b.type === 'thinking') reasoning += b.thinking || '';
    }
    return { content, reasoning };
  }

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', content = '', reasoning = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let j;
      try { j = JSON.parse(payload); } catch (e) { continue; }
      if (j.type === 'error') throw new Error((j.error && j.error.message) || 'Anthropic 错误');
      if (j.type !== 'content_block_delta') continue;
      const d = j.delta || {};
      if (d.type === 'text_delta' && d.text) { content += d.text; opts.onDelta && opts.onDelta(d.text); }
      else if (d.type === 'thinking_delta' && d.thinking) { reasoning += d.thinking; opts.onReasoning && opts.onReasoning(d.thinking); }
    }
  }
  return { content, reasoning };
}

// ---------------- 嵌入检索 ----------------

// 嵌入（用于文档检索增强）；Anthropic 协议无嵌入接口 → 返回 null（调用方降级为全文截断）
export async function embed(channel, texts) {
  if (!channel.embedModel || protocolOf(channel) === 'anthropic') return null;
  try {
    const r = await fetch(url(channel, '/embeddings'), {
      method: 'POST',
      headers: headers(channel),
      body: JSON.stringify({ model: channel.embedModel, input: texts })
    });
    if (!r.ok) return null;
    const j = await r.json();
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

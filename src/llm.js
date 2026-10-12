/* PaperLite · LLM 多渠道接入（OpenAI 兼容协议）
 * 渠道配置存 localStorage；支持流式对话（含思维链 reasoning_content）、
 * 嵌入检索（可选检索模型）、测试连接。
 */

const LS_KEY = 'paperlite.llm.channels.v1';

export function loadChannels() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
export function saveChannels(list) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
}
export function newChannel() {
  return {
    id: 'ch-' + Date.now().toString(36),
    name: '新渠道',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    chatModel: '',
    embedModel: '',
    cot: false,
    contextLimit: 24000
  };
}

function url(channel, path) {
  return String(channel.baseUrl || '').replace(/\/+$/, '') + path;
}
function headers(channel) {
  return {
    'Content-Type': 'application/json',
    ...(channel.apiKey ? { Authorization: 'Bearer ' + channel.apiKey } : {})
  };
}

// 测试连接：优先 /models，失败则发一条极短对话
export async function testConnection(channel) {
  try {
    const r = await fetch(url(channel, '/models'), { headers: headers(channel) });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      const ids = (j && j.data ? j.data.map(m => m.id) : []).slice(0, 5);
      return { ok: true, msg: '连接成功' + (ids.length ? '，可用模型：' + ids.join('、') : '') };
    }
    if (r.status === 404) {
      // 某些网关不提供 /models，改试对话
      const r2 = await chat(channel, [{ role: 'user', content: 'ping' }], { maxTokens: 5 });
      return { ok: true, msg: '连接成功（对话接口可用）' };
    }
    return { ok: false, msg: 'HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120) };
  } catch (e) {
    return { ok: false, msg: '网络错误：' + (e.message || e) };
  }
}

/**
 * 对话补全。
 * opts: { stream, onDelta(text), onReasoning(text), signal, maxTokens, temperature }
 * 返回 { content, reasoning }
 */
export async function chat(channel, messages, opts = {}) {
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

  const r = await fetch(url(channel, '/chat/completions'), {
    method: 'POST',
    headers: headers(channel),
    body: JSON.stringify(body),
    signal: opts.signal
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + '：' + (await r.text()).slice(0, 200));

  if (!opts.stream) {
    const j = await r.json();
    const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
    return { content: msg.content || '', reasoning: msg.reasoning_content || '' };
  }

  // SSE 流式
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
      try {
        const j = JSON.parse(payload);
        const d = (j.choices && j.choices[0] && j.choices[0].delta) || {};
        if (d.content) { content += d.content; opts.onDelta && opts.onDelta(d.content); }
        if (d.reasoning_content) { reasoning += d.reasoning_content; opts.onReasoning && opts.onReasoning(d.reasoning_content); }
      } catch (e) { /* 跳过坏帧 */ }
    }
  }
  return { content, reasoning };
}

// 嵌入（用于文档检索增强）
export async function embed(channel, texts) {
  if (!channel.embedModel) return null;
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

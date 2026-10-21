/* PaperLite · 上下文预算层（token 口径）
 * 渠道窗口解析 + 启发式 token 估算 + 载荷装配与截断，供 ChatPanel / App 复用；
 * 后续 agent 能力（工具调用、页面操控等）在同一份预算下排队，不再各算各的。
 * 估算不依赖分词器：CJK 按字计，拉丁与 LaTeX 按字符密度折算；
 * 服务端返回 usage 时以实测为准，估算只用于发送前的预算判断与降级显示。
 */

export const FALLBACK_WINDOW = 32000;
// 模型名后缀显式标注窗口时优先（moonshot-v1-8k / qwen-14b-chat-32k …）
const SUFFIX_K = /-(\d{1,4})k$/i;

const NAMED_RULES = [
  [/paperlite-mock/, 32000],
  [/glm-5\.3.*\[1m\]/, 1000000],
  [/glm-5\.3-flash/, 200000],
  [/glm-5\.3/, 1000000],
  [/minimax-m3\.1/i, 524288],
  [/qwen-long/, 1000000],
  [/gemini-2\.0-flash|gemini-2\.5|gemini-flash/, 1048576],
  [/claude/, 200000],
  [/gpt-4\.1|gpt-4o|gpt-4-turbo|^o[134]-/, 128000],
  [/glm-4\.5|glm-4-plus|glm-4-flash|kimi-k2|kimi-latest/, 128000],
  [/llama-?3(\.1|\.2|\.3)?/, 128000],
  [/deepseek/, 64000],
  [/qwen|mistral|llama|ernie|doubao|hunyuan/, 32000]
];

// 已知模型的窗口；认不出返回 0，由调用方决定兜底值
export function inferWindow(model) {
  const m = String(model || '').trim();
  if (!m) return 0;
  const suffix = m.match(SUFFIX_K);
  if (suffix) return Math.min(1000000, +suffix[1] * 1000);
  for (const [re, win] of NAMED_RULES) if (re.test(m)) return win;
  return 0;
}

// 生效窗口：用户覆盖 > 模型推断 > 兜底
export function resolveWindow(channel) {
  const custom = Math.floor(+((channel || {}).ctxWindow) || 0);
  if (custom >= 1000) return { tokens: custom, source: 'custom' };
  const inferred = inferWindow((channel || {}).chatModel);
  return inferred
    ? { tokens: inferred, source: 'model' }
    : { tokens: FALLBACK_WINDOW, source: 'fallback' };
}

// 给回复留的输出预算：思维链渠道要留更多
export function outputReserve(channel) {
  const win = resolveWindow(channel).tokens;
  const ratio = (channel || {}).cot ? 0.2 : 0.12;
  return Math.min(8192, Math.max(1024, Math.round(win * ratio)));
}

// 可用于「输入侧」的预算：窗口减去输出预留，再减去估算误差余量
export function inputBudget(channel) {
  const win = resolveWindow(channel).tokens;
  const safety = Math.max(256, Math.round(win * 0.02));
  return Math.max(512, win - outputReserve(channel) - safety);
}

// 文档上下文只占输入预算的一部分，剩下的留给系统提示与对话历史
const DOC_SHARE = { selection: 0.85, paragraph: 0.5, retrieve: 0.6, full: 0.6 };
export function docBudget(channel, scope) {
  const share = DOC_SHARE[scope] == null ? 0.6 : DOC_SHARE[scope];
  return Math.max(256, Math.round(inputBudget(channel) * share));
}

// 平假名/片假名、中日韩汉字与扩展区、谚文、全角标点
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/g;

// 无分词器的近似计数：CJK 一字≈1 token，其余按 4 字符≈1 token（LaTeX/代码更密取 3）
export function estimateTokens(text) {
  const s = text == null ? '' : String(text);
  if (!s) return 0;
  const cjk = (s.match(CJK) || []).length;
  const rest = s.length - cjk;
  const dense = (s.match(/\\/g) || []).length > rest / 24;
  return Math.max(1, Math.round(cjk * 1.1 + rest / (dense ? 3 : 4)));
}

export function formatTokens(n) {
  const v = Math.max(0, Math.round(+n || 0));
  if (v < 1000) return String(v);
  const k = v / 1000;
  return (k >= 100 ? Math.round(k) : Math.round(k * 10) / 10) + 'k';
}

// 每条消息在网关侧还有少量结构开销
const MSG_OVERHEAD = 4;
function msgCost(content) {
  return estimateTokens(content) + MSG_OVERHEAD;
}

// 按 token 预算截断：保留头部 70%、尾部 30%，中间替换为省略标记。
// 估算非线性（符号密度变化），用结果回验并逐次收缩，确保不超预算。
export function truncateToTokens(text, tokens, marker) {
  const s = text == null ? '' : String(text);
  if (!s || estimateTokens(s) <= tokens) return s;
  const mid = marker == null ? '\n……\n' : String(marker);
  const head0 = Math.floor(s.length * (tokens / estimateTokens(s)) * 0.7);
  const tail0 = Math.floor(s.length * (tokens / estimateTokens(s)) * 0.3);
  let head = head0, tail = tail0, out = '';
  for (let i = 0; i < 6; i++) {
    out = s.slice(0, head) + mid + s.slice(s.length - tail);
    const est = estimateTokens(out);
    if (est <= tokens || head + tail < 64) break;
    const k = (tokens / est) * 0.94;
    head = Math.floor(head * k);
    tail = Math.floor(tail * k);
  }
  // 兜底：符号密度突变时 6 轮收缩仍可能超预算，按比例对成品硬截一次，
  // 宁可多截也不把超预算载荷发给窄窗口渠道
  if (estimateTokens(out) > tokens) {
    const cut = Math.max(64, Math.floor(out.length * (tokens / estimateTokens(out)) * 0.9));
    out = out.slice(0, cut) + mid;
  }
  return out;
}

export function fitsBudget(text, tokens) {
  return estimateTokens(text) <= tokens;
}

// 装配发送载荷：system + 文档块 + 历史（kind='summary' 的压缩摘要按 system 注入）。
// 历史从最新往回填，装满即停，返回分类用量与被丢弃条数，供状态栏与自动压缩判断。
export function buildPayload({ system, docHeader, doc, summaryHeader, history, budget }) {
  const bd = Math.max(0, Math.round(+budget || 0));
  const sysMsg = { role: 'system', content: system || '' };
  const sysCost = msgCost(sysMsg.content);
  let docCost = 0;
  if (doc) docCost = msgCost(String(docHeader || '') + '\n' + doc);

  const items = history || [];
  const tail = [];
  let histCost = 0;
  const room = Math.max(0, bd - sysCost - docCost);
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    const content = it.content || '';
    const isSummary = it.kind === 'summary';
    const cost = isSummary
      ? msgCost(String(summaryHeader || '') + '\n' + content)
      : msgCost(content);
    // 最后一条（本轮提问）无条件保留，否则请求没有意义
    if (tail.length && histCost + cost > room) break;
    histCost += cost;
    tail.unshift(isSummary
      ? { role: 'system', content: (summaryHeader ? summaryHeader + '\n' : '') + content }
      : { role: it.role, content });
  }

  const messages = [{ role: 'system', content: sysMsg.content }];
  if (doc) messages.push({ role: 'system', content: (docHeader ? docHeader + '\n' : '') + doc });
  for (const m of tail) messages.push(m);

  return {
    messages,
    usage: {
      system: sysCost, doc: docCost, history: histCost,
      total: sysCost + docCost + histCost,
      budget: bd,
      dropped: items.length - tail.length
    }
  };
}

// 未裁剪的真实占用：状态栏要能显示「已超预算」，所以这里不做装不下就丢弃
export function rawUsage({ system, docHeader, doc, summaryHeader, history }) {
  const sys = msgCost(system || '');
  const docCost = doc ? msgCost(String(docHeader || '') + '\n' + doc) : 0;
  let hist = 0;
  for (const m of history || []) {
    hist += m.kind === 'summary'
      ? msgCost(String(summaryHeader || '') + '\n' + (m.content || ''))
      : msgCost(m.content || '');
  }
  return { system: sys, doc: docCost, history: hist, total: sys + docCost + hist };
}

// 压缩切分：保留末尾 keep 条原文，更早的交给模型摘要
export function splitForCompact(messages, keep) {
  const list = messages || [];
  const k = keep == null ? 6 : keep;
  if (list.length <= k + 2) return null;
  const head = list.slice(0, list.length - k);
  if (!head.some(m => m.kind !== 'summary')) return null;
  return { head, tail: list.slice(list.length - k) };
}

// 把待压缩的历史渲染成纯文本喂给摘要请求
export function historyToText(messages, labels) {
  return (messages || []).map((m, i) => {
    if (m.kind === 'summary') return (labels.summary || 'Summary') + ': ' + (m.content || '');
    const who = m.role === 'user' ? (labels.user || 'User') : (labels.assistant || 'Assistant');
    return who + ' #' + (i + 1) + ': ' + String(m.content || '').slice(0, 1200);
  }).join('\n');
}

// 摘要在上下文里只应占很小一块；按窗口比例给，并夹在可用区间内
export function summaryBudget(channel) {
  const share = Math.round(inputBudget(channel) * 0.08);
  return Math.min(2000, Math.max(600, share));
}

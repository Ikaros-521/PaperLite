/**
 * AI Agent 执行循环（文本协议工具调用）。
 *
 * 一轮 agent 会话 = 若干「步」：每步把当前 UI 消息数组装配进预算管线
 * （复用 context.js 的 buildPayload，与普通对话同一 token 口径），
 * 流式请求模型 → 解析 ```tool 块 → 逐个执行 → 结果以 user(tool-result) 消息
 * 回传 → 进入下一步；模型不再调工具或达到步数上限即结束。
 *
 * 消息数组由本循环持有并整体发出（onUpdate），ChatPanel 只做 setMessages(list)，
 * 避免「流式增量」与「工具结果追加」两条路径同时改一个 state。
 */
import * as llm from '../llm.js';
import * as ctx from '../context.js';
import { tr, getLang } from '../i18n.js';
import { parseToolCalls, toolsSchema } from './agentTools.js';

export const AGENT_MAX_STEPS = 15;
// 渐进式披露：工具结果只在最近几条保持全文，更早的衰减为一行占位
// （模型仍知道用过什么工具、结果多大，需要时可重新调用），避免多步循环
// 把第 1 步 read_file 的 12k 字符一路背到最后一步。
export const TOOL_RESULT_KEEP = 5;

// Agent 行为参数（步数上限 / 全文保留条数）随浏览器保存；常量只作默认值与钳制边界
export const AGENT_STEPS_MAX = 50;
export const AGENT_KEEP_MAX = 10;
const AGENT_CFG_KEY = 'paperlite.agentSettings.v1';

function clampInt(v, min, max, dflt) {
  // Number(null)=0 是有限数，会把 null 钳到最小值而不是走默认值——与 undefined 语义对齐
  if (v === null || v === undefined) return dflt;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

export function loadAgentSettings() {
  const dflt = { maxSteps: AGENT_MAX_STEPS, keepResults: TOOL_RESULT_KEEP };
  try {
    const raw = JSON.parse(localStorage.getItem(AGENT_CFG_KEY) || '{}');
    if (!raw || typeof raw !== 'object') return dflt;
    return {
      maxSteps: clampInt(raw.maxSteps, 1, AGENT_STEPS_MAX, dflt.maxSteps),
      keepResults: clampInt(raw.keepResults, 1, AGENT_KEEP_MAX, dflt.keepResults),
    };
  } catch (e) { return dflt; }
}

export function saveAgentSettings(cfg) {
  try { localStorage.setItem(AGENT_CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
}

export function agentSystemPrompt() {
  const L = getLang();
  return tr(L, 'ai.agentSystem', {
    lang: L === 'en' ? 'English' : '中文',
    tools: toolsSchema(),
  });
}

/** 装配用的历史视图：旧的 tool-result 换成占位（UI 仍显示完整结果，仅请求侧瘦身） */
function historyForLlm(list, L, keep) {
  const toolIdx = [];
  for (let i = 0; i < list.length; i++) if (list[i] && list[i].kind === 'tool-result') toolIdx.push(i);
  const stale = new Set(toolIdx.slice(0, Math.max(0, toolIdx.length - keep)));
  if (!stale.size) return list;
  return list.map((m, i) => stale.has(i)
    ? { ...m, content: tr(L, 'agent.staleToolResult', { tool: m.tool || '?', n: (m.content || '').length }) }
    : m);
}

/**
 * @param opts {{
 *   channel, messages,          // UI 消息数组（含本轮 user 提问，末尾无需 assistant 占位）
 *   system,                     // agent 系统提示词
 *   docHeader, doc,             // 项目简报（作为 system 文档块）
 *   summaryHeader,              // 压缩摘要头（与普通对话一致）
 *   budget,                     // 输入预算（ctx.inputBudget）
 *   maxSteps?: number,
 *   keepResults?: number,       // 最近的 N 条工具结果保持全文（默认 TOOL_RESULT_KEEP）
 *   execute: (name, args) => Promise<{ok, result}>,
 *   onUpdate: (messages: any[]) => void,
 *   signal?: AbortSignal,
 * }}
 * @returns {Promise<{usage: any|null}>}  最后一步的 usage（无则 null）
 */
export async function runAgentLoop(opts) {
  const {
    channel, system, docHeader, doc, summaryHeader, budget,
    execute, onUpdate, signal,
  } = opts;
  const maxSteps = opts.maxSteps || AGENT_MAX_STEPS;
  const keep = clampInt(opts.keepResults, 1, AGENT_KEEP_MAX, TOOL_RESULT_KEEP);
  const L = getLang();

  // 本地持有完整列表，每次变化整体推给 UI
  let list = (opts.messages || []).slice();
  const push = (m) => { list = list.concat([m]); onUpdate(list); return m; };
  const patchLast = (fn) => { list = list.slice(0, -1).concat([fn(list[list.length - 1])]); onUpdate(list); };

  // 本轮原始提问（进入循环时的最后一条普通 user 消息）。buildPayload 从最新往回
  // 装填、装不下即弃——多步循环后最早的提问可能被整体丢掉，之后每步模型都没有
  // 任务目标只能空转。装配后若被丢弃，在最新侧重注入：模型最后看到的即任务目标。
  const origQ = [...list].reverse().find(m => m && m.role === 'user' && !m.kind);
  const build = () => {
    const built = ctx.buildPayload({
      system, docHeader, doc, summaryHeader, history: historyForLlm(list, L, keep), budget,
    }).messages;
    if (origQ && !built.some(m => m && m.role === 'user' && m.content === origQ.content)) {
      return built.concat([{ role: 'user', content: origQ.content }]);
    }
    return built;
  };

  let usage = null;
  for (let step = 0; step <= maxSteps; step++) {
    const last = step === maxSteps;   // 用尽步数：允许再答一次，但不许再调工具
    if (last) {
      push({ role: 'user', kind: 'agent-limit', content: tr(L, 'agent.limitNote', { n: maxSteps }) });
    }

    // 装配要在追加 assistant 占位之前：占位的空消息没有信息量，不该占预算
    const messagesForLlm = build();
    push({ role: 'assistant', content: '', reasoning: '' });
    let res;
    try {
      res = await llm.chat(channel, messagesForLlm, {
        stream: true, signal,
        onDelta: d => patchLast(m => ({ ...m, content: m.content + d })),
        onReasoning: d => patchLast(m => ({ ...m, reasoning: (m.reasoning || '') + d })),
      });
    } catch (e) {
      // 用户主动停止不算失败：已有部分流式内容就保留，空消息留白即可
      if (e.name !== 'AbortError') {
        patchLast(m => m.content ? m : { ...m, content: tr(L, 'chat.reqFailed', { msg: e.message || e }) });
      }
      throw e;
    }
    usage = res.usage || usage;

    const { calls, bad } = parseToolCalls(res.content);
    const badErrs = bad.map(raw => ({
      ok: false,
      result: tr(L, 'agent.errBadBlock', { raw }),
    }));
    if (last) {
      // 收口步不再执行工具：为已解析的调用补一条未执行回执，UI 不渲染悬空的
      // 「工具调用」卡片，模型侧也不会误以为调用已执行过
      for (const c of calls) {
        push({ role: 'user', kind: 'tool-result', tool: c.tool, args: c.args, running: false, ok: false, content: tr(L, 'agent.stepLimitTool') });
      }
      return { usage };
    }
    if (!calls.length && !badErrs.length) return { usage };

    // 执行工具：调用卡片信息直接挂在结果消息上（assistant 正文里的 ```tool 块由 UI 渲染成卡片）
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      // 用户已点停止：剩余工具（可能含改文档操作）不再执行。
      // 但要给每一条补一条「未执行」回执——assistant 正文里的 ```tool 块照样会被 UI
      // 画成卡片，没有回执时用户看到三个已调用的卡片，实际只应用了第一个
      if (signal && signal.aborted) {
        for (let j = i; j < calls.length; j++) {
          push({ role: 'user', kind: 'tool-result', tool: calls[j].tool, args: calls[j].args, running: false, ok: false, content: tr(L, 'agent.toolSkipped') });
        }
        const e = new Error('aborted'); e.name = 'AbortError'; throw e;
      }
      push({ role: 'user', kind: 'tool-result', tool: c.tool, args: c.args, running: true, content: '' });
      const r = await execute(c.tool, c.args);
      patchLast(m => ({ ...m, running: false, ok: r.ok, content: r.result }));
    }
    for (const b of badErrs) {
      push({ role: 'user', kind: 'tool-result', tool: '(json)', args: {}, running: false, ok: false, content: b.result });
    }
  }
  return { usage };
}

/** UI 消息数组 → 纯文本预览（供测试与调试） */
export function flattenForLlm(messages) {
  return (messages || [])
    .filter(m => m && m.content)
    .map(m => ({ role: m.role, content: String(m.content) }));
}

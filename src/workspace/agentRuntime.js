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
import { parseToolCalls } from './agentTools.js';
import { toolsSchema, MUTATING_TOOLS, TASK_TOOLS, validateCall, makeCallLedger, adviceFor } from './toolRegistry.js';
import { createTask, setPlan, updateStep, takeSnapshot, noteChange, recordAudit, writeDrift, checkCircuit, stepProgress, taskBrief, taskSummary, CIRCUIT_LIMITS } from './agentTask.js';

export const AGENT_MAX_STEPS = 15;
// 渐进式披露：工具结果只在最近几条保持全文，更早的衰减为一行占位
// （模型仍知道用过什么工具、结果多大，需要时可重新调用），避免多步循环
// 把第 1 步 read_file 的 12k 字符一路背到最后一步。
export const TOOL_RESULT_KEEP = 5;

// Agent 行为参数（步数上限 / 全文保留条数）随浏览器保存；常量只作默认值与钳制边界
export const AGENT_STEPS_MAX = 50;
export const AGENT_KEEP_MAX = 10;
// 单步工具调用上限：畸形或循环中的输出可以一次点名几十处改动，全执行等于没有刹车
export const AGENT_TOOLS_PER_STEP = 8;
// 整轮改盘次数上限（edit_file / insert_text / create_file）：配合上面的单步上限，
// 让「模型自己跟自己绕圈」最多改 20 处就停
export const AGENT_WRITES_PER_RUN = 20;
// 整轮挂钟上限：流式长回答不能掐单次请求（见 llm.js 的 timeoutMs 注释），但一轮 Agent
// 总得有尽头，超了就当作步数用尽——只收口回答，不再执行工具
export const AGENT_DEADLINE_MIN = 10;
// 权限档位（对齐 Codex 的 read-only / on-request / full-access 三档思路）：
//   ask  每次审核——每个改动手（edit_file / insert_text / create_file）执行前请用户确认
//   auto 自动审核——不打断，直接执行（默认）
//   full 完全访问——不打断、不挡隐藏路径读、不卡整轮改盘次数
// 只读类工具（列文件/读文件/搜索/诊断/读选区）任何档位都直通。
export const AGENT_APPROVALS = ['ask', 'auto', 'full'];
export const AGENT_APPROVAL_DEFAULT = 'auto';
// 整轮工具调用总数（含被拦下的）：步数限的是「模型轮次」，这条限的是动作数。
// 没有它，模型可以每步只发一条无效调用，用 50 步 × 单步配额绕开所有刹车
export const AGENT_CALLS_PER_RUN = CIRCUIT_LIMITS.calls;
const AGENT_CFG_KEY = 'paperlite.agentSettings.v1';

function clampInt(v, min, max, dflt) {
  // Number(null)=0 是有限数，会把 null 钳到最小值而不是走默认值——与 undefined 语义对齐
  if (v === null || v === undefined) return dflt;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

// 布尔项只认明确的真假：undefined/损坏数据回默认值，别把「没写过」读成 false
function boolOf(v, dflt) {
  if (v === undefined || v === null) return dflt;
  return v === true || v === 'true' || v === 1;
}

export function loadAgentSettings() {
  const dflt = {
    maxSteps: AGENT_MAX_STEPS, keepResults: TOOL_RESULT_KEEP,
    approval: AGENT_APPROVAL_DEFAULT, plan: true, review: false, persist: true,
  };
  try {
    const raw = JSON.parse(localStorage.getItem(AGENT_CFG_KEY) || '{}');
    if (!raw || typeof raw !== 'object') return dflt;
    return {
      maxSteps: clampInt(raw.maxSteps, 1, AGENT_STEPS_MAX, dflt.maxSteps),
      keepResults: clampInt(raw.keepResults, 1, AGENT_KEEP_MAX, dflt.keepResults),
      // 档位只认白名单：手改/旧版数据里的野值回落到默认档，不能因为拼错就变成全访问
      approval: AGENT_APPROVALS.includes(raw.approval) ? raw.approval : dflt.approval,
      plan: boolOf(raw.plan, dflt.plan),
      review: boolOf(raw.review, dflt.review),
      persist: boolOf(raw.persist, dflt.persist),
    };
  } catch (e) { return dflt; }
}

export function saveAgentSettings(cfg) {
  try { localStorage.setItem(AGENT_CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
}

export function agentSystemPrompt(opts = {}) {
  const L = getLang();
  return tr(L, 'ai.agentSystem', {
    lang: L === 'en' ? 'English' : '中文',
    tools: toolsSchema(opts),
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

/** 审计里只留参数的形状，不留正文：日志要能复盘「调了什么、成没成」，
 *  但不该把用户正文再抄一份进任务状态（那份钱已经花在工具结果里了） */
const AUDIT_ARG_MAX = 120;
function briefArgs(a) {
  const o = {};
  for (const [k, v] of Object.entries(a || {})) {
    o[k] = typeof v === 'string' && v.length > 40 ? v.length + 'chars' : v;
  }
  const s = JSON.stringify(o);
  return s.length > AUDIT_ARG_MAX ? s.slice(0, AUDIT_ARG_MAX) + '…' : s;
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
 *   plan?: boolean,             // 计划块与任务状态（默认开）；关掉退回单循环，但所有刹车仍在
 *   activePath?: () => string,  // 活动文档路径：省略 path 的改动手要靠它判断落点
 *   onTask?: (view) => void,    // 任务状态发布给界面（计划卡与回滚入口）
 * }}
 * @returns {Promise<{usage: any|null, task: object}>}  最后一步的 usage 与任务小结
 */
export async function runAgentLoop(opts) {
  const {
    channel, system, docHeader, doc, summaryHeader, budget,
    execute, onUpdate, signal,
  } = opts;
  const maxSteps = opts.maxSteps || AGENT_MAX_STEPS;
  const keep = clampInt(opts.keepResults, 1, AGENT_KEEP_MAX, TOOL_RESULT_KEEP);
  // 权限档位与确认回调：'ask' 时每个改动手先问用户；requestApproval 缺失就退回
  // 'auto'（宁可少拦一次，也不要把改动手卡死在没人应答的 await 上）
  const approval = AGENT_APPROVALS.includes(opts.approval) ? opts.approval : AGENT_APPROVAL_DEFAULT;
  const askEach = approval === 'ask' && typeof opts.requestApproval === 'function';
  const planMode = opts.plan !== false;
  const L = getLang();

  // 本地持有完整列表，每次变化整体推给 UI
  let list = (opts.messages || []).slice();
  const push = (m) => { list = list.concat([m]); onUpdate(list); return m; };
  const patchLast = (fn) => { list = list.slice(0, -1).concat([fn(list[list.length - 1])]); onUpdate(list); };

  // 本轮原始提问（进入循环时的最后一条普通 user 消息）。buildPayload 从最新往回
  // 装填、装不下即弃——多步循环后最早的提问可能被整体丢掉，之后每步模型都没有
  // 任务目标只能空转。装配后若被丢弃，在最新侧重注入：模型最后看到的即任务目标。
  const origQ = [...list].reverse().find(m => m && m.role === 'user' && !m.kind);

  // 任务状态归框架持有：模型只能用 set_plan / update_plan 提议，通过了校验才落进状态。
  // goal 直接取用户原话——它比模型复述的版本更权威，跑偏时拿它对齐。
  const task = createTask({ goal: (origQ && origQ.content) || '' });
  const publishTask = () => {
    if (typeof opts.onTask !== 'function') return;
    opts.onTask({
      id: task.id, goal: task.goal, phase: task.phase, currentStep: task.currentStep,
      steps: task.steps.map(s => ({ ...s, deps: s.deps.slice() })),
      snapshots: task.snapshots.slice(),
      counters: { ...task.counters },
      touched: Object.keys(task.touched),
    });
  };

  const build = () => {
    const built = ctx.buildPayload({
      system, docHeader, doc, summaryHeader, history: historyForLlm(list, L, keep), budget,
    }).messages;
    if (planMode) {
      // 结构化工作记忆放在最新侧：模型每步先看到目标、当前子任务的交付物与完成判定、
      // 剩余额度，再往下看历史。goal 已经在简报里，所以不再单独重注原始提问
      // （同一句话占两份预算是本该被这套状态消灭掉的那种浪费）。
      return built.concat([{ role: 'system', content: taskBrief(task, AGENT_TOOLS_PER_STEP) }]);
    }
    if (origQ && !built.some(m => m && m.role === 'user' && m.content === origQ.content)) {
      return built.concat([{ role: 'user', content: origQ.content }]);
    }
    return built;
  };

  let usage = null;
  const startedAt = Date.now();
  let writes = 0;
  // 调用台账属框架而不是模型：模型看不到「这条是缓存来的」，只看到结果变小了
  const ledger = makeCallLedger();
  publishTask();
  const finish = (phase) => {
    task.phase = phase;
    publishTask();
    // answer 带出去给验收评审用：ChatPanel 手里的 messages 是发布快照，闭包里读到的是
    // 进循环前的那一份，自己找最后一条 assistant 会拿到空串
    const lastAssistant = [...list].reverse().find(m => m && m.role === 'assistant' && m.content);
    return { usage, task: taskSummary(task), answer: lastAssistant ? String(lastAssistant.content) : '' };
  };

  try {
  for (let step = 0; step <= maxSteps; step++) {
    // 熔断条件由框架判（步数 / 调用数 / 零推进 / 挂钟），命中即收口，不再问模型
    const trip = checkCircuit(task, { maxCalls: AGENT_CALLS_PER_RUN, deadlineMs: AGENT_DEADLINE_MIN * 60_000 });
    const overTime = Date.now() - startedAt > AGENT_DEADLINE_MIN * 60_000;
    const last = step === maxSteps || overTime || !!trip;
    if (last) {
      if (trip) task.circuit = { reason: trip.reason, at: Date.now() };
      task.phase = trip ? 'tripped' : 'closing';
      const tripKey = trip ? (trip.reason === 'calls' ? 'agent.circuitCalls'
        : trip.reason === 'no_progress' ? 'agent.circuitNoProgress' : 'agent.circuitTime') : '';
      push({ role: 'user', kind: 'agent-limit', content: trip
        ? tr(L, tripKey, { n: trip.n })
        : overTime
          ? tr(L, 'agent.deadlineNote', { n: AGENT_DEADLINE_MIN })
          : tr(L, 'agent.limitNote', { n: maxSteps }) });
      publishTask();
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
      return finish(trip ? 'tripped' : 'completed');
    }
    if (!calls.length && !badErrs.length) return finish('completed');

    let progressed = false;
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
      // 单步调用数与整轮改盘数是两道刹车：超出的每条都要有「未执行」回执，
      // 否则 UI 照样画卡片，模型也以为自己改过了
      if (i >= AGENT_TOOLS_PER_STEP) {
        push({ role: 'user', kind: 'tool-result', tool: c.tool, args: c.args, running: false, ok: false,
          content: tr(L, 'agent.toolBatchLimit', { n: AGENT_TOOLS_PER_STEP }) });
        continue;
      }
      // 参数校验属框架层：非法调用不进执行器（不进工具实现也就没资格算一次改盘配额），
      // 回执里直接带上缺哪个参数、该怎么做，模型下一轮才有机会改对
      const v = validateCall(c.tool, c.args);
      if (!v.ok) {
        task.counters.blocked++;
        recordAudit(task, { step, tool: c.tool, args: briefArgs(c.args), ok: false, code: v.code, chars: 0 });
        push({ role: 'user', kind: 'tool-result', tool: c.tool, args: c.args, running: false, ok: false,
          content: v.error + (adviceFor(v.code) ? '\n' + adviceFor(v.code) : '') });
        continue;
      }
      // 计划类动作只改任务状态，由框架校验后落地——状态所有权不在模型手里
      if (TASK_TOOLS.has(c.tool)) {
        if (!planMode) {
          push({ role: 'user', kind: 'tool-result', tool: c.tool, args: v.args, running: false, ok: false,
            content: tr(L, 'agent.planDisabled') });
          continue;
        }
        const r = c.tool === 'set_plan' ? setPlan(task, v.args) : updateStep(task, v.args);
        recordAudit(task, { step, tool: c.tool, args: briefArgs(v.args), ok: !!r.ok, code: r.ok ? '' : 'plan_rejected', chars: 0 });
        if (!r.ok) {
          push({ role: 'user', kind: 'tool-result', tool: c.tool, args: v.args, running: false, ok: false, content: r.error });
          continue;
        }
        progressed = true;
        task.counters.calls++;
        let note = c.tool === 'set_plan'
          ? tr(L, 'agent.planAccepted', { n: r.steps.length })
            + (r.goalDrift ? '\n' + tr(L, 'agent.goalDriftNote') : '')
          : tr(L, 'agent.planUpdated', { n: v.args.step, status: v.args.status });
        if (r.needsSnapshot) {
          const snap = takeSnapshot(task, v.args.step);
          note += snap
            ? '\n' + tr(L, 'agent.snapshotted', { n: snap.step, files: Object.keys(snap.files).length })
              + (snap.created.length ? '\n' + tr(L, 'agent.snapshotKeeps', { list: snap.created.join(', ') }) : '')
            : '\n' + tr(L, 'agent.snapshotNone', { n: v.args.step });
        }
        publishTask();
        push({ role: 'user', kind: 'tool-result', tool: c.tool, args: v.args, running: false, ok: true, content: note });
        continue;
      }
      // 同一条调用连着失败三次，说明模型在跟自己绕圈而不是在推进任务：框架拒绝再执行。
      // 这不是熔断（整轮还能继续），只是关掉这一条死路
      if (ledger.shouldBlock(c.tool, v.args)) {
        task.counters.blocked++;
        recordAudit(task, { step, tool: c.tool, args: briefArgs(v.args), ok: false, code: 'repeat_blocked', chars: 0 });
        push({ role: 'user', kind: 'tool-result', tool: c.tool, args: v.args, running: false, ok: false,
          content: tr(L, 'agent.errRepeatBlocked', { tool: c.tool }) });
        continue;
      }
      if (MUTATING_TOOLS.has(c.tool)) {
        // 前置校验（落点侧）：这一步声明的交付物里没有出现过的文件，改动先拦下来。
        // 语义相关性要问模型（每轮都问就是双倍 token），但「改的文件跟这步说好的
        // 不是同一个」是字符串就能判的跑偏，而且是长任务里最贵的一种。
        const target = String(v.args.path || '').trim()
          || (typeof opts.activePath === 'function' ? String(opts.activePath() || '') : '');
        if (planMode && task.steps.length && writeDrift(task, target)) {
          task.counters.blocked++;
          recordAudit(task, { step, tool: c.tool, args: briefArgs(v.args), ok: false, code: 'drift', chars: 0 });
          push({ role: 'user', kind: 'tool-result', tool: c.tool, args: v.args, running: false, ok: false,
            content: tr(L, 'agent.driftBlocked', { n: task.currentStep || 0, path: target || '?' }) });
          continue;
        }
        // 「每次审核」档：改动动手前把落点与改动摘要摊给用户看，拒绝就原话回给模型
        // （不拒绝就照常执行；档位只影响是否打断，不影响工具语义）
        if (askEach) {
          const info = typeof execute.describe === 'function'
            ? execute.describe(c.tool, v.args)
            : { mutates: true, tool: c.tool, path: String((v.args && v.args.path) || ''), detail: '' };
          let yes = false;
          try { yes = !!(await opts.requestApproval(info)); } catch (e) { yes = false; }
          if (!yes) {
            push({ role: 'user', kind: 'tool-result', tool: c.tool, args: v.args, running: false, ok: false,
              content: tr(L, 'agent.errDeniedByUser', { tool: c.tool }) });
            continue;
          }
        }
        // 「完全访问」档由用户明确放弃这层保护；其余档位仍受整轮改盘次数约束
        if (approval !== 'full') {
          if (writes >= AGENT_WRITES_PER_RUN) {
            push({ role: 'user', kind: 'tool-result', tool: c.tool, args: v.args, running: false, ok: false,
              content: tr(L, 'agent.errWriteBudget', { n: AGENT_WRITES_PER_RUN }) });
            continue;
          }
        }
        writes++;
        task.counters.writes = writes;
      }
      push({ role: 'user', kind: 'tool-result', tool: c.tool, args: v.args, running: true, content: '' });
      const r = await execute(c.tool, v.args);
      task.counters.calls++;
      if (r.ok) progressed = true;
      // 只读工具重读同一份内容时，回执换成一行「与本轮第 N 次调用相同」：正文不重复进
      // 上下文，模型也不会以为自己读到了新东西。失败时附上注册表给的降级建议
      const dup = ledger.observe(c.tool, v.args, r);
      if (dup) task.counters.cacheHits++;
      const dupNote = dup ? tr(L, 'agent.cacheSameAs', { n: dup.dupOf, tool: c.tool }) : '';
      const hint = !r.ok ? adviceFor(r.code) : '';
      patchLast(m => ({ ...m, running: false, ok: r.ok, content: dupNote || (r.result + (hint ? '\n' + hint : '')) }));
      recordAudit(task, {
        step, tool: c.tool, args: briefArgs(v.args), ok: !!r.ok, code: r.code || '',
        chars: String(r.result || '').length, dupOf: dup ? dup.dupOf : 0,
      });
      // 改盘成功的落点与「改前版本 id」要交给任务状态：子任务完成时靠它打快照
      if (r.ok && MUTATING_TOOLS.has(c.tool)) {
        if (c.tool === 'create_file') noteCreate(task, r.file || String(v.args.path || ''));
        else noteChange(task, r.file, r.versionId);
      }
    }
    for (const b of badErrs) {
      push({ role: 'user', kind: 'tool-result', tool: '(json)', args: {}, running: false, ok: false, content: b.result });
    }
    // 零推进计数：整步既没有成功调用、也没动过计划 → 下一步就是熔断的候选
    stepProgress(task, progressed || !!badErrs.length);
    publishTask();
  }
  // 走到这里说明步数循环自然结束（正常情况下已在收口步返回）
  return finish('completed');
  } catch (e) {
    task.phase = e && e.name === 'AbortError' ? 'aborted' : 'failed';
    publishTask();
    throw e;
  }
}

/** UI 消息数组 → 纯文本预览（供测试与调试） */
export function flattenForLlm(messages) {
  return (messages || [])
    .filter(m => m && m.content)
    .map(m => ({ role: m.role, content: String(m.content) }));
}

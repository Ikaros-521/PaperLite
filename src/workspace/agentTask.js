/**
 * Agent 任务状态（长任务的结构化工作记忆）。
 *
 * 为什么要有这个模块：在此之前，一轮 Agent 的全部状态就是「消息数组」本身——
 * 目标、进度、配额、回滚点全靠模型自己从历史里回忆。步数一多就会出现三种典型失效：
 * 忘记原始目标、重复做已经做完的事、改坏了却没有能退回去的稳定点。
 * 这里把状态从对话里搬出来交给框架持有：
 *   - 状态所有权在框架：模型只能通过 set_plan / update_plan 提「动作建议」，
 *     本模块负责校验合法性（依赖、状态迁移、越界），通过了才写进状态；
 *   - 原始目标单独存 goal，逐步压成一小段结构化简报注入请求，
 *     而不是把整段历史反复塞进 prompt；
 *   - 每个子任务完成时打快照（改过的文件 → 改前版本号），回滚只回到快照点；
 *   - 熔断条件（步数 / 调用数 / 改盘数 / 挂钟 / 零推进）在这里判定，与模型无关。
 * 纯逻辑模块：不 import React、不碰浏览器 API，Node 单测直接跑。
 */
import { tr, getLang } from '../i18n.js';

/** 阶段：planning 尚未成计划 → executing 按计划推进 → closing 配额用尽只做收口
 *  → completed / failed / aborted / tripped（熔断终止） */
export const TASK_PHASES = ['planning', 'executing', 'closing', 'completed', 'failed', 'aborted', 'tripped'];
export const STEP_STATUSES = ['pending', 'doing', 'done', 'blocked', 'skipped'];

export const PLAN_MAX_STEPS = 24;
const TITLE_MAX = 200, FIELD_MAX = 300;
const PATH_RE = /[\w./-]+\.[a-zA-Z]{2,5}/g;

let seq = 0;

/**
 * 新建任务。goal 进来时先放用户原话；模型 set_plan 时可以改写（那是它复述的目标，
 * 仍以原话为准做锚点，见 anchoredGoal）。
 */
export function createTask(opts = {}) {
  seq = (seq + 1) % 1e6;
  return {
    id: 't' + Date.now().toString(36) + '-' + seq,
    goal: String(opts.goal || '').slice(0, 600),
    phase: 'planning',
    startedAt: opts.now || Date.now(),
    steps: [],
    currentStep: null,
    counters: { steps: 0, calls: 0, writes: 0, blocked: 0, cacheHits: 0, noProgress: 0 },
    touched: {},          // path -> 本任务里最近一次「改前」版本 id（空串=本轮新建，无从回滚）
    pending: {},          // path -> 本步内第一次「改前」版本 id（快照原料）
    pendingCreated: {},   // 本步内新建的文件：回滚不覆盖它们，要单列出来告知
    snapshots: [],        // { step, at, files: {path: versionId}, created: [path] }
    audit: [],            // { step, tool, args, ok, code, chars, dupOf, note }
    circuit: null,        // { reason, at }
  };
}

/* ---- 计划：结构校验 + DAG（只允许依赖更早的步，天然无环） ---- */

function str(v, max) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * 目标重合度：拉丁词 + CJK 单字与相邻二字组的集合，看模型复述的目标里有多少词
 * 来自用户原话。中文分词做不起（也不该为这个引一个词典），二字组对论文的
 * 常用词已经够准；判不出来时返回 1（宁可放行，也不要把正当的复述当跑偏）。
 */
export function goalOverlap(origin, restated) {
  const tokens = (s) => {
    const set = new Set();
    (String(s || '').toLowerCase().match(/[a-z0-9_.\-]{2,}/g) || []).forEach(t => set.add(t));
    const cjk = String(s || '').match(/[㐀-䶿一-鿿]/g) || [];
    for (let i = 0; i < cjk.length; i++) { set.add(cjk[i]); if (i + 1 < cjk.length) set.add(cjk[i] + cjk[i + 1]); }
    return set;
  };
  const A = tokens(origin), B = tokens(restated);
  if (!A.size || !B.size) return 1;
  let hit = 0;
  for (const t of B) if (A.has(t)) hit++;
  return hit / B.size;
}

/**
 * set_plan 落地。@returns {{ok:true, steps, goalDrift?:boolean}|{ok:false, error}}
 * 每步必须有交付物与完成判定——没有这两样，「做完了」就只能由模型随口宣布。
 */
export function setPlan(task, args) {
  const L = getLang();
  const raw = Array.isArray(args && args.steps) ? args.steps : [];
  if (!raw.length) return { ok: false, error: tr(L, 'agent.errPlanEmpty') };
  if (raw.length > PLAN_MAX_STEPS) return { ok: false, error: tr(L, 'agent.errPlanTooLong', { n: PLAN_MAX_STEPS }) };
  const steps = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] && typeof raw[i] === 'object' ? raw[i] : {};
    const title = str(s.title, TITLE_MAX);
    const deliverable = str(s.deliverable || s.deliverable_when, FIELD_MAX);
    const doneWhen = str(s.done_when || s.doneWhen || s.done, FIELD_MAX);
    if (!title) return { ok: false, error: tr(L, 'agent.errPlanNoTitle', { n: i + 1 }) };
    if (!deliverable) return { ok: false, error: tr(L, 'agent.errPlanNoDeliverable', { n: i + 1, title }) };
    if (!doneWhen) return { ok: false, error: tr(L, 'agent.errPlanNoDoneWhen', { n: i + 1, title }) };
    const deps = (Array.isArray(s.deps) ? s.deps : []).map(d => Math.round(Number(d)));
    for (const d of deps) {
      if (!Number.isFinite(d) || d < 1 || d >= i + 1) return { ok: false, error: tr(L, 'agent.errPlanBadDep', { n: i + 1, dep: d }) };
    }
    steps.push({ n: i + 1, title, deliverable, doneWhen, deps: [...new Set(deps)], status: 'pending', note: '' });
  }
  task.steps = steps;
  task.phase = 'executing';
  task.currentStep = null;
  // 模型复述的目标不回写状态——锚点必须是用户原话；它只用来做重合度比对，
  // 差得太远就在回执里提醒一次（这是零 token 成本的前置目标校验）
  const goalDrift = !!args.goal && goalOverlap(task.goal, args.goal) < 0.25;
  return { ok: true, steps, goalDrift };
}

/**
 * update_plan 落地。框架只认合法迁移：
 *   前置未完成 → 不许开工；已经 done → 不许改回别的状态（进度不能倒退，
 *   否则模型可以把同一步反复「完成」来续命）。
 * @returns {{ok:true, needsSnapshot:boolean}|{ok:false, error}}
 */
export function updateStep(task, args) {
  const L = getLang();
  const n = Math.round(Number(args && args.step));
  const status = String((args && args.status) || '');
  const step = task.steps.find(s => s.n === n);
  if (!step) return { ok: false, error: tr(L, 'agent.errPlanNoSuchStep', { n }) };
  if (!STEP_STATUSES.includes(status)) return { ok: false, error: tr(L, 'agent.errArgEnum', { name: 'status', values: STEP_STATUSES.join(' / ') }) };
  if (step.status === 'done' && status !== 'done') return { ok: false, error: tr(L, 'agent.errStepAlreadyDone', { n }) };
  if (status === 'doing') {
    const missing = step.deps.filter(d => {
      const p = task.steps.find(s => s.n === d);
      return !p || (p.status !== 'done' && p.status !== 'skipped');
    });
    // 前置没完成就不许调度后续步骤：这是依赖唯一能被真正执行的地方
    if (missing.length) return { ok: false, error: tr(L, 'agent.errStepDepsOpen', { n, deps: missing.join(', ') }) };
    task.currentStep = n;
  }
  step.status = status;
  const note = str(args.note, FIELD_MAX);
  if (note) step.note = note;
  task.counters.noProgress = 0;
  if (status === 'done') task.counters.steps++;
  // 「全部收口」要在任何终态迁移后判一次：只 done 才检查的话，最后一步被 skip 的
  // 任务会永远停在 executing
  if ((status === 'done' || status === 'skipped')
    && task.steps.every(s => s.status === 'done' || s.status === 'skipped')) task.phase = 'completed';
  return { ok: true, needsSnapshot: status === 'done' };
}

/* ---- 快照 ---- */

/**
 * 一次改盘之后登记「改前版本 id」：同一路径在本步内只记第一次（那才是本步起点的样子）。
 * 本轮新建的文件没有「改前」，只进 touched（跑偏拦截要认得它），回滚覆盖不到它，
 * 由快照单独列出来告知用户。
 */
export function noteChange(task, path, versionId) {
  if (!path) return;
  task.touched[path] = versionId || '';
  if (versionId && !task.pending[path]) task.pending[path] = versionId;
}

/** 本轮新建的文件：回滚不删用户目录里的东西，只如实列出来 */
export function noteCreate(task, path) {
  if (!path) return;
  task.touched[path] = '';
  task.pendingCreated[path] = true;
}

/** 子任务完成 → 把本步攒下的改前版本收成一个快照点（不是每步都存，省存储） */
export function takeSnapshot(task, stepN) {
  const files = task.pending;
  const created = Object.keys(task.pendingCreated);
  task.pending = {};
  task.pendingCreated = {};
  if (!Object.keys(files).length && !created.length) return null;
  const snap = { step: stepN || task.currentStep || 0, at: Date.now(), files, created };
  task.snapshots.push(snap);
  if (task.snapshots.length > 12) task.snapshots.shift();
  return snap;
}

/* ---- 审计 ---- */

export function recordAudit(task, entry) {
  task.audit.push(entry);
  if (task.audit.length > 400) task.audit.shift();
  return entry;
}

/* ---- 目标锚定与跑偏拦截 ---- */

/** 简报里始终回填原始目标：模型改写过的 goal 不能把用户那句话替换掉 */
export function anchoredGoal(task) {
  return task.goal;
}

/**
 * 写盘是否偏离当前子任务声明的落点。这是「前置校验」里唯一真正能自动判的部分——
 * 语义相关性要问模型（花钱），落点不一致是字符串就能判的。
 * 只在计划文本里确实出现过文件名时才启用；否则宁可放行——把没声明落点的步骤当成
 * 「不许改任何文件」只会让模型绕一圈再来一次。
 */
export function writeDrift(task, path) {
  if (task.phase !== 'executing' || !task.steps.length || !path) return false;
  const planText = task.steps.map(s => [s.title, s.deliverable, s.doneWhen, s.note].join(' ')).join(' ');
  if (!new RegExp(PATH_RE.source).test(planText)) return false;   // 计划没提过任何文件名 → 不设这道闸
  const hay = (planText + ' ' + task.goal + ' ' + Object.keys(task.touched).join(' ')).toLowerCase();
  const base = String(path).toLowerCase();
  if (hay.includes(base)) return false;
  // ch1/intro.tex 与 intro.tex 视为同一个落点
  const seg = base.split('/').pop();
  return !hay.includes(seg);
}

/* ---- 熔断 ---- */

export const CIRCUIT_LIMITS = { calls: 60, noProgress: 3 };

/**
 * @returns {null|{reason:string, n:number}} 命中即由框架终止，不再交给模型
 */
export function checkCircuit(task, cfg = {}) {
  const c = task.counters;
  if (c.calls >= (cfg.maxCalls || CIRCUIT_LIMITS.calls)) return { reason: 'calls', n: cfg.maxCalls || CIRCUIT_LIMITS.calls };
  if (c.noProgress >= (cfg.maxNoProgress || CIRCUIT_LIMITS.noProgress)) return { reason: 'no_progress', n: cfg.maxNoProgress || CIRCUIT_LIMITS.noProgress };
  if (cfg.deadlineMs && Date.now() - task.startedAt > cfg.deadlineMs) return { reason: 'time', n: Math.round(cfg.deadlineMs / 60000) };
  return null;
}

/** 一步结束时结算「有没有推进」：没有任何成功调用、也没改计划状态 → 计一次零推进 */
export function stepProgress(task, progressed) {
  task.counters.noProgress = progressed ? 0 : task.counters.noProgress + 1;
}

/* ---- 结构化简报（注入请求的工作记忆视图） ---- */

function phaseKey(p) {
  return 'agent.phase.' + p;
}

/**
 * 一小段结构化状态文本。刻意不含正文：模型要看内容请用工具读，
 * 这里只回答「我在做哪件事、这件事算完成的标准是什么、还剩多少额度」。
 */
export function taskBrief(task, remaining) {
  const L = getLang();
  const c = task.counters;
  const lines = [
    tr(L, 'agent.briefGoal', { goal: anchoredGoal(task) }),
    tr(L, 'agent.briefPhase', { phase: tr(L, phaseKey(task.phase)) }),
  ];
  if (task.steps.length) {
    const cur = task.steps.find(s => s.n === task.currentStep);
    if (cur) lines.push(tr(L, 'agent.briefCurrent', {
      n: cur.n, title: cur.title, deliverable: cur.deliverable, doneWhen: cur.doneWhen,
    }));
    lines.push(tr(L, 'agent.briefSteps', {
      done: task.steps.filter(s => s.status === 'done').length,
      total: task.steps.length,
      open: task.steps.filter(s => s.status === 'pending' || s.status === 'doing')
        .map(s => s.n + (s.deps.length ? '(' + tr(L, 'agent.briefDep', { deps: s.deps.join(',') }) + ')' : '')).join(' '),
    }));
    const blocked = task.steps.filter(s => s.status === 'blocked');
    if (blocked.length) lines.push(tr(L, 'agent.briefBlocked', { list: blocked.map(s => s.n + '：' + (s.note || '')).join('；') }));
  }
  if (Object.keys(task.touched).length) lines.push(tr(L, 'agent.briefTouched', { list: Object.keys(task.touched).join(', ') }));
  lines.push(tr(L, 'agent.briefQuota', {
    steps: c.steps, calls: c.calls, writes: c.writes,
    left: remaining != null ? remaining : '-',
  }));
  if (c.cacheHits) lines.push(tr(L, 'agent.briefCache', { n: c.cacheHits }));
  return lines.join('\n');
}

/** 收尾给人看的执行小结（阶段三验收与案例库都以此为骨架） */
export function taskSummary(task) {
  const done = task.steps.filter(s => s.status === 'done').map(s => s.n);
  const open = task.steps.filter(s => s.status !== 'done' && s.status !== 'skipped').map(s => s.n);
  return {
    id: task.id,
    goal: task.goal,
    phase: task.phase,
    circuit: task.circuit,
    doneSteps: done,
    openSteps: open,
    counters: { ...task.counters },
    touched: Object.keys(task.touched),
    snapshots: task.snapshots.length,
    audit: task.audit.slice(),
    durationMs: Date.now() - task.startedAt,
  };
}

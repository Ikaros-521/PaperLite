/**
 * 结果三重校验（评审 Agent）。
 *
 * 与执行 Agent 解耦：同一个模型刚写完东西，让它「自己说说对不对」基本只会得到一句
 * 「已完成」。所以这里用一份独立提示词、一次独立请求，只喂证据不喂它自己的思路，
 * 要求输出机器可解析的结论：
 *   1) 目标对齐——原始需求里的每一项是否都被处理；
 *   2) 过程审计——有没有越权改动、重复调用、被拦下的动作、失败却没交代的步骤；
 *   3) 结果质量——格式是否合规、结论有没有出处。
 * 代价是多一轮请求的 token，因此默认关（AI 设置里打开），用量单列不回混进主循环。
 */
import * as llm from '../llm.js';
import * as ctxBudget from '../context.js';
import { tr, getLang } from '../i18n.js';

const ANSWER_MAX = 6000;
// 评审是一次「不该拖住面板」的追加请求：给硬超时，超时即当作没评审，不改任务结论
const REVIEW_TIMEOUT_MS = 90_000;

/** 给评审看的证据：目标 + 计划 + 框架统计 + 失败清单 + 最终回答。不含中间工具正文 */
export function reviewEvidence(task, finalAnswer) {
  const L = getLang();
  const lines = [
    tr(L, 'agent.reviewGoal', { goal: task.goal || '' }),
    tr(L, 'agent.reviewPlan') + (task.steps || []).map(s => s.n + '. ' + s.title
      + ' [' + s.status + ']' + (s.deps && s.deps.length ? ' ←' + s.deps.join(',') : '')
      + ' | ' + tr(L, 'agent.reviewDeliverable') + ': ' + s.deliverable
      + ' | ' + tr(L, 'agent.reviewDoneWhen') + ': ' + s.doneWhen).join('\n'),
    tr(L, 'agent.reviewCounters', {
      calls: task.counters.calls, writes: task.counters.writes,
      blocked: task.counters.blocked, cache: task.counters.cacheHits,
      snaps: (task.snapshots || []).length,
    }),
  ];
  const failed = (task.audit || []).filter(a => a && !a.ok);
  lines.push(failed.length
    ? tr(L, 'agent.reviewFailedCalls', { list: failed.slice(-12).map(a => a.tool + '(' + (a.code || '?') + ')').join(', ') })
    : tr(L, 'agent.reviewNoFail'));
  const touched = Object.keys(task.touched || {});
  lines.push(touched.length ? tr(L, 'agent.reviewTouched', { list: touched.join(', ') }) : tr(L, 'agent.reviewNoTouched'));
  lines.push(tr(L, 'agent.reviewAnswer') + '\n' + String(finalAnswer || '').slice(0, ANSWER_MAX));
  return lines.filter(Boolean).join('\n');
}

export function reviewSystemPrompt() {
  const L = getLang();
  return tr(L, 'ai.reviewSystem', { lang: L === 'en' ? 'English' : '中文' });
}

/**
 * 从评审回答里取结论 JSON：从后往前找配对花括号，逐个试解析。
 * 只取「最后一个 {…}」的做法会被正文里的 LaTeX 带偏（`x^{2}` 收尾时那才是最后一个
 * 花括号），所以这里按深度配对回退，解析失败就继续往前找。
 */
function lastJsonObject(s) {
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] !== '}') continue;
    let depth = 0;
    for (let j = i; j >= 0; j--) {
      if (s[j] === '}') depth++;
      else if (s[j] === '{') {
        depth--;
        if (depth === 0) {
          try {
            const o = JSON.parse(s.slice(j, i + 1));
            if (o && typeof o === 'object' && !Array.isArray(o)) return o;
          } catch (e) { /* 不是合法 JSON，接着往前找 */ }
          break;
        }
        if (depth > 64) break;      // 越配越深说明这段不是我们找的块
      }
    }
  }
  return null;
}

export function parseVerdict(text) {
  const j = lastJsonObject(String(text || ''));
  if (!j || (!('goal_ok' in j) && !('process_ok' in j) && !('quality_ok' in j))) return null;
  const arr = (v) => Array.isArray(v) ? v.map(x => String(x)).slice(0, 8) : [];
  return {
    goalOk: j.goal_ok === true,
    missing: arr(j.missing),
    processOk: j.process_ok === true,
    processIssues: arr(j.process_issues),
    qualityOk: j.quality_ok === true,
    qualityIssues: arr(j.quality_issues),
  };
}

/**
 * @returns {Promise<{text:string, verdict:object|null, usage:object|null}>}
 * 请求失败由调用方兜（评审失败不该让已经做完的任务看起来失败了）。
 */
export async function runReview({ channel, task, finalAnswer, signal }) {
  const L = getLang();
  const evidence = reviewEvidence(task, finalAnswer);
  const budget = ctxBudget.inputBudget(channel);
  const built = ctxBudget.buildPayload({
    system: reviewSystemPrompt(),
    docHeader: tr(L, 'agent.reviewEvidenceHeader'),
    doc: evidence,
    summaryHeader: '',
    history: [{ role: 'user', content: tr(L, 'agent.reviewAsk') }],
    budget,
  });
  const res = await llm.chat(channel, built.messages, { stream: false, signal, timeoutMs: REVIEW_TIMEOUT_MS });
  return { text: res.content || '', verdict: parseVerdict(res.content), usage: res.usage || null };
}

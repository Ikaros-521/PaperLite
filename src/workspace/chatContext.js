/**
 * AI 对话的上下文构建（桌面与移动端共用）。
 *
 * 抽出来的原因：按 token 预算截断、"截断后才提示已截断"、段落边界向上向下扩展
 * 这些细节一旦两端各写一份，AI 拿到的上下文就会不一样，排查成本极高。
 * 这里不依赖 React：调用方把 CodeMirror 实例与当前文档传进来即可。
 */
import * as llm from '../llm.js';
import * as ctxBudget from '../context.js';
import { tr, getLang } from '../i18n.js';

function rangeText(cm, a, b) {
  const lines = [];
  for (let i = a; i <= b; i++) lines.push(cm.getLine(i) || '');
  return lines.join('\n');
}

/**
 * @param ctx {{ cm: () => any, doc: string }}
 * @returns {Promise<{ text: string, note: string, tokens: number, budget: number }>}
 */
export async function buildLLMContext(ctx, scope, query, channel) {
  const { cm: getCm, doc: docValue } = ctx;
  const c = getCm ? getCm() : null;
  const doc = docValue || '';
  const L = getLang();
  const budget = ctxBudget.docBudget(channel, scope);
  const omitted = '\n\n' + tr(L, 'app.ctxOmitted') + '\n\n';
  // 截断后确实验证超了预算才提示「已截断」，避免估算与展示不一致
  const fit = text => {
    const out = ctxBudget.truncateToTokens(text, budget, omitted);
    return { text: out, cut: out !== text };
  };
  const note = (base, cut) => base + (cut ? tr(L, 'app.ctxTruncated') : '');

  if (scope === 'selection') {
    const sel = c ? c.getSelection() : '';
    if (!sel) return { text: '', note: tr(L, 'app.ctxSelEmpty'), tokens: 0, budget };
    const full = ctxBudget.inputBudget(channel);
    const out = ctxBudget.truncateToTokens(sel, full, omitted);
    return { text: out, note: note(tr(L, 'app.ctxSel'), out !== sel), tokens: ctxBudget.estimateTokens(out), budget: full };
  }

  if (scope === 'paragraph') {
    if (!c) return { text: '', note: '', tokens: 0, budget };
    const cur = c.getCursor();
    let a = cur.line, b = cur.line;
    const n = c.lineCount();
    while (a > 0 && (c.getLine(a - 1) || '').trim()) a--;
    while (b < n - 1 && (c.getLine(b + 1) || '').trim()) b++;
    const f = fit(rangeText(c, a, b));
    return { text: f.text, note: note(tr(L, 'app.ctxPara', { a: a + 1, b: b + 1 }), f.cut), tokens: ctxBudget.estimateTokens(f.text), budget };
  }

  if (scope === 'retrieve') {
    if (channel && channel.embedModel) {
      const chunks = await llm.retrieve(channel, query, doc, 6);
      if (chunks && chunks.length) {
        const f = fit(chunks.join('\n\n——\n\n'));
        return { text: f.text, note: note(tr(L, 'app.ctxRag', { n: chunks.length }), f.cut), tokens: ctxBudget.estimateTokens(f.text), budget };
      }
    }
    const f = fit(doc);
    return { text: f.text, note: note(tr(L, 'app.ctxFallback'), f.cut), tokens: ctxBudget.estimateTokens(f.text), budget };
  }

  const f = fit(doc);
  return { text: f.text, note: note(tr(L, 'app.ctxFull'), f.cut), tokens: ctxBudget.estimateTokens(f.text), budget };
}

/** 一键修复全部诊断用的提示词 */
export function aiFixPrompt({ issues, doc, channel }) {
  const L = getLang();
  return tr(L, 'ai.fixPrompt', {
    issues: issues.map(d => tr(L, 'ai.errLine', { n: d.line != null ? d.line + 1 : '?', msg: d.msg })).join('\n'),
    doc: ctxBudget.truncateToTokens(doc, ctxBudget.docBudget(channel, 'full'), '\n\n' + tr(L, 'app.ctxOmitted') + '\n\n'),
  });
}

/** 单个（或一组）诊断预填到对话输入框的提示词 */
export function aiFixIssuePrompt({ issues, lines }) {
  const L = getLang();
  const detail = issues.map(d => {
    const src = d.line != null ? (lines[d.line] || '').slice(0, 300) : '';
    return tr(L, 'ai.errLineSrc', { n: d.line != null ? d.line + 1 : '?', msg: d.msg, src: src.trim() });
  }).join('\n');
  return tr(L, 'ai.fixIssuePrompt', { detail });
}

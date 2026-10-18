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
import { outlineOf } from './agentTools.js';

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

/**
 * Agent 模式的项目状态简报：活动文件 + 标签清单 + 大纲 + 选区长度 + 诊断数。
 * 渐进式披露：简报只放「元数据级」信息（路径/行数/大纲条目/长度/数量），
 * 正文、选区内容、诊断明细一律由模型按需用工具读取（read_file / read_selection /
 * get_diagnostics），避免每轮请求都携带大块可能用不上的上下文。
 */
export function agentProjectBrief({ cm, tabs, activeId, tabPath, diagnostics }) {
  const L = getLang();
  const c = cm ? cm() : null;
  const openTabs = (tabs || []).filter(x => x && x.doc);
  const activeTab = openTabs.filter(x => x.id === activeId())[0] || null;
  const lines = [];
  if (activeTab) {
    const text = c ? c.getValue() : activeTab.doc.getValue();
    const lineCount = text.split('\n').length;
    lines.push(tr(L, 'agent.briefActive', { path: tabPath(activeTab), n: lineCount }));
    const outline = outlineOf(text);
    if (outline.length) lines.push(tr(L, 'agent.briefOutline') + '\n  ' + outline.join('\n  '));
    // 只报「有选区、多长」，不附内容：与选区无关的问题不必为此付出 token
    const sel = c ? c.getSelection() : '';
    if (sel) lines.push(tr(L, 'agent.briefSel', { n: sel.length }));
  }
  const others = openTabs.filter(x => x !== activeTab).map(tabPath);
  if (others.length) lines.push(tr(L, 'agent.briefTabs') + ' ' + others.join(', '));
  const issues = diagnostics || [];
  if (issues.length) lines.push(tr(L, 'agent.briefDiag', { n: issues.length }));
  lines.push(tr(L, 'agent.briefHint'));
  return lines.join('\n');
}

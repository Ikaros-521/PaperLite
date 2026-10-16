/**
 * AI 上下文构建（桌面与移动端共用一份）：token 预算、截断标记、段落边界、修复提示词。
 * 这里钉住的是「两端必须一致」的部分——一旦谁各写一份，AI 拿到的上下文就会不同且极难排查。
 */
import assert from 'node:assert/strict';
import { buildLLMContext, aiFixPrompt, aiFixIssuePrompt } from '../src/workspace/chatContext.js';
import * as ctxBudget from '../src/context.js';
import { setLang, tr } from '../src/i18n.js';

setLang('zh');

/** CodeMirror 的最小面：真实编辑器与脱离编辑器的 Doc 都满足这几个方法 */
function fakeCm(lines, { selection = '', cursor = { line: 0, ch: 0 } } = {}) {
  return {
    getSelection: () => selection,
    getCursor: () => cursor,
    lineCount: () => lines.length,
    getLine: n => lines[n],
  };
}
const ctxOf = (lines, opts, doc) => ({ cm: () => fakeCm(lines, opts), doc: doc == null ? lines.join('\n') : doc });
const channel = { chatModel: 'glm-4' }; // 已知窗口模型，预算走推断而不是兜底 32k

// ---------- 全文：未超预算原样给出，超了才截断并在提示里说明 ----------
(async () => {
  const short = ctxOf(['\\section{引言}', '内容。']);
  const full = await buildLLMContext(short, 'full', '', channel);
  assert.equal(full.text, '\\section{引言}\n内容。');
  assert.ok(!full.note.includes(tr('zh', 'app.ctxTruncated')), '没截断就不该说截断');
  assert.equal(full.tokens, ctxBudget.estimateTokens(full.text));
  assert.ok(full.budget >= 256);

  const long = 'x'.repeat(40) + ' ' + '\\alpha '.repeat(4000);
  const tiny = { ctxWindow: 1000 }; // 最小窗口：文档预算压到 307 token，长文必然截断
  const big = await buildLLMContext({ cm: () => null, doc: long }, 'full', '', tiny);
  assert.ok(big.text.length < long.length, '超预算必须截断');
  assert.ok(big.text.includes(tr('zh', 'app.ctxOmitted')), '截断处要有省略标记');
  assert.ok(big.note.includes(tr('zh', 'app.ctxTruncated')));
  assert.ok(big.tokens <= ctxBudget.docBudget(tiny, 'full'), '估算口径不能超预算');

  // ---------- 选区 ----------
  const empty = await buildLLMContext(ctxOf(['a'], { selection: '' }), 'selection', '', channel);
  assert.equal(empty.tokens, 0);
  assert.equal(empty.note, tr('zh', 'app.ctxSelEmpty'));
  const sel = await buildLLMContext(ctxOf(['a'], { selection: '选中的公式' }), 'selection', '', channel);
  assert.equal(sel.text, '选中的公式');
  // 选区独占整个输入预算（不需要再塞整篇文档）
  assert.equal(sel.budget, ctxBudget.inputBudget(channel));
  assert.ok(sel.note.startsWith(tr('zh', 'app.ctxSel')));

  // ---------- 段落：从光标向上向下扩到空行为止，行号给人看所以是 1-based ----------
  const para = ['', '第一行', '第二行', '', '第三行'];
  const p = await buildLLMContext(ctxOf(para, { cursor: { line: 2, ch: 3 } }), 'paragraph', '', channel);
  assert.equal(p.text, '第一行\n第二行');
  assert.ok(p.note.includes('2') && p.note.includes('3'), '提示里要带上起止行号');

  // ---------- 检索增强：没配嵌入模型必须回落全文，不能空上下文 ----------
  const rag = await buildLLMContext(ctxOf(['正文']), 'retrieve', '问题', channel);
  assert.equal(rag.text, '正文');
  assert.equal(rag.note, tr('zh', 'app.ctxFallback') + '');

  // ---------- 编辑器缺失（图片/PDF 标签）：段落范围返回空而不是抛错 ----------
  const noCm = await buildLLMContext({ cm: () => null, doc: '正文' }, 'paragraph', '', channel);
  assert.equal(noCm.text, '');

  // ---------- 一键修复的提示词：行号 1-based、引擎级错误不编造行号 ----------
  const issues = [{ line: 0, msg: 'Missing $ inserted' }, { line: null, msg: 'Emergency stop' }];
  const fix = aiFixPrompt({ issues, doc: '\\begin{document}\nx', channel });
  assert.ok(fix.includes('第 1 行：Missing $ inserted'), '首行问题要报成第 1 行');
  assert.ok(fix.includes('第 ? 行：Emergency stop'), '行号未知用 ? 占位，不能编造行号');
  assert.ok(fix.includes('\\begin{document}'), '修复提示词要带源码');

  const injected = aiFixIssuePrompt({ issues: [{ line: 1, msg: 'Undefined control sequence' }], lines: ['a', '\\foo{b}', 'c'] });
  assert.ok(injected.includes('\\foo{b}'), '预填提示词要带出错那一行的源码');
  assert.ok(injected.includes('第 2 行'), '行号 1-based');
  const longLine = aiFixIssuePrompt({ issues: [{ line: 0, msg: 'x' }], lines: ['\\long'.repeat(200)] });
  assert.ok(longLine.length < 500, '源码片段要截断，超长行不能整条塞进对话');

  console.log('Chat context: budget-fit truncation, selection/paragraph/RAG-fallback scopes and AI-fix prompts passed.');
})();

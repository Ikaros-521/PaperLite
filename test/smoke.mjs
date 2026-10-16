/* PaperLite 冒烟测试（Node + 真实 KaTeX） */
import { readFileSync } from 'node:fs';
import { renderLatex } from '../src/engines/latex.js';
import { renderMarkdown, renderMarkdownFull } from '../src/engines/markdown.js';
import { lintLaTeX } from '../src/engines/linter.js';
import { collectIssues, currentCompileErrors } from '../src/diagnostics.js';
import * as TIKZ from '../src/engines/tikz.js';
import { samples } from '../src/engines/samples.js';
import * as C from '../src/context.js';
import { DICT, setLang } from '../src/i18n.js';
import { THEME_IDS, DEFAULT_THEME, detectTheme } from '../src/theme.js';

const PICK_TO_TOKEN = { '--t-desk': '--desk', '--t-paper': '--paper', '--t-accent': '--accent', '--t-seal': '--seal' };

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.error('  ✗ FAIL:', msg); }
}

// ---------- demo 模板 ----------
console.log('== demo 模板（真实 KaTeX）==');
const src = samples.demo;
const res = renderLatex(src);
ok(res.html.includes('摘要'), '包含摘要');
ok(res.html.includes('doc-title'), '包含标题块');
ok((res.html.match(/<h2 /g) || []).length === 5, '5 个一级章节, got ' + (res.html.match(/<h2 /g) || []).length);
ok(res.html.includes('class="katex"'), 'KaTeX 真实渲染输出');
ok((res.html.match(/class="katex"/g) || []).length >= 10, '≥10 处公式');
ok(res.html.includes('eq-no">(1)<'), '公式编号 (1)');
ok(res.html.includes('tabular'), '包含表格');
ok(res.html.includes('r-toprule'), '三线表规则线');
ok(res.html.includes('图&nbsp;1：'), '图 1 题注');
ok(res.html.includes('表&nbsp;2：'), '表 2 题注');
ok(res.html.includes('BiLSTM-Att'), '宏 \\model 已展开');
ok(res.html.includes('参考文献'), '参考文献');
ok(res.html.includes('[1]'), '引用回填 [1]');
ok(res.html.includes('mermaid-block'), 'mermaid 块');
ok(res.html.includes('footnotes'), '脚注');
ok(res.diagrams.length === 1, '1 个 tikz 图');
ok(res.warnings.length === 0, '零警告, got: ' + res.warnings.slice(0, 5).join(' | '));
ok(res.headings.length === 8 && res.headings.every(h => h.offset > 0), '大纲 8 条且含偏移: ' + JSON.stringify(res.headings.map(h => [h.text, h.offset])));

// ---------- 源码区间回切 ----------
console.log('== 区间回切 ==');
const dg = res.diagrams[0];
ok(dg.svg && dg.svg.includes('<svg'), 'tikz svg 生成');
ok((dg.svg.match(/class="tk-node"/g) || []).length === 7, '7 个绘制节点, got ' + (dg.svg.match(/class="tk-node"/g) || []).length);
ok(dg.svg.includes('marker-end'), '箭头 marker');
const rawNode = dg.nodes.filter(n => n.name === 'raw')[0];
ok(!!rawNode, '节点 raw 存在');
if (rawNode) ok(src.slice(rawNode.optStart, rawNode.optEnd).startsWith('data, text width=2.6cm'), 'raw 选项回切正确');
const blockRange = dg.tikzsetRanges.filter(r => r.name === 'block')[0];
ok(!!blockRange, 'block 样式区间存在');
if (blockRange) ok(src.slice(blockRange.start, blockRange.end).startsWith('rectangle, rounded corners=6pt'), 'block 样式回切正确');
if (blockRange) {
  const list = TIKZ.parseOpts(src.slice(blockRange.start, blockRange.end));
  TIKZ.setOpt(list, 'fill', 'red!40');
  ok(TIKZ.buildOpts(list).includes('fill=red!40'), '选项重建');
}

// ---------- flow 模板 ----------
console.log('== flow 模板 ==');
const res2 = renderLatex(samples.flow);
const dg2 = res2.diagrams[0];
ok(res2.diagrams.length === 1 && dg2.nodes.length >= 6, 'flow 节点数 >= 6, got ' + (dg2 ? dg2.nodes.length : 0));
ok(dg2.svg.includes(' Q '), 'bend 曲线');
ok((dg2.svg.match(/marker-end/g) || []).length >= 6, '箭头数 >= 6');
ok(res2.warnings.length === 0, 'flow 零警告, got: ' + res2.warnings.slice(0, 5).join(' | '));

// ---------- blank / 颜色 ----------
console.log('== blank / 颜色 ==');
ok(renderLatex(samples.blank).html.includes('摘要内容'), 'blank 渲染');
ok(TIKZ.parseColor('blue!20') === '#ccccff', 'blue!20');
ok(TIKZ.parseColor('red!50!blue') === '#800080', 'red!50!blue');

// ---------- Markdown 引擎 ----------
console.log('== Markdown 引擎 ==');
const mdSrc = [
  '# 项目笔记',
  '',
  '行内公式 $E=mc^2$ 与显示公式：',
  '',
  '$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$',
  '',
  '| 列A | 列B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '```mermaid',
  'flowchart LR',
  '  A-->B',
  '```',
  '',
  '```js',
  'const x = 1; // 代码中的 $ 不应被当数学处理',
  '```',
  '',
  '**加粗** 与 *斜体*，[链接](https://example.com)。'
].join('\n');
const mdHtml = renderMarkdown(mdSrc);
ok(mdHtml.includes('<h1 id="mdh-0">项目笔记</h1>'), 'md 一级标题(带锚点)');
ok((mdHtml.match(/class="katex"/g) || []).length >= 2, 'md 数学渲染（行内+行间）');
ok(mdHtml.includes('<table>') && mdHtml.includes('<th>列A</th>'), 'md 表格');
ok(mdHtml.includes('mermaid-block') && mdHtml.includes('flowchart'), 'md mermaid 块');
ok(mdHtml.includes('language-js'), 'md 代码块语言类');
ok(mdHtml.includes('const x = 1'), 'md 代码块内容保留');
ok(mdHtml.includes('<strong>加粗</strong>'), 'md 加粗');
ok(mdHtml.includes('<a href="https://example.com"'), 'md 链接');

// ---------- Markdown 大纲提取 ----------
console.log('== Markdown 大纲 ==');
const mdFull = renderMarkdownFull('# 一级\n\n正文\n\n### 三级\n\n## 二级\n\n```js\n# 注释非标题\n```\n\n## 二级2');
ok(mdFull.headings.length === 4, 'md 大纲条数 4, got ' + mdFull.headings.length);
ok(mdFull.headings[0].line === 0 && mdFull.headings[1].level === 3 && mdFull.headings[3].line === 12, 'md 大纲行号/层级: ' + JSON.stringify(mdFull.headings));
ok(!mdFull.headings.some(h => h.text.includes('注释非标题')), 'md 代码围栏内不识别为标题');

// ---------- LaTeX 语法检测 ----------
console.log('== LaTeX 语法检测 ==');
const bad = [
  '\\documentclass{ctexart}',
  '\\begin{document}',
  '\\section{引言}',
  '正文 $x 未闭合',
  '\\ref{missing-label}',
  '\\begin{itemize}',
  '  \\item A',
  '\\end{document}'
].join('\n');
const ds = lintLaTeX(bad);
ok(ds.some(d => d.kind === 'env' && d.line === 5), '未关闭环境定位到第 6 行: ' + JSON.stringify(ds.filter(d => d.kind === 'env').map(d => (d.line + 1) + ':' + d.msg)));
ok(ds.some(d => d.kind === 'math' && d.line === 3), '奇数 $ 警告在第 4 行');
ok(ds.some(d => d.kind === 'ref' && d.msg.includes('missing-label')), '未定义 label 引用');
const good = lintLaTeX(samples.demo);
ok(good.filter(d => d.kind === 'env' || d.kind === 'brace').length === 0, '示例论文环境/花括号零错误: ' + JSON.stringify(good.slice(0, 3)));
ok(lintLaTeX('text % { $ \\begin{itemize}').length === 0, '注释中的括号、公式和环境不误报');
ok(lintLaTeX('text \\% {').some(d => d.kind === 'brace'), '转义百分号后仍检查真实语法');
ok(lintLaTeX('{fixed}').length === 0 && lintLaTeX('{broken').some(d => d.kind === 'brace'), '修改后重新检测，已修复的错误消失');
ok(lintLaTeX('On a five-level delay sweep ($\\Delta \\in \\{60, 300, 600, 900, 1800\\}$\\,s.').length === 0, '转义花括号紧随公式结尾不误报奇数 $');
ok(lintLaTeX('Price is \\$100 and \\$200').length === 0, '转义美元 \\$ 不计入数学环境');
ok(lintLaTeX('Formula \\\\$x$').length === 0, '换行 \\\\ 后的行内公式 $x$ 正常配对');
ok(lintLaTeX('Formula \\\\\\$100').length === 0, '换行 \\\\ 后跟随转义 \\$ 不误报');
ok(lintLaTeX('set \\{1, 2, 3\\}').length === 0, '转义花括号 \\{ \\} 不影响环境括号深度');

// ---------- 主题皮肤 ----------
console.log('== 主题皮肤 ==');
const readSrc = f => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const themesCss = readSrc('themes.css');
const appCss = readSrc('app.css');
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
// 打印样式与图表波浪线 data-URI 必须固定白/固定色，允许出现字面颜色
const printBlock = (appCss.match(/@media print\s*\{[\s\S]*?\n\}/) || [''])[0];
const chrome = stripComments(appCss.replace(printBlock, '')).replace(/url\("[^"]*"\)/g, 'url()');
const chromeColors = chrome.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d/g) || [];
ok(!chromeColors.length, 'app.css 界面样式不该写死颜色：' + chromeColors.join(' '));
ok(detectTheme() === DEFAULT_THEME, '读不到偏好时回退默认皮肤');

// 每套皮肤 = 一个 /* @palette */ 块，且 token 集合完全一致（少一个就会露出默认暖白）
const palettes = [...themesCss.matchAll(/\/\* @palette \*\/\s*([^{}]*)\{([^{}]*)\}/g)]
  .map(m => ({ sel: m[1], body: m[2], ids: [...m[1].matchAll(/data-theme="([^"]+)"/g)].map(x => x[1]) }));
ok(palettes.length === THEME_IDS.length, '每套皮肤一个 @palette 块：' + palettes.length + ' vs ' + THEME_IDS.length);
const tokensOf = body => [...new Set((body.match(/(^|[;{\s])(--[a-z0-9-]+)\s*:/g) || []).map(s => s.replace(/[^a-z0-9-]/g, '')))];
const inkTokens = tokensOf(palettes[0].body);
ok(palettes.every(p => p.ids.some(id => THEME_IDS.includes(id))), '调色板都对应已注册皮肤');
ok(inkTokens.some(t => t.startsWith('--doc-')) && inkTokens.some(t => t.startsWith('--syn-')) === false, '@palette 块含纸面色调、不含语法色');
for (const p of palettes.slice(1)) {
  const mine = tokensOf(p.body);
  for (const t of inkTokens) ok(mine.includes(t), p.ids.join('/') + ' 缺少 token ' + t);
  for (const t of mine) ok(inkTokens.includes(t), p.ids.join('/') + ' 多出 token ' + t);
}

// 皮肤 id 三方对齐：theme.js 注册表 ↔ themes.css 的 [data-theme] / [data-pick] ↔ DICT 文案
for (const id of THEME_IDS) {
  ok(new RegExp('\\[data-theme="' + id + '"\\]').test(themesCss), '缺少 [data-theme="' + id + '"] 调色板');
  ok(new RegExp('\\[data-pick="' + id + '"\\]').test(themesCss), '缺少 [data-pick="' + id + '"] 缩略色');
  for (const l of ['zh', 'en']) ok(DICT[l]['theme.' + id], l + ' 缺少文案 theme.' + id);
}
ok(THEME_IDS.includes(DEFAULT_THEME) && palettes[0].sel.includes(':root'), '默认皮肤挂在 :root 上兜底');

// 选择器缩略色与真实调色板同源
const propVal = (body, name) => (body.match(new RegExp(name + '\\s*:\\s*([^;]+);')) || [, ''])[1].trim().toLowerCase();
for (const p of palettes) for (const [pick, real] of Object.entries(PICK_TO_TOKEN)) {
  const block = (themesCss.match(new RegExp('\\[data-pick="' + (p.ids[0]) + '"\\] \\{([^}]*)\\}')) || [, ''])[1];
  ok(propVal(block, pick) === propVal(p.body, real), p.ids[0] + ' 的 ' + pick + ' 缩略色与调色板不一致');
}

// app.css 用到的变量都得有定义，否则该处直接失去颜色
const declared = new Set((stripComments(appCss + themesCss).match(/(^|[;{\s])(--[a-z0-9-]+)\s*:/g) || []).map(s => s.replace(/[^a-z0-9-]/g, '')));
const referenced = new Set([...(appCss + themesCss).matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]));
for (const v of referenced) ok(declared.has(v), '变量无人定义：' + v);

console.log('== 诊断生命周期 ==');
const compileError = { line: 0, msg: 'Undefined control sequence' };
const compiled = { tabId: 1, source: '\\unknown', errors: [compileError] };
ok(currentCompileErrors(compiled, 1, '\\unknown').length === 1, '当前文件与源码匹配时显示编译错误');
ok(currentCompileErrors(compiled, 1, 'fixed').length === 0, '修改源码后不再显示旧编译错误');
ok(currentCompileErrors(compiled, 2, '\\unknown').length === 0, '相同源码的另一文件不继承错误');
ok(currentCompileErrors(null, 1, '').length === 0, '无编译结果时不显示编译错误');
const issues = collectIssues([{ line: 1, msg: 'brace', severity: 'error' }], ['render'], [compileError]);
ok(issues.map(d => d.src).join(',') === 'compile,lint,render', '统一收集全部诊断并保留来源');
ok(new Set(issues.map(d => d.id)).size === 3, '每条提示独立标识，可逐条忽略');
const remaining = issues.filter(d => d.id !== issues[0].id);
ok(remaining.length === 2 && remaining.filter(d => d.line != null).length === 1, '忽略编译错误时计数和行内标记同步移除');

console.log('== 上下文预算（token 口径）==');
ok(C.inferWindow('claude-sonnet-4-5') === 200000, 'Claude 200k');
ok(C.inferWindow('gpt-4o') === 128000 && C.inferWindow('deepseek-chat') === 64000, 'OpenAI 128k / DeepSeek 64k');
ok(C.inferWindow('moonshot-v1-32k') === 32000, '模型名后缀显式窗口');
ok(C.inferWindow('some-random-model') === 0 && C.inferWindow('') === 0, '认不出返回 0');
ok(C.resolveWindow({ chatModel: 'gpt-4o' }).tokens === 128000, '默认按模型推断');
ok(C.resolveWindow({ chatModel: 'gpt-4o', ctxWindow: 8000 }).tokens === 8000, '自定义覆盖优先于推断');
ok(C.resolveWindow({ chatModel: 'unknown-x' }).tokens === C.FALLBACK_WINDOW, '未知模型走兜底窗口');
const chDs = { chatModel: 'deepseek-chat' };
ok(C.inputBudget(chDs) === C.resolveWindow(chDs).tokens - C.outputReserve(chDs) - Math.max(256, Math.round(64000 * 0.02)), '输入预算 = 窗口 − 输出预留 − 估算余量');
ok(C.estimateTokens('') === 0, '空文本 0 token');
ok(C.estimateTokens('这是一段中文论文引言') > 8 && C.estimateTokens('This is an introduction paragraph.') < 10, '中文按字计、英文按密度计');
ok(C.formatTokens(999) === '999' && C.formatTokens(12345) === '12.3k' && C.formatTokens(200000) === '200k', 'token 缩写');
const longDoc = 'A'.repeat(40000) + '\n' + '研究'.repeat(2000);
const cutDoc = C.truncateToTokens(longDoc, 500, '……中略……');
ok(C.estimateTokens(cutDoc) <= 500 && cutDoc.includes('中略') && cutDoc.length < longDoc.length, '按 token 截断且不超预算: ' + C.estimateTokens(cutDoc));
ok(C.truncateToTokens('short text', 500, '……') === 'short text', '未超预算原样返回');
const hist = [];
for (let i = 0; i < 24; i++) hist.push({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(2000) });
const built = C.buildPayload({ system: 'sys', docHeader: 'DOC', doc: 'd'.repeat(8000), summaryHeader: 'SUM', history: hist, budget: 8000 });
ok(built.usage.total <= 8000 && built.usage.dropped > 0, '历史超预算时丢最早条: total=' + built.usage.total + ' dropped=' + built.usage.dropped);
ok(built.messages[0].role === 'system' && built.messages[1].role === 'system' && built.messages[1].content.startsWith('DOC'), '系统提示与文档块在最前');
ok(built.messages[built.messages.length - 1].content === hist[hist.length - 1].content, '本轮提问始终保留');
const tight = C.buildPayload({ system: 's', history: [{ role: 'user', content: 'hi' }], budget: 10 });
ok(tight.messages.length === 2 && tight.usage.dropped === 0, '预算极小也至少保留本轮提问');
const withSummary = C.buildPayload({
  system: 's', summaryHeader: 'SUM', budget: 8000,
  history: [{ role: 'assistant', kind: 'summary', content: '要点' }, ...hist.slice(-4)]
});
ok(withSummary.messages[1].role === 'system' && withSummary.messages[1].content.startsWith('SUM'), '摘要按 system 注入而非冒充用户发言');
const sp = C.splitForCompact(hist, 6);
ok(sp && sp.head.length === hist.length - 6 && sp.tail.length === 6, '压缩切分保留末尾 6 条');
ok(C.splitForCompact(hist.slice(0, 6), 6) === null, '对话太短不压缩');
ok(C.splitForCompact(new Array(9).fill({ role: 'assistant', kind: 'summary', content: 'a' }), 6) === null, '只剩摘要时不重复压缩');
ok(C.summaryBudget({ chatModel: 'claude-sonnet-4-5' }) <= 2000 && C.summaryBudget({ chatModel: 'glm-4.5-flash' }) >= 600, '摘要预算夹在 600~2000，避免摘要请求打满窗口');
ok(C.rawUsage({ system: 'sys', history: hist }).total > built.usage.history, 'rawUsage 不裁剪，可显示超出预算');
ok(C.historyToText([{ role: 'user', content: 'u' }, { role: 'assistant', kind: 'summary', content: 's' }], { user: 'U', assistant: 'A', summary: 'S' }).split('\n')[1].startsWith('S:'), '摘要历史再次压缩时保留标记');

console.log('== 预览国际化 ==');
const bilingualSource = String.raw`\documentclass{ctexart}
\begin{document}
\maketitle\today
\begin{abstract}Author content stays unchanged.\end{abstract}
\tableofcontents\section{Author heading}
\begin{figure}Image\caption{Author caption}\label{fig:a}\end{figure}
\begin{table}Data\caption{Author table}\end{table}
\Cref{fig:a}\eqref{eq:a}\cite{missing}
\begin{thebibliography}{9}\bibitem{a}Author reference\end{thebibliography}
\end{document}`;
setLang('en');
const englishPreview = renderLatex(bilingualSource);
for (const text of ['Abstract', 'Contents', 'References', 'Figure&nbsp;1: ', 'Table&nbsp;1: ', 'Untitled document', 'Not found in references', 'Eq.&nbsp;', 'Figure 1']) {
  ok(englishPreview.html.includes(text), '英文预览包含 ' + text);
}
ok(!/[\u4e00-\u9fff]/.test(englishPreview.html), 'ctex 文档的英文预览无内置中文文案');
ok(englishPreview.warnings.some(w => w.includes('Undefined reference')), '英文引用诊断');
setLang('zh');
const chinesePreview = renderLatex(bilingualSource);
for (const text of ['摘要', '目录', '参考文献', '图&nbsp;1：', '表&nbsp;1：', '无标题文档']) {
  ok(chinesePreview.html.includes(text), '切回中文预览包含 ' + text);
}
ok(chinesePreview.html.includes('Author content stays unchanged.'), '切语言保留作者正文');
// 英文完整性：这些命名空间是界面文案，缺 en 或夹了汉字都会在英文界面上露出中文
// （mb.* 是移动端各 flow 的文案，见 src/flows/mobile/i18n/）
for (const key of Object.keys(DICT.zh).filter(k => k.startsWith('style.') || k.startsWith('render.') || k.startsWith('mb.'))) {
  ok(typeof DICT.en[key] === 'string' && DICT.en[key].length > 0, '英文文案存在: ' + key);
  ok(!/[\u4e00-\u9fff]/.test(DICT.en[key]), '英文翻译完整: ' + key);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

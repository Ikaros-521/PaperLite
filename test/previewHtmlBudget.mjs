/* 渲染产物预算回归（Node）
 *
 * 钉住的退化：previewBudget 只有入口那道源码闸，产物侧没有。行内公式实测约 99.5 倍放大
 * ——0.76MB 源码（在 1MB 闸内）拼出 76MB HTML 字符串、耗时 3.6s，然后还要当 innerHTML
 * 解析成约 500 万个 DOM 节点。现在叶子处累计超限即抛，调用方换成降级预览。
 * 预算实例必须按渲染创建：挂模块上会让上一篇文档的量算到下一篇头上。
 */
import assert from 'node:assert/strict';
import { renderLatex } from '../src/engines/latex.js';
import { renderMarkdownFull, renderChatMarkdown } from '../src/engines/markdown.js';
import { RENDER_MAX_HTML, RENDER_MAX_SRC, makeHtmlBudget, isHtmlBudgetTrip, capHtmlResult, tooLargeHtmlResult, tooLargeResult } from '../src/previewBudget.js';

const B = String.fromCharCode(92);
const N = String.fromCharCode(10);

// ---- 1. 计数器本身：超限即抛、按实例隔离、能认出是自己抛的 ----
{
  const b = makeHtmlBudget(1000);
  b.add(999);
  assert.equal(b.total, 999, '未超限时正常累计');
  assert.throws(() => b.add(2), (e) => isHtmlBudgetTrip(e) && e.bytes === 1001, '超限必须抛、可识别、并带上已累计体积');
  const other = makeHtmlBudget(1000);
  other.add(1);                       // 上一个实例抛过，不影响新实例
  assert.equal(other.total, 1, '预算必须按渲染建实例，不能共享累计');
  assert.equal(isHtmlBudgetTrip(new Error('boom')), false, '普通异常不该认成预算');
  assert.equal(isHtmlBudgetTrip(undefined), false, '没有异常不该抛');
}

// ---- 2. LaTeX 路径：百倍放大必须在中途被拦下，而不是拼完 76MB 再说 ----
{
  const src = '$x$ '.repeat(120000);            // 0.46MB 源码，修前实测拼出 45.5MB HTML
  assert.ok(src.length < RENDER_MAX_SRC, '夹具要留在源码闸内，否则测的是入口那道闸');
  const t0 = performance.now();
  let threw = null;
  try { renderLatex(src, {}); } catch (e) { threw = e; }
  const took = performance.now() - t0;
  assert.ok(isHtmlBudgetTrip(threw), '百倍放大必须触发产物预算，实测抛的是：' + threw);
  assert.ok(threw.bytes > RENDER_MAX_HTML && threw.bytes < RENDER_MAX_HTML * 2,
    '按公式粒度结算：该在刚过上限时就停，实测 ' + threw.bytes);
  assert.ok(took < 1500, '拦截要快，实测 ' + took.toFixed(0) + 'ms');
}
// 正常论文规模不受影响（样例里就有公式、表格、交叉引用）
{
  const { samples } = await import('../src/engines/samples.js');
  for (const [k, v] of Object.entries(samples)) {
    const text = typeof v === 'string' ? v : (v && (v.content || v.text));
    if (typeof text !== 'string') continue;
    const r = renderLatex(text, {});
    assert.ok(r.html.length < RENDER_MAX_HTML, '样例 ' + k + ' 不该触发预算');
    assert.equal(capHtmlResult(r, text), r, '样例 ' + k + ' 的结果必须原样通过');
  }
}

// ---- 3. Markdown 路径同一道闸；聊天气泡故意不套（抛出会顶掉整个面板）----
{
  const src = ('$x$ ' + N + N).repeat(40000);
  let threw = null;
  try { renderMarkdownFull(src); } catch (e) { threw = e; }
  assert.ok(isHtmlBudgetTrip(threw), 'Markdown 预览同样要触发产物预算，实测：' + threw);
  const chat = renderChatMarkdown('公式 $E=mc^2$ 与 $a_1$ 收尾');
  assert.ok(typeof chat === 'string' && chat.includes('katex'), '聊天正文照常渲染');
}

// ---- 4. 降级结果形状：与正常渲染、与源码超限降级三者字段一致 ----
{
  // 调用方在渲染成功后补 src（写回面板要靠它校验区间），所以正常形状也要算上这一项
  const normal = [...Object.keys(renderLatex('正文 $x$', {})), 'src'].sort();
  const byHtml = Object.keys(tooLargeHtmlResult('正文', RENDER_MAX_HTML + 1, 'zh')).sort();
  const bySrc = Object.keys(tooLargeResult('正文', 'zh')).sort();
  assert.deepEqual(byHtml, normal, '产物降级对象缺字段就是渲染期抛错（PreviewPane 读 meta、TablePanel 读 tables/src）');
  assert.deepEqual(bySrc, normal, '源码降级对象与产物降级对象必须同形状');
  assert.ok(byHtml.includes('tables') && byHtml.includes('meta') && byHtml.includes('headings'), '至少这几个是面板直接读的');
}

// ---- 5. 兜底层：叶子没计到的放大路径（表格/环境）由 capHtmlResult 拦 ----
{
  const big = { html: 'x'.repeat(RENDER_MAX_HTML + 10), meta: {}, warnings: [], diagrams: [], tables: [], headings: [], stats: {}, src: '' };
  const capped = capHtmlResult(big, 'x');
  assert.notEqual(capped, big, '超长产物必须换成降级结果');
  assert.ok(capped.html.includes('render-error'), '降级结果是可读横幅，不是异常文本');
  assert.ok(!capped.html.includes('xxx'), '产物内容不该渗进降级横幅');
  const small = { html: '<p>ok</p>' };
  assert.equal(capHtmlResult(small, 'x'), small, '没超限原样返回');
}

// ---- 6. 桌面 catch 的两条分支各给对的形状（预算→降级，异常→横幅）----
{
  const tripped = tooLargeHtmlResult('正文 $x$', RENDER_MAX_HTML, 'zh');
  assert.ok(tripped.html.includes('MB'), '降级文案要带上实际体积，用户才知道差多少');
  assert.ok(!isTexErrorBanner(tripped.html), '预算触发不该显示成「渲染器异常」');
  const banner = '<div class="render-error">渲染器异常：boom</div>';
  assert.ok(isTexErrorBanner(banner), '真异常仍走横幅');
}
function isTexErrorBanner(html) { return /渲染器异常|Renderer error/.test(html); }

console.log('previewHtmlBudget: all tests passed');

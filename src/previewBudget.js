/* 实时预览的规模预算与降级结果。
 *
 * 单独成模块的原因：渲染同步跑在主线程上，行内公式的输出放大实测约 85 倍
 * （84KB 源码 → 7.1MB HTML），叠加 fs.js 的 2MB 打开上限，畸形文稿能把标签页先冻结再撑爆。
 * 这道闸此前只有桌面有，移动端每键全量 renderLatex，长文直接卡死；
 * 降级对象也必须在这里统一产出——少一个字段（meta/tables）就是渲染期抛错，
 * 而全仓没有 ErrorBoundary，一处漂移就是整棵组件树白屏。
 */
import { tr, getLang } from './i18n.js';
import { escHtml } from './htmlEsc.js';

// 与 fs.js 的 2MB 打开上限留出倍数余量，正常论文（几十~几百 KB）够不着
export const RENDER_MAX_SRC = 1024 * 1024;

/** 中英文混排的字数统计：预览页脚与状态栏共用同一口径 */
export function countOf(s) {
  const str = String(s || '');
  const cjk = (str.match(/[一-鿿]/g) || []).length;
  const latin = (str.replace(/[一-鿿]/g, ' ').match(/[A-Za-z0-9][A-Za-z0-9'’\-]*/g) || []).length;
  return { cjk, words: latin + cjk };
}

export function fmtSize(s) {
  const bytes = new Blob([String(s || '')]).size;
  return bytes < 1024 ? bytes + ' B' : (bytes / 1024).toFixed(1) + ' KB';
}

/** 超预算时的降级预览结果：形状与正常结果一致，调用方不必再各自补字段 */
export function tooLargeResult(text, L) {
  return {
    html: '<div class="render-error">' + escHtml(tr(L || getLang(), 'app.previewTooLarge', { size: fmtSize(text) })) + '</div>',
    meta: {}, warnings: [], diagrams: [], tables: [], stats: countOf(text), headings: [], src: String(text || ''),
  };
}

// ---------------- 产物预算 ----------------
// 只卡源码长度挡不住放大：行内公式的产物实测约 99.5 倍（0.76MB 源码 → 76MB HTML 字符串，
// 渲染 3.6s），而那 76MB 还要当 innerHTML 解析成约 500 万个 DOM 节点。所以除了入口的
// RENDER_MAX_SRC，产物这一侧也要有一道闸，并且要在叶子节点（每个公式）处累计，
// 否则字符串已经建完了才拦，等于只拦住了后半段。
export const RENDER_MAX_HTML = 8 * 1024 * 1024;
const HTML_BUDGET_CODE = 'render_html_budget';

/**
 * 一次渲染专用的产物计数器。必须按渲染建实例：挂到模块上会让上一篇文档的量
 * 算到下一篇头上，聊天气泡与预览共用一条公式渲染路径时尤其致命。
 * 超限即抛，由调用方（App 的 latexResult/mdResult、移动端 result）换成降级结果。
 */
export function makeHtmlBudget(limit) {
  const max = limit || RENDER_MAX_HTML;
  let n = 0;
  return {
    get total() { return n; },
    add(len) {
      n += len;
      if (n > max) {
        const e = new Error('render html budget exceeded: ' + n + ' > ' + max);
        e.code = HTML_BUDGET_CODE;
        // 带上已累计的体积：降级横幅要说「渲染出 9.2 MB（上限 8 MB）」，
        // 而不是把上限当实测值报——那样用户看不出到底超了多少
        e.bytes = n;
        throw e;
      }
    },
  };
}

/** 是不是产物预算触发的抛出（区别于真的渲染异常：前者该降级显示，后者才给错误横幅） */
export function isHtmlBudgetTrip(e) { return !!(e && e.code === HTML_BUDGET_CODE); }

/** 产物已经超预算时的降级结果；与 tooLargeResult 同形状，少一个字段就是渲染期抛错 */
export function tooLargeHtmlResult(text, htmlLen, L) {
  // fmtSize 收的是字符串（按 UTF-8 字节量），这里手里是长度数字，别再绕它一层
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  return {
    html: '<div class="render-error">' + escHtml(tr(L || getLang(), 'app.previewHtmlTooLarge',
      { size: mb(htmlLen), limit: mb(RENDER_MAX_HTML) })) + '</div>',
    meta: {}, warnings: [], diagrams: [], tables: [], stats: countOf(text), headings: [], src: String(text || ''),
  };
}

/** 叶子累计之外的兜底：整篇产物过长同样降级（表格等非公式路径的放大由这层拦） */
export function capHtmlResult(r, text, L) {
  const len = r && typeof r.html === 'string' ? r.html.length : 0;
  return len > RENDER_MAX_HTML ? tooLargeHtmlResult(text, len, L) : r;
}

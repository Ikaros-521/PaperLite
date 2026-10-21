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

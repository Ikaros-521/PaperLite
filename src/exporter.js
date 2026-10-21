/* PaperLite · 导出模块（ESM）：打印 PDF / .tex / HTML / SVG / PNG */
import { t } from './i18n.js';
import { showAlert as alert } from './dialogs.js';
import { escHtml } from './htmlEsc.js';

export function downloadFile(name, content, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

export function exportTex(source, name) {
  downloadFile(name || 'paper.tex', source, 'text/x-tex;charset=utf-8');
}

// 收集当前页面样式（含 KaTeX 字体），转绝对地址供打印窗口复用
function collectStyleTags() {
  let out = '';
  document.querySelectorAll('link[rel="stylesheet"]').forEach(l => {
    try { out += '<link rel="stylesheet" href="' + new URL(l.getAttribute('href'), location.href).href + '">'; } catch (e) { /* ignore */ }
  });
  document.querySelectorAll('style').forEach(s => {
    const t = s.textContent || '';
    if (t.includes('KaTeX') || t.includes('.paper') || t.includes('print-body') || t.length < 20000) out += '<style>' + t + '</style>';
  });
  return out;
}

// 打印为 PDF：调起浏览器打印，选「另存为 PDF」得到矢量文档
export function exportPDF(contentHtml, meta) {
  const title = meta && meta.title ? meta.title.replace(/<[^>]*>/g, '') : t('exp.docTitle');
  // 排版语法（\documentclass[选项]{类}）解析出的类名与变量要一起带进打印文档，
  // 否则预览看到的双栏/字号在导出 PDF 里全丢
  const layout = (meta && meta.layout) || {};
  const paperCls = 'paper' + (layout.classes ? ' ' + layout.classes : (meta && meta.twocolumn ? ' twocolumn' : ''));
  const paperVars = Object.keys(layout.vars || {}).map(k => k + ':' + layout.vars[k]).join(';');
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title>' +
    collectStyleTags() +
    '<style>' + PRINT_CSS + '</style></head><body class="print-body">' +
    '<div class="' + esc(paperCls) + '"' + (paperVars ? ' style="' + esc(paperVars) + '"' : '') + '>' + contentHtml + '</div></body></html>';

  // 不用 window.open + document.write：about:blank 继承应用源，写进去的 <script> 与
  // onerror 会真的执行。当前渲染链的转义是完备的，但这个入口会把未来任何一处漏转义
  // 从「标记错乱」放大成同源 XSS（能读 localStorage 里的 API key）。
  // 沙箱 iframe 不给 allow-scripts → 脚本一律不执行；allow-same-origin 保留，
  // 我们仍要读它的 readyState / fonts 并调 print()。
  const frame = document.createElement('iframe');
  if (!('srcdoc' in frame)) { alert(t('exp.popupBlocked')); return; }
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  frame.srcdoc = html;
  document.body.appendChild(frame);

  const cleanup = () => { setTimeout(() => frame.remove(), 500); };
  let tries = 0;
  const doc = () => { try { return frame.contentDocument; } catch (e) { return null; } };
  (function goPrint() {
    tries++;
    const d = doc();
    if (!d) { cleanup(); return; }
    const fontsReady = !(d.fonts && d.fonts.status !== 'loaded');
    if (d.readyState === 'complete' && fontsReady) {
      setTimeout(() => {
        try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch (e) { /* 用户取消打印 */ }
        cleanup();
      }, 120);
      return;
    }
    if (tries > 40) { // 字体迟迟不加载完也要出稿，只是可能回落成系统衬线
      try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch (e) { /* 同上 */ }
      cleanup();
      return;
    }
    setTimeout(goPrint, 250);
  })();
}

// 统一走 htmlEsc：这里的输出全在引号包围的属性与 <title> 里，少转义一个双引号
// 就等于让 \documentclass 的选项能往外拼属性（导出沙箱不给 allow-scripts，
// 但标记错乱照样毁排版）
const esc = escHtml;

// viewBox 容忍逗号/多空格分隔与缺项：畸形值落回 0，后续统一夹到 ≥32（NaN 会把 canvas 归零、导出空白图）
function parseViewBox(el) {
  const vb = (el.getAttribute('viewBox') || '0 0 100 100').split(/[\s,]+/).filter(Boolean).map(Number);
  return [vb[0] || 0, vb[1] || 0, vb[2] || 0, vb[3] || 0];
}

// 序列化预览中的 SVG（补 xmlns 与白底）
export function serializeSvg(svgEl, bgColor) {
  const clone = svgEl.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const vb = parseViewBox(clone);
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', vb[0]); bg.setAttribute('y', vb[1]);
  bg.setAttribute('width', vb[2]); bg.setAttribute('height', vb[3]);
  bg.setAttribute('fill', bgColor || '#ffffff');
  clone.insertBefore(bg, clone.firstChild);
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
}

export function exportSvg(svgEl, name) {
  downloadFile(name || 'diagram.svg', serializeSvg(svgEl), 'image/svg+xml;charset=utf-8');
}

export function exportPng(svgEl, name, scale) {
  scale = scale || 2;
  const svgStr = serializeSvg(svgEl);
  const vb = parseViewBox(svgEl);
  const w = Math.max(32, vb[2]), h = Math.max(32, vb[3]);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' }));
  img.onload = () => {
    const cv = document.createElement('canvas');
    cv.width = w * scale; cv.height = h * scale;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    cv.toBlob(blob => {
      URL.revokeObjectURL(url);
      // 超大画布会被浏览器拒绝编码，toBlob 给 null；直接下载会得到一个无效的假 PNG
      if (!blob) { alert(t('exp.pngFailed')); return; }
      downloadFile(name || 'diagram.png', blob, 'image/png');
    }, 'image/png');
  };
  img.onerror = () => { alert(t('exp.pngFailed')); URL.revokeObjectURL(url); };
  img.src = url;
}

// 打印排版（A4、衬线、分页控制），与预览样式保持一致
export const PRINT_CSS = [
  '@page { size: A4; margin: 2.2cm 2.2cm 2.4cm; }',
  'html, body { margin: 0; padding: 0; }',
  'body { font-family: "Noto Serif SC","Source Han Serif SC","Times New Roman",Georgia,"SimSun",serif; color: #111; font-size: 12pt; line-height: 1.65; }',
  '.paper { max-width: 100%; margin: 0 auto; --doc-scale: 1; --doc-col-gap: 1.5em; font-size: calc(12pt * var(--doc-scale)); }',
  // 排版语法：双栏与 IEEEtran 版式（与 app.css 的预览规则同一套类名）
  '.paper.twocolumn, .paper .doc-cols { column-count: 2; column-gap: var(--doc-col-gap); text-indent: 0; }',
  '.paper .doc-cols figure.float, .paper .doc-cols table.tabular, .paper .doc-cols .equation, .paper .doc-cols .ieee-bio { break-inside: avoid-column; }',
  '.paper .doc-cols h2.sec1, .paper .doc-cols h3.sec2, .paper .doc-cols h4.sec3 { break-after: avoid; }',
  '.cls-ieee .doc-heads { display: flex; justify-content: space-between; font-size: 8.5pt; text-transform: uppercase; border-bottom: 0.5pt solid #999; padding-bottom: .3em; margin-bottom: 1em; }',
  '.cls-ieee h1.doc-title { font-size: 1.4em; text-align: center; }',
  '.cls-ieee .au-row { text-align: center; } .cls-ieee .au-affil { font-size: .86em; color: #333; white-space: pre-line; }',
  '.cls-ieee .au-columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(150pt, 1fr)); gap: .5em 1.2em; }',
  '.cls-ieee .au-thanks { font-size: 8pt; font-style: italic; text-align: center; margin: .6em 0 1em; }',
  '.cls-ieee .ieee-abstract, .cls-ieee .ieee-keywords { max-width: 92%; margin: .7em auto; font-size: 10pt; border: 0; background: none; padding: 0; }',
  '.cls-ieee h2.sec1 .secnum::after { content: "."; }',
  '.cls-ieee .ieee-abstract p, .cls-ieee .ieee-keywords p { display: inline; text-indent: 0; margin: 0; }',
  '.cls-ieee .abs-label, .cls-ieee .kw-label { font-weight: 700; font-style: italic; }',
  '.cls-ieee h2.sec1 { font-size: 1em; text-transform: uppercase; text-align: center; letter-spacing: .03em; }',
  '.cls-ieee h3.sec2 { font-style: italic; text-align: center; font-size: 1em; }',
  '.cls-ieee .ieeepar-c { float: left; font-size: 2.75em; line-height: .78; font-weight: 700; padding-right: .08em; }',
  '.cls-ieee .ieeepar-w { font-variant: small-caps; }',
  '.cls-ieee figure.ieee-bio { break-inside: avoid; }',
  '.cls-ieee figure.ieee-bio .bio-photo { float: left; width: 68pt; margin: 0 10pt 6pt 0; }',
  '.cls-ieee figure.ieee-bio .bio-name { font-weight: 700; font-variant: small-caps; }',
  '.cls-ieee figure.ieee-bio .bio-text { font-size: 10pt; }',
  '.cls-ieee .qed { float: right; }',
  'p { margin: .5em 0; text-indent: 2em; }',
  'h1.doc-title { font-size: 17pt; text-align: center; margin: .3em 0 .8em; }',
  '.doc-author { text-align: center; } .doc-date { text-align: center; color: #444; margin-bottom: 1.4em; }',
  '.abstract { margin: 0 1.5em 1.2em; padding: .5em 1em; border: 0.5pt solid #999; font-size: 10.5pt; }',
  '.abstract h4 { margin: 0 0 .3em; }',
  '.abstract p { text-indent: 2em; margin: .2em 0; }',
  'h2.sec1 { font-size: 14pt; margin: 1.2em 0 .5em; break-after: avoid; }',
  'h3.sec2 { font-size: 12.5pt; margin: 1em 0 .4em; break-after: avoid; }',
  'h4.sec3 { font-size: 12pt; margin: .8em 0 .3em; break-after: avoid; }',
  '.secnum { margin-right: .4em; }',
  'figure.float { margin: 1em auto; text-align: center; break-inside: avoid; }',
  'figure.float figcaption { font-size: 10.5pt; color: #222; margin-top: .5em; text-align: center; }',
  'img.includegraphics { max-width: 100%; }',
  'table.tabular { border-collapse: collapse; margin: .8em auto; break-inside: avoid; font-size: 11pt; --rg: 0px; }',
  'table.tabular td { padding: calc(.3em + var(--rg)) .8em; text-align: center; }',
  'table.tabular td.ta-l { text-align: left; } table.tabular td.ta-r { text-align: right; }',
  'table.tabular td.vline { border-left: 0.5pt solid #444; } table.tabular td.vline:first-child { border-left: none; }',
  'table.tabular tr.r-toprule td { border-top: 1pt solid #111; }',
  'table.tabular tr.r-midrule td { border-top: 0.5pt solid #111; }',
  'table.tabular tr.r-bottomrule td { border-bottom: 1pt solid #111; }',
  'table.tabular tr.r-hline td { border-bottom: 0.4pt solid #666; }',
  '.equation { display: flex; align-items: center; justify-content: space-between; margin: .7em 0; break-inside: avoid; }',
  '.equation .eq-body { flex: 1; text-align: center; overflow-x: hidden; }',
  '.eq-no { margin-left: 1em; }',
  '.footnotes { font-size: 10pt; margin-top: 2em; } .footnotes hr { width: 30%; margin-left: 0; }',
  '.bibliography { margin-top: 1.5em; break-before: page; }',
  '.bib-list { padding-left: 2em; font-size: 10.5pt; } .bib-list li { margin: .25em 0; }',
  '.toc { border: 0.5pt solid #aaa; padding: .6em 1.2em; margin: 1em 0; font-size: 11pt; }',
  '.toc ul { list-style: none; padding-left: 0; margin: 0; } .toc .toc-l2 { padding-left: 1.5em; } .toc .toc-l3 { padding-left: 3em; }',
  'blockquote { margin: .8em 1.5em; padding-left: 1em; border-left: 2pt solid #999; color: #333; }',
  'pre.verbatim { font-family: Consolas,"Courier New",monospace; font-size: 10pt; background: #f6f6f6; padding: .6em; white-space: pre-wrap; break-inside: avoid; }',
  '.pagebreak { break-before: page; height: 0; }',
  '.cite { font-size: 0.92em; } .bad-ref { color: #c00; } .math-error { color: #c00; }',
  '.center { text-align: center; } .flushleft { text-align: left; } .flushright { text-align: right; }',
  '.diagram { text-align: center; margin: .8em 0; break-inside: avoid; }',
  '.diagram svg { max-width: 100%; height: auto; }',
  'ul.latex-list, ol.latex-list { margin: .5em 0 .5em 2em; padding: 0; }',
  'ol.latex-list { list-style: decimal; } ul.latex-list { list-style: disc; }',
  'li { margin: .2em 0; }'
].join('\n');

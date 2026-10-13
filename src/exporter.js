/* PaperLite · 导出模块（ESM）：打印 PDF / .tex / HTML / SVG / PNG */
import { t } from './i18n.js';

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
  const w = window.open('', '_blank');
  if (!w) { alert(t('exp.popupBlocked')); return; }
  const title = meta && meta.title ? meta.title.replace(/<[^>]*>/g, '') : t('exp.docTitle');
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title>' +
    collectStyleTags() +
    '<style>' + PRINT_CSS + '</style></head><body class="print-body">' +
    '<div class="paper">' + contentHtml + '</div></body></html>';
  w.document.open(); w.document.write(html); w.document.close();
  let tries = 0;
  (function goPrint() {
    tries++;
    try {
      if (w.document.readyState === 'complete' && w.document.fonts && w.document.fonts.status === 'loaded') {
        setTimeout(() => { w.focus(); w.print(); }, 120);
        return;
      }
      if (w.document.readyState === 'complete' && tries > 8) {
        setTimeout(() => { w.focus(); w.print(); }, 120);
        return;
      }
      setTimeout(goPrint, 250);
    } catch (e) {
      if (tries > 12) { try { w.print(); } catch (e2) { /* give up */ } }
    }
  })();
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// 序列化预览中的 SVG（补 xmlns 与白底）
export function serializeSvg(svgEl, bgColor) {
  const clone = svgEl.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const vb = (clone.getAttribute('viewBox') || '0 0 100 100').split(/\s+/).map(Number);
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
  const vb = (svgEl.getAttribute('viewBox') || '0 0 100 100').split(/\s+/).map(Number);
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
      downloadFile(name || 'diagram.png', blob, 'image/png');
      URL.revokeObjectURL(url);
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
  '.paper { max-width: 100%; margin: 0 auto; }',
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
  'table.tabular { border-collapse: collapse; margin: .8em auto; break-inside: avoid; font-size: 11pt; }',
  'table.tabular td { padding: .3em .8em; text-align: center; }',
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

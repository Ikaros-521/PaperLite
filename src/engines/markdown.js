/* PaperLite · Markdown 渲染引擎（ESM，Node 可单测）
 * markdown-it 基础上：$$/$ 数学 → KaTeX；```mermaid 代码块 → 复用预览的 Mermaid 懒渲染；
 * 代码块带 language- 类名；数学只在非代码片段中处理。
 */
import MarkdownIt from 'markdown-it';
import katex from 'katex';

const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: true });

function renderMathSafe(tex, display) {
  try {
    return katex.renderToString(tex, { displayMode: !!display, throwOnError: false, strict: false });
  } catch (e) {
    const esc = String(tex).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<span class="math-error">' + esc + '</span>';
  }
}

// 在非 <code>/<pre> 片段中处理 $..$ / $$..$$
function mathPass(html) {
  const parts = html.split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/g);
  return parts.map((seg, i) => {
    if (i % 2 === 1) return seg; // 代码片段原样
    let out = seg.replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => '@@MDX' + btoa64(unescape(encodeURIComponent('@@D@@' + t))) + '@@');
    out = out.replace(/\$([^$\n]+?)\$/g, (_, t) => '@@MDX' + btoa64(unescape(encodeURIComponent('@@I@@' + t))) + '@@');
    return out;
  }).join('');
}

// 无依赖 base64（兼容非 ASCII）
function btoa64(s) {
  if (typeof btoa === 'function') return btoa(s);
  return Buffer.from(s, 'binary').toString('base64');
}
function atob64(s) {
  if (typeof atob === 'function') return atob(s);
  return Buffer.from(s, 'base64').toString('binary');
}

export function renderMarkdown(src) {
  return renderMarkdownFull(src).html;
}

// 渲染 + 提取大纲（标题层级/行号/锚点 id），供大纲面板跳转
export function renderMarkdownFull(src) {
  const str = String(src || '');
  // 扫描标题（跳过代码围栏），生成与渲染顺序一致的 id
  const headings = [];
  let inFence = false;
  str.split('\n').forEach((line, idx) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) headings.push({ level: m[1].length, text: m[2].replace(/[*`_#]/g, '').trim(), line: idx, id: 'mdh-' + headings.length });
  });

  let html = md.render(str);
  // 按顺序注入 id
  let hi = 0;
  html = html.replace(/<(h[1-6])>/g, (_, tag) => {
    const id = hi < headings.length ? headings[hi].id : '';
    hi++;
    return id ? '<' + tag + ' id="' + id + '">' : '<' + tag + '>';
  });

  // mermaid 代码块 → 占位 div（由 PreviewPane 懒渲染）
  html = html.replace(/<pre><code class="language-mermaid[\s\S]*?<\/code><\/pre>/g, (m) => {
    const code = m.replace(/^<pre><code[^>]*>/, '').replace(/<\/code><\/pre>$/, '')
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return '<div class="diagram mermaid-block" data-code="' + encodeURIComponent(code.trim()) + '"></div>';
  });
  html = mathPass(html);
  // 回填数学
  html = html.replace(/@@MDX([A-Za-z0-9+/=]+)@@/g, (_, b64) => {
    let raw;
    try { raw = decodeURIComponent(escape(atob64(b64))); } catch (e) { return ''; }
    if (raw.startsWith('@@D@@')) return '<div class="equation"><span class="eq-body">' + renderMathSafe(raw.slice(5), true) + '</span></div>';
    return renderMathSafe(raw.slice(5), false);
  });
  return { html, headings };
}

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

// 引用块前缀剥掉后按普通行匹配：markdown-it 会把 `> # x` 渲染成 <blockquote><h1>
const stripBqMark = s => s.replace(/^\s*(?:>\s?)+/, '');
// 锚点按文本配对：两侧都去掉标签/实体/多余空白后比较
const normHeading = s => String(s == null ? '' : s)
  .replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();

// 渲染 + 提取大纲（标题层级/行号/锚点 id），供大纲面板跳转
export function renderMarkdownFull(src) {
  const str = String(src || '');
  // 扫描标题（跳过代码围栏），生成与渲染顺序一致的 id。除 ATX 外也认 setext
  // （Title\n=====）与引用块内标题——markdown-it 都会渲染成 <hN>，漏扫会让
  // 后续锚点整体前移、大纲点跳到上一个标题。围栏按 CommonMark 要求缩进 ≤3 空格。
  const headings = [];
  let inFence = false;
  const lines = str.split('\n');
  lines.forEach((line, idx) => {
    if (/^ {0,3}(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const plain = stripBqMark(line);
    const m = plain.match(/^(#{1,6})\s+(.*)$/);
    if (m) { headings.push({ level: m[1].length, text: m[2].replace(/[*`_#]/g, '').trim(), line: idx, id: 'mdh-' + headings.length }); return; }
    // setext 只认 `=` 下划线：`-` 与主题线/列表记号有歧义，误认会造出假标题
    const next = lines[idx + 1] || '';
    if (line.trim() && /^ {0,3}=+\s*$/.test(next)) {
      headings.push({ level: 1, text: line.replace(/[*`_#]/g, '').trim(), line: idx, id: 'mdh-' + headings.length });
    }
  });

  let html = md.render(str);
  // 注入锚点：优先按标题文本配对而不是纯按顺序——扫描与渲染偶有形态出入
  // （漏扫的标题形态），纯位置配对会把锚点装到别的标题上；文本没对上再退回顺序
  const pending = headings.slice();
  html = html.replace(/<h([1-6])>([^<]*)<\/h\1>/g, (full, lvl, inner) => {
    const innerN = normHeading(inner);
    let k = pending.findIndex(h => normHeading(h.text) === innerN);
    if (k < 0 && pending.length) k = 0;
    if (k < 0) return full;
    const h = pending.splice(k, 1)[0];
    return '<h' + lvl + ' id="' + h.id + '">' + inner + '</h' + lvl + '>';
  });

  // mermaid 代码块 → 占位 div（由 PreviewPane 懒渲染）
  html = html.replace(/<pre><code class="language-mermaid[\s\S]*?<\/code><\/pre>/g, (m) => {
    const code = m.replace(/^<pre><code[^>]*>/, '').replace(/<\/code><\/pre>$/, '')
      // &amp; 必须最后解码：先解会把源码里字面的 &lt; 变成 <（实体被二次反转义）
      .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
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

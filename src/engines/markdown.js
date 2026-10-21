/* PaperLite · Markdown 渲染引擎（ESM，Node 可单测）
 * markdown-it 基础上：$$/$ 数学 → KaTeX；```mermaid 代码块 → 复用预览的 Mermaid 懒渲染；
 * 代码块带 language- 类名；数学只在非代码片段中处理。
 */
import MarkdownIt from 'markdown-it';
import katex from 'katex';
import { escHtml } from '../htmlEsc.js';
import { makeHtmlBudget } from '../previewBudget.js';

const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: true });
// 聊天气泡另开一份：模型习惯一行一句（不空行），不认单换行会把整段糊成一行；
// 关掉 typographer，免得把 " -- (c) 换成弯引号与破折号——聊天里的内容常被抄回编辑器
const mdChat = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });

function renderMathSafe(tex, display, budget) {
  let html;
  try {
    html = katex.renderToString(tex, { displayMode: !!display, throwOnError: false, strict: false });
  } catch (e) {
    const esc = String(tex).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    html = '<span class="math-error">' + esc + '</span>';
  }
  // 产物预算在叶子处累计（与 engines/latex.js 的 renderMath 同一口径）：一个公式的 HTML
  // 可达源码的百倍，整篇拼完再量就只剩拦住后半段了
  if (budget) budget.add(html.length);
  return html;
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

// 把 mathPass 藏起来的 @@MDX...@@ 还原成 KaTeX。
// 聊天那份 md 开了 breaks，段内换行已经变成 <br> 混进公式里了，先还原成空格再交给 KaTeX
function mathBackfill(html, budget) {
  return html.replace(/@@MDX([A-Za-z0-9+/=]+)@@/g, (_, b64) => {
    let raw;
    try { raw = decodeURIComponent(escape(atob64(b64))).replace(/<br\s*\/?>/gi, ' '); } catch (e) { return ''; }
    if (raw.startsWith('@@D@@')) return '<div class="equation"><span class="eq-body">' + renderMathSafe(raw.slice(5), true, budget) + '</span></div>';
    return renderMathSafe(raw.slice(5), false, budget);
  });
}

export function renderMarkdown(src) {
  return renderMarkdownFull(src).html;
}

/** 聊天气泡用的 Markdown：同一套 markdown-it + KaTeX，但三处刻意不一样——
 *  不注入标题锚点（mdh-N 是预览大纲的跳转目标，混进气泡会撞 id、大纲跳错地方）；
 *  链接一律新窗口打开（点一下不该把正在写的稿子整页换掉）；
 *  图片只留替代文字（CSP 的 img-src 不含远程 http，外链图必然显示成破图）。 */
export function renderChatMarkdown(src) {
  // 聊天气泡故意不套产物预算：预算靠抛出中断渲染，而 ChatPanel 没有 try/catch 兜这条路径，
  // 全仓也没有 ErrorBoundary——抛出等于把整个对话面板顶掉。模型单条回答的长度另有上限（llm.js）
  const html = mathBackfill(mathPass(mdChat.render(String(src || ''))));
  return html
    .replace(/<a href=/g, '<a target="_blank" rel="noopener noreferrer" href=')
    .replace(/<img\b([^>]*)>/g, (tag, attrs) => {
      const alt = /alt="([^"]*)"/.exec(attrs);
      return alt && alt[1] ? '<span class="md-img">' + alt[1] + '</span>' : '';
    });
}

/** 聊天正文切块：``` 围栏按任意语言收出来单独画（要挂复制/替换按钮，且不能交给
 *  md 渲染成 <pre>），其余段落再走 renderChatMarkdown。
 *  裸围栏也算 tex——本项目让模型回的代码块绝大多数就是不标语言的 LaTeX 片段。 */
export function splitChatBlocks(src) {
  const str = String(src || '');
  const out = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = re.exec(str))) {
    if (m.index > last) out.push({ type: 'md', text: str.slice(last, m.index) });
    const lang = String(m[1] || '').trim().split(/\s+/)[0].toLowerCase();
    const tex = !lang || lang === 'latex' || lang === 'tex';
    out.push({ type: 'code', lang, tex, text: m[2] });
    last = re.lastIndex;
  }
  if (last < str.length) out.push({ type: 'md', text: str.slice(last) });
  return out;
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
    // encodeURIComponent 恰好把 " < > 都转成了 %xx，所以今天没洞；但它不是转义器——
    // 与 engines/latex.js:1258 同一口径再过一遍 escHtml，别把「碰巧安全」写成惯例
    return '<div class="diagram mermaid-block" data-code="' + escHtml(encodeURIComponent(code.trim())) + '"></div>';
  });
  html = mathPass(html);
  // 回填数学（本次渲染一份独立预算，超限抛出 → 调用方换成降级预览）
  html = mathBackfill(html, makeHtmlBudget());
  return { html, headings };
}

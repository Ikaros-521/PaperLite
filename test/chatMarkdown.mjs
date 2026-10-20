/* 聊天正文的 Markdown：围栏切块 + 气泡渲染口径（换行、锚点、链接、图片、转义、数学） */
import assert from 'node:assert';
import { renderChatMarkdown, splitChatBlocks, renderMarkdownFull } from '../src/engines/markdown.js';

// 切块结果压成一行字符串，断言读得动
const shape = (src) => splitChatBlocks(src)
  .map((b) => (b.type === 'code' ? `code:${b.lang || '-'}${b.tex ? ':tex' : ''}` : 'md'));

console.log('== 切块 ==');
assert.deepEqual(
  shape('前\n```latex\n\\begin{abstract}\nx\n\\end{abstract}\n```\n中\n```json\n{"a":1}\n```\n尾'),
  ['md', 'code:latex:tex', 'md', 'code:json', 'md'],
  '任意语言的围栏都单独成块，回写按钮只给 latex/tex');
assert.deepEqual(shape('```\n\\alpha\n```'), ['code:-:tex'], '裸围栏算 LaTeX（本项目让模型回的默认形态）');
assert.deepEqual(shape('a\n```tex\nx\n```'), ['md', 'code:tex:tex'], 'tex 别名同 latex');
assert.deepEqual(shape('```JSON\n{}\n```'), ['code:json'], '语言名大小写归一，且不再切出空 md 段');
assert.deepEqual(shape('正文\n```latex\n\\frac{1}{2}'), ['md'], '流式进行中的未闭合围栏不吞正文');
assert.deepEqual(shape(''), [], '空正文不产出块');

console.log('== 渲染 ==');
const md = renderChatMarkdown('## 要点\n\n- **粗** 与 `code`\n- 第二项\n\n| a | b |\n|---|---|\n| 1 | 2 |');
for (const [frag, why] of [
  ['<h2', '标题'], ['<ul>', '无序列表'], ['<strong>', '粗体'], ['<code>', '行内代码'], ['<table>', '表格'],
]) assert.ok(md.includes(frag), why + ' 要渲染：' + md);

assert.ok(renderChatMarkdown('第一行\n第二行').includes('<br>'), '气泡认单换行（模型习惯一行一句）');
assert.ok(!renderMarkdownFull('第一行\n第二行').html.includes('<br>'), '文档预览仍按严格段落，两处口径不同是有意的');

const link = renderChatMarkdown('[文档](https://example.com) 与 https://auto.com/x');
assert.ok(link.includes('target="_blank"') && link.includes('rel="noopener noreferrer"'), '链接新窗口打开，不把编辑器整页换掉');
assert.ok((link.match(/target="_blank"/g) || []).length === 2, '手写链接与 linkify 出来的链接都加窗口属性');
assert.ok(link.includes('href="https://auto.com/x"'), '裸 URL linkify');

const img = renderChatMarkdown('![图 1](https://example.com/a.png)');
assert.ok(!img.includes('<img') && img.includes('md-img') && img.includes('图 1'), '外链图降级成替代文字（CSP 不放远程 img）');

assert.ok(renderChatMarkdown('<b>粗</b> <i>斜</i>').includes('&lt;b&gt;'), '原始 HTML 转义，不注入标签');
assert.ok(!renderChatMarkdown('# 标题').includes('mdh-'), '不注入标题锚点（会和预览大纲撞 id）');
assert.ok(renderMarkdownFull('# 标题').html.includes('mdh-0'), '对照：预览才注入锚点');

assert.ok(renderChatMarkdown('把 `$x$` 原样留着').includes('<code>$x$</code>'), '代码里的 $ 不当公式');
assert.ok(renderChatMarkdown('质能 $E=mc^2$ 守恒').includes('katex'), '行内公式走 KaTeX');
const disp = renderChatMarkdown('推导：\n\n$$\nL = \\frac{1}{2}mv^2\n$$\n');
assert.ok(disp.includes('katex-display') && !disp.includes('katex-error'), '跨行 display 公式不被 breaks 注入的 <br> 打断');
assert.ok(renderChatMarkdown('\\textbf{x} -- 与 "引号" (c)').includes('\\textbf{x}'), 'LaTeX 命令原样保留');
const typo = renderChatMarkdown('"引号" -- 破折 (c)');
assert.ok(typo.includes('&quot;引号&quot;') && typo.includes('--') && !typo.includes('©'),
  '聊天关 typographer：弯引号、破折号与版权号都不改写正文（内容要能原样抄回编辑器）');

console.log('chatMarkdown: all tests passed');

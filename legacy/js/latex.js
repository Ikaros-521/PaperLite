/* PaperLite · LaTeX → HTML 渲染器（论文常用子集）
 *
 * 关键设计：
 *  - 注释用「等长空格替换」抹除，保证渲染时统计的偏移量与原文档一一对应，
 *    从而支持样式面板把修改精确写回源码（tikz.js 里的节点/样式区间同理）。
 *  - 宏 (\newcommand) 预扫描后在文本/数学片段中按需展开。
 *  - 交叉引用 / 引文 / 脚注 / 目录 先用占位符，渲染结束后统一回填。
 * 返回 { html, meta, warnings, diagrams, stats, headings }
 */
(function (global) {
'use strict';

var TIKZ = null; // 延迟取 PaperLite.tikz

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 链接 scheme 白名单（与 src/engines/latex.js 同口径）：无 scheme 的相对路径/锚点放行，
// http/https/mailto/tel 放行，javascript:/data:/vbscript: 一律清空——文档内容不可信，
// 预览里的链接不能一点就执行脚本。判定前按 URL 规范归一：解析器会删掉控制空白与 C0，
// `java<TAB>script:` 和 <C0>javascript: 在浏览器里就是 javascript:。
function normUrl(u) {
  return String(u == null ? '' : u).replace(/[\x00-\x1f\x7f]/g, '').trim();
}
function safeUrl(u) {
  var s = normUrl(u);
  var seg = s.split(/[/?#]/)[0];
  var m = seg.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):/);
  if (!m) return s;
  var k = m[1].toLowerCase();
  return (k === 'http' || k === 'https' || k === 'mailto' || k === 'tel') ? s : '';
}
// \includegraphics 只该指向项目内文件：带 scheme 或 // 开头的值在渲染时会自动发起
// 出站请求（不需要点击），打开第三方 .tex 就泄露 IP 与文档路径
function localAssetPath(u) {
  var s = normUrl(u);
  if (s.indexOf('//') === 0) return '';
  var seg = s.split(/[/?#]/)[0];
  return seg.indexOf(':') < 0 ? s : '';
}

// ---------------- 偏移工具（等长原则） ----------------
// 把行内注释(%..行尾)替换为等长空格，保留换行
function blankComments(src) {
  var out = src.split(''), n = src.length, i = 0;
  while (i < n) {
    var c = src.charAt(i);
    if (c === '\\') { i += 2; continue; }
    if (c === '%') {
      while (i < n && src.charAt(i) !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    i++;
  }
  return out.join('');
}

function skipWs(s, i) { while (i < s.length && /\s/.test(s.charAt(i))) i++; return i; }

// s[i] 必须是 '{'；返回闭括号位置（处理 \{ 与嵌套）
function braceEnd(s, i) {
  var depth = 0;
  for (; i < s.length; i++) {
    var c = s.charAt(i);
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
// 读 `{...}`，返回 { text, start, end }（start/end 指内容区间）；失败返回 null
function readGroup(s, i) {
  i = skipWs(s, i);
  if (s.charAt(i) !== '{') return null;
  var e = braceEnd(s, i);
  if (e < 0) return null;
  return { text: s.slice(i + 1, e), start: i + 1, end: e };
}
// 读 `[...]`（内部 {} 中的 ] 不算），返回 { text, openIdx } 或 null
function readOpt(s, i) {
  i = skipWs(s, i);
  if (s.charAt(i) !== '[') return null;
  var depth = 0;
  for (var j = i; j < s.length; j++) {
    var c = s.charAt(j);
    if (c === '\\') { j++; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === ']' && depth <= 0) return { text: s.slice(i + 1, j), openIdx: i, closeIdx: j };
  }
  return null;
}

// 找 \begin{name}...\end{name} 的内容（处理同名嵌套）
// fromIndex 开始搜索 \begin；返回 { inner, innerStart, innerEnd, outerStart, outerEnd, opt }
function findEnv(s, fromIndex) {
  var re = /\\(begin|end)\s*\{([^}]+)\}/g;
  re.lastIndex = fromIndex || 0;
  var m, depth = 0, name = null, beginMatch = null;
  while ((m = re.exec(s))) {
    if (m[1] === 'begin' && depth === 0) { name = m[2]; beginMatch = m; depth = 1; continue; }
    if (m[1] === 'begin' && m[2] === name) depth++;
    else if (m[1] === 'end' && m[2] === name) {
      depth--;
      if (depth === 0) {
        var innerStart = beginMatch.index + beginMatch[0].length;
        return {
          name: name,
          inner: s.slice(innerStart, m.index),
          innerStart: innerStart, innerEnd: m.index,
          outerStart: beginMatch.index, outerEnd: m.index + m[0].length,
          opt: null
        };
      }
    }
  }
  return null;
}

// ---------------- 宏展开 ----------------
function scanMacros(src) {
  var macros = {};
  var re = /\\(?:re)?newcommand\*?\s*\{?\s*(\\[A-Za-z]+)\s*\}?\s*(?:\[(\d)\])?\s*(?:\[([^\]]*)\])?\s*\{/g;
  var m;
  while ((m = re.exec(src))) {
    var name = m[1].slice(1);
    var be = braceEnd(src, m.index + m[0].length - 1);
    if (be < 0) continue;
    var body = src.slice(m.index + m[0].length, be);
    macros[name] = { argc: m[2] ? +m[2] : 0, opt: m[3], body: body };
  }
  // \def\x{..}
  var re2 = /\\def\s*(\\[A-Za-z]+)\s*\{/g;
  while ((m = re2.exec(src))) {
    var name2 = m[1].slice(1);
    var be2 = braceEnd(src, m.index + m[0].length - 1);
    if (be2 < 0) continue;
    macros[name2] = { argc: 0, opt: null, body: src.slice(m.index + m[0].length, be2) };
  }
  return macros;
}

// 在 text 上展开宏（返回新串）。args 从 text 中宏名后依次抓取 {} 组。
function expandMacros(text, macros, depth) {
  if (depth > 12) return text;
  var changed = false, out = text;
  Object.keys(macros).forEach(function (name) {
    var mac = macros[name];
    var re = new RegExp('\\\\' + name + '(?![A-Za-z])');
    var m;
    var guard = 0;
    while ((m = re.exec(out)) && guard++ < 50) {
      var after = m.index + m[0].length;
      var replacement = mac.body;
      // 抓参数
      var pos = after, ok = true;
      var argsUsed = [];
      for (var a = 0; a < mac.argc; a++) {
        if (a === 0 && mac.opt !== undefined && mac.opt !== null && out.charAt(skipWs(out, pos)) === '[') {
          var og = readOpt(out, pos);
          if (!og) { ok = false; break; }
          argsUsed.push(og.text); pos = og.closeIdx + 1;
          continue;
        }
        var g = readGroup(out, pos);
        if (!g) { ok = false; break; }
        argsUsed.push(g.text); pos = g.end + 1;
      }
      if (!ok) break;
      // 替换 #1..
      replacement = replacement.replace(/#(\d)/g, function (_, d) { return argsUsed[+d - 1] !== undefined ? argsUsed[+d - 1] : ''; });
      out = out.slice(0, m.index) + replacement + out.slice(pos);
      changed = true;
    }
  });
  if (changed) out = expandMacros(out, macros, depth + 1);
  return out;
}

// ---------------- 数学 ----------------
function renderMath(tex, display, ctx, macrosForKatex) {
  var html;
  try {
    html = global.katex.renderToString(tex, {
      displayMode: !!display, throwOnError: false, strict: false,
      // trust 不再全开：\href/\url 走 safeUrl 白名单，其余信任场景（\htmlClass/
      // \htmlStyle/\includegraphics）一律拒绝
      trust: function (c) { return !!safeUrl(c && c.url); },
      macros: macrosForKatex || {}
    });
  } catch (e) {
    html = '<span class="math-error" title="' + esc(e.message || '') + '">' + esc(tex) + '</span>';
    ctx.warn('公式渲染失败: ' + String(e.message || '').slice(0, 80));
  }
  return html;
}

// 找数学环境结尾。i 指向内容起始。
// 返回值约定：'$' -> 尾 $ 下标；'$$' -> 第一个 $ 下标；'\\]' / '\\)' -> 反斜杠下标
function findMathEnd(s, i, term) {
  var j = i;
  while (j < s.length) {
    var c = s.charAt(j);
    if (c === '\\') {
      if ((term === '\\]' && s.charAt(j + 1) === ']') || (term === '\\)' && s.charAt(j + 1) === ')')) return j;
      j += 2; continue;
    }
    if (term === '$' && c === '$') return j;
    if (term === '$$' && c === '$' && s.charAt(j + 1) === '$') return j;
    j++;
  }
  return -1;
}

// ---------------- 主入口 ----------------
function renderLatex(srcRaw, opts) {
  opts = opts || {};
  TIKZ = global.PaperLite && global.PaperLite.tikz;
  var ctx = {
    warnings: [],
    macros: {},
    headings: [],
    counters: { sec: 0, subsec: 0, subsubsec: 0, fig: 0, tab: 0, eq: 0, footnote: 0, bib: 0 },
    labels: {},        // key -> 显示编号
    cites: {},         // key -> 序号
    bibItems: [],      // { key, html }
    footnotes: [],
    meta: { title: '', author: '', date: null, twocolumn: false, ctex: false },
    diagrams: [],      // { id, svg, nodes, tikzsetRanges, wrapperId }
    warn: function (m) { if (ctx.warnings.length < 60) ctx.warnings.push(m); }
  };

  var src = String(srcRaw || '').replace(/\r\n?/g, '\n');
  src = blankComments(src);
  var macros = scanMacros(src);
  ctx.macros = macros;
  var katexMacros = {};
  Object.keys(macros).forEach(function (n) { katexMacros['\\' + n] = macros[n].body; });

  // ---- 拆分 preamble / body ----
  var mDoc = src.match(/\\begin\s*\{document\}/);
  var preamble, body, bodyBase;
  if (mDoc) {
    preamble = src.slice(0, mDoc.index);
    bodyBase = mDoc.index + mDoc[0].length;
    body = src.slice(bodyBase);
    var endDoc = body.lastIndexOf('\\end{document}');
    if (endDoc >= 0) body = body.slice(0, endDoc);
  } else {
    preamble = ''; bodyBase = 0; body = src;
  }

  parsePreamble(preamble, ctx, src);

  var html = renderFlow(body, ctx, bodyBase, true);

  // ---- 回填 ----
  html = html.replace(/@@R:([^@]*)@@/g, function (_, key) {
    if (ctx.labels[key] !== undefined) return esc(ctx.labels[key]);
    ctx.warn('未定义的引用: ' + key);
    return '<span class="bad-ref">?</span>';
  });
  html = html.replace(/@@C:([^@]*)@@/g, function (_, key) {
    if (ctx.cites[key] !== undefined) return String(ctx.cites[key]);
    return '<span class="bad-ref" title="未在参考文献中找到">?</span>';
  });
  html = html.replace(/@@TOC@@/g, function () { return buildToc(ctx); });
  if (ctx.footnotes.length) html += '<section class="footnotes"><hr/><ol>' + ctx.footnotes.map(function (f) { return '<li id="fn' + f.n + '">' + f.html + '</li>'; }).join('') + '</ol></section>';

  var stats = { chars: src.replace(/\s/g, '').length, words: countWords(src), cjk: (src.match(/[\u4e00-\u9fff]/g) || []).length };
  return { html: html, meta: ctx.meta, warnings: ctx.warnings, diagrams: ctx.diagrams, stats: stats, headings: ctx.headings };
}

function countWords(s) {
  var latin = (s.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9][A-Za-z0-9'’\-]*/g) || []).length;
  var cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  return latin + cjk;
}

// ---------------- preamble ----------------
function parsePreamble(pre, ctx, fullSrc) {
  ctx.macros;
  // tikz 样式（含绝对区间，便于面板回写）
  ctx.tikzsetRanges = [];
  ctx.styles = {};
  if (TIKZ) {
    var re = /\\tikzset\s*\{/g, m;
    while ((m = re.exec(pre))) {
      var be = braceEnd(pre, m.index + m[0].length - 1);
      if (be < 0) continue;
      var inner = pre.slice(m.index + m[0].length, be);
      var bodyStart = m.index + m[0].length;
      var regs = [];
      TIKZ.parseTikzsetBody(inner, ctx.styles, regs);
      regs.forEach(function (r) {
        ctx.tikzsetRanges.push({ name: r.name, start: bodyStart + r.start, end: bodyStart + r.end });
      });
    }
    // \tikzstyle{name}=[...]
    var re2 = /\\tikzstyle\s*\{([^}]+)\}\s*=\s*\[/g;
    while ((m = re2.exec(pre))) {
      var oe = pre.indexOf(']', m.index + m[0].length - 1);
      if (oe < 0) continue;
      ctx.styles[m[1].trim()] = TIKZ.parseOpts(pre.slice(m.index + m[0].length, oe));
      ctx.tikzsetRanges.push({ name: m[1].trim(), start: m.index + m[0].length, end: oe });
    }
  }
  // 元信息
  var mt = pre.match(/\\title\s*(\[[^\]]*\])?\s*\{/);
  if (mt) { var e = braceEnd(pre, mt.index + mt[0].length - 1); if (e > 0) ctx.meta.title = pre.slice(mt.index + mt[0].length, e); }
  var ma = pre.match(/\\author\s*\{/);
  if (ma) { var e2 = braceEnd(pre, ma.index + ma[0].length - 1); if (e2 > 0) ctx.meta.author = pre.slice(ma.index + ma[0].length, e2).replace(/\\and/g, '，').replace(/\\thanks\{[^}]*\}/g, ''); }
  var md = pre.match(/\\date\s*\{/);
  ctx.meta.date = null;
  if (md) { var e3 = braceEnd(pre, md.index + md[0].length - 1); if (e3 > 0) ctx.meta.date = pre.slice(md.index + md[0].length, e3); }
  var dc = pre.match(/\\documentclass\s*(?:\[[^\]]*\])?\s*\{([a-zA-Z*]+)\}/);
  if (dc) {
    var cls = dc[1];
    ctx.meta.ctex = /^ctex/.test(cls);
    ctx.meta.cls = cls;
    if (/twocolumn/.test(pre.slice(dc.index, dc.index + dc[0].length)) || pre.slice(dc.index, dc.index + 200).match(/\[[^\]]*twocolumn/)) ctx.meta.twocolumn = true;
  }
}

// ---------------- 正文流式渲染 ----------------
// 返回 HTML；块级与段落自动分组。inlineMode=true 时不产生 <p> 段落（用于宏展开/标题/题注）
function renderFlow(str, ctx, base, isTop, inlineMode) {
  var tokens = [];  // {block:bool, html}
  var i = 0, n = str.length;
  var inlineBuf = '';
  function flushP() {
    if (inlineMode) {
      if (inlineBuf.replace(/<[^>]*>/g, '').trim() || inlineBuf.trim()) tokens.push({ block: false, html: inlineBuf });
      inlineBuf = '';
      return;
    }
    if (inlineBuf.replace(/<[^>]*>/g, '').trim()) tokens.push({ block: false, html: '<p>' + inlineBuf + '</p>' });
    else if (inlineBuf.trim()) tokens.push({ block: false, html: inlineBuf });
    inlineBuf = '';
  }

  while (i < n) {
    var c = str.charAt(i);

    // 空行 -> 段落断
    if (c === '\n') {
      var j = i;
      while (j < n && /\s/.test(str.charAt(j))) j++;
      if (str.charAt(j) === '\n' || /\n\s*\n/.test(str.slice(i, j + 1)) || (j > i + 1 && i === 0)) {
        // 连续空白含两个以上换行 → 分段
        if (/\n\s*\n/.test(str.slice(i, j + 2)) || (str.slice(i, j + 1).match(/\n/g) || []).length >= 2) {
          flushP(); i = j; continue;
        }
      }
      inlineBuf += ' '; i++; continue;
    }

    // 数学
    if (c === '$') {
      if (str.substr(i, 2) === '$$') {
        var e = findMathEnd(str, i + 2, '$$');
        if (e > 0) {
          flushP();
          tokens.push({ block: true, html: '<div class="equation">' + renderMath(expandMacros(str.slice(i + 2, e), ctx.macros, 0), true, ctx, katexMacrosOf(ctx)) + '</div>' });
          i = e + 2; continue;
        }
      } else if (str.charAt(i + 1) && str.charAt(i + 1) !== '$') {
        var e2 = findMathEnd(str, i + 1, '$');
        if (e2 > 0) {
          inlineBuf += renderMath(expandMacros(str.slice(i + 1, e2), ctx.macros, 0), false, ctx, katexMacrosOf(ctx));
          i = e2 + 1; continue;
        }
      }
    }
    if (c === '\\' && str.substr(i, 2) === '\\[') {
      var e3 = findMathEnd(str, i + 2, '\\]');
      if (e3 > 0) {
        flushP();
        tokens.push({ block: true, html: '<div class="equation">' + renderMath(expandMacros(str.slice(i + 2, e3), ctx.macros, 0), true, ctx, katexMacrosOf(ctx)) + '</div>' });
        i = e3 + 2; continue;
      }
    }
    if (c === '\\' && str.substr(i, 2) === '\\(') {
      var e4 = findMathEnd(str, i + 2, '\\)');
      if (e4 > 0) {
        inlineBuf += renderMath(expandMacros(str.slice(i + 2, e4), ctx.macros, 0), false, ctx, katexMacrosOf(ctx));
        i = e4 + 2; continue;
      }
    }

    // 环境
    if (c === '\\' && str.substr(i, 7) === '\\begin{') {
      var probe = envAt(str, i);
      if (probe) {
        flushP();
        tokens.push({ block: true, html: renderEnv(probe, ctx, base + probe.innerStart) });
        i = probe.outerEnd; continue;
      }
    }

    // 命令
    if (c === '\\') {
      var cmdM = str.slice(i).match(/^\\([A-Za-z]+)\*?/);
      if (cmdM) {
        var r = handleCommand(cmdM[1], str, i, ctx, base, tokens, flushP);
        if (r === null) { ctx.warn('不支持的命令 \\' + cmdM[1]); inlineBuf += esc(cmdM[0]); i += cmdM[0].length; continue; }
        if (typeof r === 'number') { i = r; continue; }
        i = r.next; if (r.html !== undefined) { if (r.block) { flushP(); tokens.push({ block: true, html: r.html }); } else inlineBuf += r.html; }
        continue;
      }
      // \{ \} \\ \% 等
      if (str.substr(i, 2) === '\\\\') {
        if (inlineMode) inlineBuf += '<br/>';
        else { flushP(); tokens.push({ block: true, html: '<br/>' }); }
        i += 2; continue;
      }
      var sp = str.substr(i, 2);
      if (sp === '\\%' || sp === '\\&' || sp === '\\#' || sp === '\\_' || sp === '\\$') { inlineBuf += esc(sp[1]); i += 2; continue; }
      if (sp === '\\{' || sp === '\\}') { inlineBuf += esc(sp[1]); i += 2; continue; }
      i++; continue;
    }

    // 文本（展开宏 → 排版细节）
    var next = i + 1;
    while (next < n && '$\\%\n'.indexOf(str.charAt(next)) < 0) next++;
    inlineBuf += typesetText(expandMacros(str.slice(i, next), ctx.macros, 0));
    i = next;
  }
  flushP();

  // 顶层：包装成 article 容器由调用方处理
  return tokens.map(function (t) { return t.html; }).join('\n');
}

function katexMacrosOf(ctx) {
  if (ctx._katexMacros) return ctx._katexMacros;
  var m = {};
  Object.keys(ctx.macros).forEach(function (n) { m['\\' + n] = ctx.macros[n].body; });
  ctx._katexMacros = m;
  return m;
}

// 文本排版细节（引号/破折号/波浪号/裸花括号）
function typesetText(t) {
  var s = esc(t);
  s = s.replace(/``([^']*|[^']*)''/g, '\u201c$1\u201d');
  s = s.replace(/`([^`']*)'/g, '\u2018$1\u2019');
  s = s.replace(/---/g, '\u2014').replace(/--/g, '\u2013');
  s = s.replace(/~/g, '\u00a0');
  s = s.replace(/[{}]/g, '');  // 分组花括号不显示
  return s;
}

// i 处是否是 \begin{env}（返回 findEnv 结果或 null）
function envAt(str, i) {
  if (str.slice(i, i + 7) !== '\\begin{') return null;
  var env = findEnv(str, i);
  return env;
}

// ---------------- 命令处理 ----------------
// 返回: {next, html?, block?} | number(仅前移) | null(不支持)
function handleCommand(name, str, i, ctx, base, tokens, flushP) {
  var afterName = i + name.length + 1 + (str.charAt(i + name.length + 1) === '*' ? 1 : 0);
  var starred = str.charAt(i + name.length + 1) === '*';
  var g1, g2, o1;

  function G(pos) { return readGroup(str, pos); }

  // 宏命令：抓参数展开后递归渲染（保持外层偏移不变）
  if (ctx.macros[name]) {
    var mrec = ctx.macros[name];
    var pos = afterName, argsUsed = [], okArgs = true;
    for (var a = 0; a < mrec.argc; a++) {
      if (a === 0 && mrec.opt !== undefined && mrec.opt !== null && str.charAt(skipWs(str, pos)) === '[') {
        var og = readOpt(str, pos);
        if (!og) { okArgs = false; break; }
        argsUsed.push(og.text); pos = og.closeIdx + 1; continue;
      }
      var g0 = readGroup(str, pos);
      if (!g0) { okArgs = false; break; }
      argsUsed.push(g0.text); pos = g0.end + 1;
    }
    if (okArgs) {
      var body = mrec.body.replace(/#(\d)/g, function (_, d) { return argsUsed[+d - 1] !== undefined ? argsUsed[+d - 1] : ''; });
      return { next: pos, html: renderFlow(body, ctx, base + afterName, false, true) };
    }
  }

  switch (name) {
    // ---- 结构 ----
    case 'section': case 'subsection': case 'subsubsection': case 'paragraph': {
      g1 = G(afterName);
      if (!g1) return null;
      var lvl = name === 'section' ? 1 : name === 'subsection' ? 2 : name === 'subsubsection' ? 3 : 4;
      var num = '';
      if (!starred && lvl <= 3) {
        if (lvl === 1) { ctx.counters.sec++; ctx.counters.subsec = 0; ctx.counters.subsubsec = 0; num = ctx.counters.sec; }
        else if (lvl === 2) { ctx.counters.subsec++; ctx.counters.subsubsec = 0; num = ctx.counters.sec + '.' + ctx.counters.subsec; }
        else { ctx.counters.subsubsec++; num = ctx.counters.sec + '.' + ctx.counters.subsec + '.' + ctx.counters.subsubsec; }
      }
      var inner = renderFlow(g1.text, ctx, base + g1.start, false, true);
      var hid = 'h-' + ctx.headings.length;
      ctx.headings.push({ level: lvl, num: num, text: stripTags(inner), id: hid });
      // 标题内的 \label
      var lm = g1.text.match(/\\label\{([^}]+)\}/);
      if (lm) ctx.labels[lm[1]] = num || '';
      var tag = lvl <= 3 ? 'h' + (lvl + 1) : 'p';
      var cls = lvl === 1 ? 'sec1' : lvl === 2 ? 'sec2' : lvl === 3 ? 'sec3' : 'parag';
      return { next: g1.end + 1, block: true, html: '<' + tag + ' id="' + hid + '" class="' + cls + '">' + (num ? '<span class="secnum">' + num + '</span> ' : '') + inner + '</' + tag + '>' };
    }
    case 'maketitle': {
      var t = '<header class="titleblock">' +
        '<h1 class="doc-title">' + (ctx.meta.title ? renderFlow(ctx.meta.title, ctx, 0, false, true) : '无标题文档') + '</h1>' +
        (ctx.meta.author ? '<div class="doc-author">' + renderFlow(ctx.meta.author, ctx, 0, false, true) + '</div>' : '') +
        '<div class="doc-date">' + (ctx.meta.date ? renderFlow(ctx.meta.date, ctx, 0, false, true) : '') + '</div></header>';
      return { next: afterName, block: true, html: t };
    }
    case 'tableofcontents': return { next: afterName, block: true, html: '@@TOC@@' };
    case 'today': return { next: afterName, html: zhToday() };
    case 'newpage': case 'clearpage': return { next: afterName, block: true, html: '<div class="pagebreak"></div>' };
    case 'par': flushP(); return afterName;

    // ---- 文本格式 ----
    case 'textbf': g1 = G(afterName); if (!g1) return null; return { next: g1.end + 1, html: '<strong>' + renderFlow(g1.text, ctx, base + g1.start, false, true) + '</strong>' };
    case 'textit': case 'emph': g1 = G(afterName); if (!g1) return null; return { next: g1.end + 1, html: '<em>' + renderFlow(g1.text, ctx, base + g1.start, false, true) + '</em>' };
    case 'underline': g1 = G(afterName); if (!g1) return null; return { next: g1.end + 1, html: '<u>' + renderFlow(g1.text, ctx, base + g1.start, false, true) + '</u>' };
    case 'texttt': g1 = G(afterName); if (!g1) return null; return { next: g1.end + 1, html: '<code>' + renderFlow(g1.text, ctx, base + g1.start, false, true) + '</code>' };
    case 'textsc': g1 = G(afterName); if (!g1) return null; return { next: g1.end + 1, html: '<span class="smallcaps">' + renderFlow(g1.text, ctx, base + g1.start, false, true) + '</span>' };
    case 'sout': case 'striked': g1 = G(afterName); if (!g1) return null; return { next: g1.end + 1, html: '<s>' + renderFlow(g1.text, ctx, base + g1.start, false, true) + '</s>' };
    case 'textsuperscript': g1 = G(afterName); if (!g1) return null; return { next: g1.end + 1, html: '<sup>' + renderFlow(g1.text, ctx, base + g1.start, false, true) + '</sup>' };
    case 'textsubscript': g1 = G(afterName); if (!g1) return null; return { next: g1.end + 1, html: '<sub>' + renderFlow(g1.text, ctx, base + g1.start, false, true) + '</sub>' };
    case 'footnote': {
      g1 = G(afterName); if (!g1) return null;
      ctx.counters.footnote++;
      var fn = ctx.counters.footnote;
      ctx.footnotes.push({ n: fn, html: renderFlow(g1.text, ctx, base + g1.start, false, true) });
      return { next: g1.end + 1, html: '<sup class="fnref" id="fnr' + fn + '">' + fn + '</sup>' };
    }
    case 'underlinebar': return null;

    // ---- 引用 ----
    case 'ref': g1 = G(afterName); if (!g1) return null; return { next: g1.end + 1, html: '@@R:' + g1.text.trim() + '@@' };
    case 'autoref': case 'cref': case 'Cref': {
      g1 = G(afterName); if (!g1) return null;
      var pre2 = name === 'Cref' ? '图 ' : '';
      return { next: g1.end + 1, html: pre2 + '@@R:' + g1.text.trim() + '@@' };
    }
    case 'eqref': g1 = G(afterName); if (!g1) return null; return { next: g1.end + 1, html: '式&nbsp;(@@R:' + g1.text.trim() + '@@)' };
    case 'cite': case 'citep': case 'citet': {
      o1 = readOpt(str, afterName);
      var pos = o1 ? o1.closeIdx + 1 : afterName;
      g1 = G(pos); if (!g1) return null;
      var keys = g1.text.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var parts = keys.map(function (k) { return '@@C:' + k + '@@'; });
      return { next: g1.end + 1, html: '<span class="cite">[' + parts.join(',') + ']</span>' };
    }
    case 'label': g1 = G(afterName); if (g1) { /* 编号由所属环境处理，单独出现忽略 */ return g1.end + 1; } return afterName;
    case 'caption': case 'caption*': {
      // 编号与显示由 figure/table 环境负责，这里吞掉（含可选短标题）
      var capOpt = readOpt(str, afterName);
      var capPos = capOpt ? capOpt.closeIdx + 1 : afterName;
      g1 = G(capPos);
      if (g1) return g1.end + 1;
      return afterName;
    }
    case 'url': g1 = G(afterName); if (!g1) return null; var uu = safeUrl(g1.text); return { next: g1.end + 1, html: uu ? '<a href="' + esc(uu) + '" target="_blank" rel="noopener noreferrer">' + esc(g1.text) + '</a>' : esc(g1.text) };
    case 'href': {
      g1 = G(afterName); g2 = G(g1 ? g1.end + 1 : afterName);
      if (!g1 || !g2) return null;
      var hu = safeUrl(g1.text);
      var inner = renderFlow(g2.text, ctx, base + g2.start, false, true);
      return { next: g2.end + 1, html: hu ? '<a href="' + esc(hu) + '" target="_blank" rel="noopener noreferrer">' + inner + '</a>' : inner };
    }

    // ---- 版面（忽略类） ----
    case 'centering': case 'raggedright': case 'raggedleft': case 'noindent': case 'indent':
    case 'small': case 'large': case 'Large': case 'LARGE': case 'huge': case 'Huge': case 'footnotesize': case 'scriptsize': case 'normalsize': case 'linespread': case 'setlength': case 'vspace': case 'hspace': case 'hspace*': case 'vspace*': case 'graphicspath': case 'captionsetup': case 'pagestyle': case 'thispagestyle': case 'usetikzlibrary': case 'usepackage': case 'RequirePackage': case 'definecolor': case 'input': case 'include': case 'renewcommand': case 'newcommand': case 'providecommand': case 'def': case 'bibliographystyle': case 'bibliography': case 'setcounter': case 'addtocounter': case 'captionof': case 'nolinebreak': case 'linebreak': case 'pagebreak': case 'nopagebreak': case 'kern': case 'hfill': case 'vfill': case 'strut': case 'obeyspaces': case 'ttfamily': case 'bfseries': case 'itshape': case 'normalfont': case 'textnormal':
      // usepackage/setlength/definecolor 可能带参数，吞掉参数避免显示
      if (name === 'usepackage' || name === 'RequirePackage') { var po = readOpt(str, afterName); var pg = G(po ? po.closeIdx + 1 : afterName); return pg ? pg.end + 1 : afterName; }
      if (name === 'setlength' || name === 'addtolength' || name === 'setcounter' || name === 'addtocounter' || name === 'definecolor' || name === 'graphicspath' || name === 'captionsetup' || name === 'renewcommand' || name === 'providecommand' || name === 'newcommand' || name === 'def' || name === 'bibliographystyle' || name === 'bibliography' || name === 'captionof') {
        var na = (name === 'setcounter' || name === 'addtocounter' || name === 'bibliographystyle' || name === 'bibliography') ? 1 : 2;
        var p2 = afterName;
        for (var k2 = 0; k2 < na + 1; k2++) { var gg = G(p2); if (!gg) break; p2 = gg.end + 1; }
        return p2;
      }
      return afterName;

    case 'item': return { next: afterName }; // 由列表环境处理，不应到这里
    case 'includegraphics': {
      o1 = readOpt(str, afterName);
      g1 = G(o1 ? o1.closeIdx + 1 : afterName);
      if (!g1) return null;
      var wstyle = '';
      if (o1) {
        var wm = o1.text.match(/width\s*=\s*([\d.]*\\(?:textwidth|linewidth|columnwidth)|[\d.]+(?:cm|mm|pt|in))/);
        if (wm) {
          var frac = wm[1].match(/^([\d.]*)\\(textwidth|linewidth|columnwidth)/);
          if (frac) wstyle = ' style="width:' + (frac[1] === '' ? 100 : parseFloat(frac[1]) * 100) + '%"';
          else { var px = { cm: 37.8, mm: 3.78, pt: 1.33, in: 96 }; var um = wm[1].match(/^([\d.]+)(cm|mm|pt|in)/); if (um) wstyle = ' style="width:' + (+um[1] * px[um[2]]) + 'px"'; }
        }
      }
      var src = localAssetPath(g1.text.trim());
      if (!src) return { next: g1.end + 1, html: '<span class="math-error">' + esc(g1.text) + '</span>' };
      return { next: g1.end + 1, html: '<img class="includegraphics" src="' + esc(src) + '" alt="' + esc(g1.text) + '"' + wstyle + '/>' };
    }
    case 'rule': { g1 = G(afterName); g2 = G(g1 ? g1.end + 1 : 0); if (!g1 || !g2) return null; return { next: g2.end + 1, html: '<span class="rule-bar"></span>' }; }
    case 'quad': case 'qquad': return { next: afterName, html: '&emsp;' };
    case 'LaTeX': return { next: afterName, html: 'LaTeX' };
    case 'TeX': return { next: afterName, html: 'TeX' };
    case 'text': { g1 = G(afterName); if (g1) return { next: g1.end + 1, html: esc(g1.text) }; return null; }
    case 'hspace': return null;
  }
  return null;
}

function stripTags(s) { return String(s).replace(/<[^>]*>/g, ''); }
function zhToday() {
  var d = new Date();
  return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
}

// ---------------- 环境渲染 ----------------
function renderEnv(env, ctx, absInnerStart) {
  var inner = env.inner, base = absInnerStart;
  switch (env.name) {
    case 'document': return renderFlow(inner, ctx, base, true);

    case 'abstract':
      return '<div class="abstract"><h4>' + (ctx.meta.ctex ? '摘要' : 'Abstract') + '</h4>' + renderFlow(inner, ctx, base, false) + '</div>';

    case 'center':
      return '<div class="center">' + renderFlow(inner, ctx, base, false) + '</div>';
    case 'quote': case 'quotation':
      return '<blockquote>' + renderFlow(inner, ctx, base, false) + '</blockquote>';
    case 'flushleft': return '<div class="flushleft">' + renderFlow(inner, ctx, base, false) + '</div>';
    case 'flushright': return '<div class="flushright">' + renderFlow(inner, ctx, base, false) + '</div>';

    case 'itemize': case 'enumerate': {
      var items = splitItems(inner);
      var tag = env.name === 'itemize' ? 'ul' : 'ol';
      var lis = items.map(function (it) {
        var body = renderFlow(it.text, ctx, base + it.start, false);
        if (it.label !== undefined) return '<li><span class="dlabel">' + esc(it.label) + '</span>' + body + '</li>';
        return '<li>' + body + '</li>';
      }).join('');
      return '<' + tag + ' class="latex-list">' + lis + '</' + tag + '>';
    }
    case 'description': {
      var items2 = splitItems(inner);
      return '<dl class="latex-desc">' + items2.map(function (it) {
        return '<dt>' + esc(it.label || '') + '</dt><dd>' + renderFlow(it.text, ctx, base + it.start, false) + '</dd>';
      }).join('') + '</dl>';
    }

    case 'equation': case 'equation*': case 'gather': case 'gather*': case 'align': case 'align*': case 'alignat': case 'alignat*': case 'multline': case 'multline*': case 'flalign': case 'flalign*': {
      var numbered = env.name.indexOf('*') < 0;
      var tex = inner;
      var label = null;
      tex = tex.replace(/\\label\{([^}]+)\}/g, function (_, k) { label = k; return ''; });
      tex = expandMacros(tex, ctx.macros, 0);
      var body2;
      var noNum = /\\notag|\\nonumber/.test(tex);
      tex = tex.replace(/\\notag|\\nonumber/g, '');
      if (/^(align|flalign|alignat)$/.test(env.name.replace('*',''))) {
        body2 = renderMath('\\begin{aligned}' + tex.replace(/&/g, '&').replace(/\n/g, ' \\\\ ') + '\\end{aligned}', true, ctx, katexMacrosOf(ctx));
      } else if (env.name.indexOf('gather') === 0) {
        body2 = renderMath('\\begin{gathered}' + tex + '\\end{gathered}', true, ctx, katexMacrosOf(ctx));
      } else {
        body2 = renderMath(tex, true, ctx, katexMacrosOf(ctx));
      }
      var num2 = '';
      if (numbered && !noNum) {
        ctx.counters.eq++;
        num2 = '(' + ctx.counters.eq + ')';
        if (label) ctx.labels[label] = String(ctx.counters.eq);
      } else if (label) ctx.labels[label] = '';
      return '<div class="equation" data-eq="' + ctx.counters.eq + '"><span class="eq-body">' + body2 + '</span>' + (num2 ? '<span class="eq-no">' + num2 + '</span>' : '') + '</div>';
    }

    case 'figure': case 'figure*': case 'table': case 'table*': {
      var isFig = env.name.indexOf('figure') === 0;
      var cap = null, label = null;
      // 提取 \caption{...}（括号配平）
      var capRe = /\\caption\s*(?:\[[^\]]*\])?\s*\{/g, m;
      while ((m = capRe.exec(inner))) {
        var be = braceEnd(inner, m.index + m[0].length - 1);
        if (be < 0) continue;
        cap = inner.slice(m.index + m[0].length, be);
        break;
      }
      var labM = inner.match(/\\label\{([^}]+)\}/);
      if (labM) label = labM[1];
      // caption/label 命令渲染为空（由本环境统一编号），无需从内容中删除
      var content = inner;

      var n2 = isFig ? ++ctx.counters.fig : ++ctx.counters.tab;
      if (label) ctx.labels[label] = String(n2);

      var capHtml = cap !== null ? renderFlow(cap, ctx, base, false, true) : '';
      var contentHtml = renderFlow(content, ctx, base, false);
      var capName = isFig ? '图' : '表';
      return '<figure class="float ' + (isFig ? 'fig' : 'tab') + '">' + contentHtml +
        (cap !== null ? '<figcaption>' + capName + '&nbsp;' + n2 + '：' + capHtml + '</figcaption>' : '') + '</figure>';
    }

    case 'tikzpicture': return renderTikzEnv(env, ctx, absInnerStart);
    case 'mermaid': {
      var code = inner.trim();
      return '<div class="diagram mermaid-block" data-code="' + esc(encodeURIComponent(code)) + '"></div>';
    }

    case 'verbatim': case 'verbatim*': case 'lstlisting': {
      var lang = '';
      var vm = inner.match(/^\s*\[language=([^\]]+)\]/);
      if (vm) inner = inner.replace(/^\s*\[language=[^\]]+\]/, '');
      return '<pre class="verbatim">' + esc(inner.replace(/^\n/, '')) + '</pre>';
    }
    case 'minted': {
      var lm2 = inner.match(/^(\w+)\s*\{([\s\S]*)\}$/);
      return '<pre class="verbatim">' + esc(lm2 ? lm2[2] : inner) + '</pre>';
    }

    case 'thebibliography': {
      // 先收集全部 \bibitem 位置，再两两切片
      var bibRe = /\\bibitem\s*(?:\[[^\]]*\])?\s*\{/g, m2;
      var bibMatches = [];
      while ((m2 = bibRe.exec(inner))) {
        var kEnd = braceEnd(inner, m2.index + m2[0].length - 1);
        if (kEnd < 0) continue;
        bibMatches.push({ key: inner.slice(m2.index + m2[0].length, kEnd), bodyStart: kEnd + 1, cmdStart: m2.index });
      }
      var out2 = '<section class="bibliography"><h2 class="sec1">参考文献</h2><ol class="bib-list">';
      bibMatches.forEach(function (bm, ix) {
        var bodyEnd = ix + 1 < bibMatches.length ? bibMatches[ix + 1].cmdStart : inner.length;
        ctx.counters.bib++;
        ctx.cites[bm.key] = ctx.counters.bib;
        out2 += '<li id="bib-' + esc(bm.key) + '">' + renderFlow(inner.slice(bm.bodyStart, bodyEnd), ctx, base + bm.bodyStart, false) + '</li>';
      });
      out2 += '</ol></section>';
      return out2;
    }

    case 'cases': case 'matrix': case 'pmatrix': case 'bmatrix': case 'vmatrix': case 'Bmatrix': case 'array': case 'tabular': case 'tabularx': {
      if (env.name === 'tabular' || env.name === 'tabularx') return renderTabular(inner, ctx, base);
      // 数学环境出现在文本流中（少见），直接交给 KaTeX
      return '<div class="equation">' + renderMath('\\begin{' + env.name + '}' + inner + '\\end{' + env.name + '}', true, ctx, katexMacrosOf(ctx)) + '</div>';
    }

    case 'split': case 'aligned': case 'gathered':
      return '<div class="equation">' + renderMath('\\begin{' + env.name + '}' + inner + '\\end{' + env.name + '}', true, ctx, katexMacrosOf(ctx)) + '</div>';

    default: {
      ctx.warn('环境 ' + env.name + ' 按普通内容处理');
      return '<div class="env-unknown" data-env="' + esc(env.name) + '">' + renderFlow(inner, ctx, base, false) + '</div>';
    }
  }
}

// itemize/enumerate 的 \item 拆分（含 description 的 [label]）
function splitItems(inner) {
  var items = [];
  var re = /\\item(?![A-Za-z])/g, m;
  var first = null;
  var matches = [];
  while ((m = re.exec(inner))) matches.push({ index: m.index, end: m.index + m[0].length });
  if (!matches.length) return [{ text: inner, start: 0, label: undefined }];
  for (var k = 0; k < matches.length; k++) {
    var st = matches[k].end;
    var en = k + 1 < matches.length ? matches[k + 1].index : inner.length;
    var seg = inner.slice(st, en);
    var label;
    var lm = seg.match(/^\s*\[([^\]]*)\]/);
    if (lm) { label = lm[1]; seg = seg.slice(lm[0].length); st += lm[0].length; }
    items.push({ text: seg, start: st, label: label });
  }
  return items;
}

// ---------------- tabular ----------------
function renderTabular(inner, ctx, base) {
  // 第一组 {} 是列格式
  var g = readGroup(inner, 0);
  var colspec = g ? g.text : 'c';
  var bodyStr = g ? inner.slice(g.end + 1) : inner;
  var bodyStart = g ? g.end + 1 : 0;
  var cols = parseColspec(colspec);

  // 按顶层 \\ 分行（\tabularnewline 也算），尊重嵌套 {}
  var rows = [], buf = '', bufStart = 0, i = 0;
  var rulesBefore = [];
  var pendingRule = null;
  function depth0Split(s) {
    var depth = 0, out = [], cur = '', curStart = 0, pos = [];
    for (var j = 0; j < s.length; j++) {
      var c = s.charAt(j);
      if (c === '\\') {
        if (s.substr(j, 2) === '\\\\') { out.push({ text: cur, start: curStart }); cur = ''; curStart = j + 2; j++; continue; }
        cur += c + (s.charAt(j + 1) || ''); j++; continue;
      }
      if (c === '{') depth++;
      if (c === '}') depth--;
      cur += c;
    }
    out.push({ text: cur, start: curStart });
    return out;
  }
  var rawRows = depth0Split(bodyStr);
  // 处理行内规则线
  var trs = [];
  var lastTrIdx = -1;
  rawRows.forEach(function (rr) {
    var t = rr.text;
    // 提取行首的 \hline \toprule \midrule \bottomrule \cline
    var ruleClass = '';
    var consumed = 0;
    var re = /^\s*\\(hline|toprule|midrule|bottomrule|cline(?:\{[^}]*\})?)/;
    var m;
    var pre = '';
    while ((m = t.match(re))) {
      var rn = m[1];
      if (rn.indexOf('cline') === 0) ruleClass += ' cl';
      else ruleClass += ' r-' + rn;
      t = t.slice(m[0].length);
    }
    if (!t.trim() && rawRows.indexOf(rr) === rawRows.length - 1) return; // 末尾空行
    if (!t.trim()) { // 独立规则行：应用到下一行
      pendingRule = (pendingRule || '') + ruleClass;
      return;
    }
    var cells = splitTopLevel(t, '&').map(function (c2, ci) {
      var raw = c2.text.trim();
      var span = 1;
      var mc = raw.match(/\\multicolumn\{(\d+)\}\s*\{[^}]*\}\s*\{/);
      if (mc) {
        span = +mc[1];
        var mcBe = braceEnd(raw, raw.indexOf('{', mc.index + mc[0].length - 1));
        raw = mcBe > 0 ? raw.slice(mc.index + mc[0].length, mcBe) + raw.slice(mcBe + 1) : raw;
      }
      var cell = renderFlow(raw, ctx, base + bodyStart + rr.start + c2.start, false);
      var cls = [];
      if (cols.rules[ci]) cls.push('vline');
      if (cols.align[ci] === 'l') cls.push('ta-l');
      if (cols.align[ci] === 'r') cls.push('ta-r');
      var w = cols.widths[ci] ? ' style="width:' + cols.widths[ci] + '"' : '';
      return '<td' + (span > 1 ? ' colspan="' + span + '"' : '') + (cls.length ? ' class="' + cls.join(' ') + '"' : '') + w + '>' + cell + '</td>';
    }).join('');
    var trCls = (pendingRule || '') + ruleClass;
    pendingRule = null;
    trs.push('<tr class="' + trCls.trim() + '">' + cells + '</tr>');
    lastTrIdx = trs.length - 1;
  });
  // 末尾独立规则线（如 ... \\ \bottomrule）附加到最后一行
  if (pendingRule && trs.length) {
    trs[trs.length - 1] = trs[trs.length - 1].replace('<tr class="', '<tr class="' + pendingRule.trim() + ' ');
  }

  return '<table class="tabular"><tbody>' + trs.join('') + '</tbody></table>';
}

function splitTopLevel(s, sep) {
  var out = [], depth = 0, cur = '', start = 0;
  for (var j = 0; j < s.length; j++) {
    var c = s.charAt(j);
    if (c === '\\') { cur += c + (s.charAt(j + 1) || ''); j++; continue; }
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (c === sep && depth === 0) { out.push({ text: cur, start: start }); cur = ''; start = j + 1; continue; }
    cur += c;
  }
  out.push({ text: cur, start: start });
  return out;
}

function parseColspec(spec) {
  var align = [], rules = [], widths = [];
  var i = 0;
  var j = 0;
  for (i = 0; i < spec.length; i++) {
    var c = spec.charAt(i);
    if (c === '|' || c === ':') { rules[j] = true; continue; }
    if (c === 'l' || c === 'c' || c === 'r') { align[j] = c; j++; continue; }
    if (c === 'p' || c === 'm' || c === 'b') {
      var e = spec.indexOf('{', i);
      if (e > 0) { var be = spec.indexOf('}', e); widths[j] = spec.slice(e + 1, be > 0 ? be : spec.length); }
      align[j] = 'l'; j++; continue;
    }
    if (c === '@') { // @{...} 忽略
      var ae = spec.indexOf('}', i);
      if (ae > 0) i = ae;
      continue;
    }
    if (c === '*') { // *{n}{cols} 简化：忽略
      var s1 = spec.indexOf('{', i), e1 = spec.indexOf('}', s1);
      var cnt = +spec.slice(s1 + 1, e1) || 1;
      for (var q = 0; q < cnt; q++) { align[j] = 'c'; j++; }
      i = spec.indexOf('}', e1 + 1);
      continue;
    }
  }
  return { align: align, rules: rules, widths: widths };
}

// ---------------- TikZ 环境接线 ----------------
function renderTikzEnv(env, ctx, absInnerStart) {
  if (!TIKZ) return '<div class="render-error">TikZ 引擎未加载</div>';
  // tikzpicture 的 [opts] 紧跟 \begin{tikzpicture} 之后 —— 我们的 findEnv 已把 opts 含进 inner
  var inner = env.inner;
  var optStr = '';
  var m = inner.match(/^\s*\[([^\]]*)\]/);
  if (m) optStr = m[1];
  var picBody = m ? inner.slice(m[0].length) : inner;
  var picBase = absInnerStart + (m ? m[0].length : 0);
  try {
    var res = TIKZ.render(picBody, optStr, picBase, {
      styles: ctx.styles, macros: ctx.macros, tikzsetRanges: ctx.tikzsetRanges, defaultFontPx: 13
    });
    var did = ctx.diagrams.length;
    var w = '<div class="diagram tikz-block" data-did="' + did + '">';
    if (res.svg) w += res.svg;
    else w += '<div class="render-error">流程图渲染失败：' + esc((res.warnings || []).join('；')) + '</div>';
    w += '</div>';
    ctx.diagrams.push({ id: did, svg: res.svg, nodes: res.nodes, tikzsetRanges: ctx.tikzsetRanges, warnings: res.warnings || [] });
    return w;
  } catch (e) {
    ctx.warn('TikZ 渲染异常: ' + (e.message || e));
    return '<div class="render-error">TikZ 渲染异常: ' + esc(String(e.message || e)) + '</div>';
  }
}

// ---------------- TOC ----------------
function buildToc(ctx) {
  if (!ctx.headings.length) return '';
  var out = '<nav class="toc"><h4>目录</h4><ul>';
  ctx.headings.forEach(function (h) {
    out += '<li class="toc-l' + h.level + '"><a href="#' + h.id + '">' + (h.num ? h.num + '&nbsp;&nbsp;' : '') + esc(h.text) + '</a></li>';
  });
  return out + '</ul></nav>';
}

global.PaperLite = global.PaperLite || {};
global.PaperLite.latex = { render: renderLatex };

})(typeof window !== 'undefined' ? window : globalThis);

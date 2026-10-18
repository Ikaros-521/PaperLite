import katex from 'katex';
import * as TIKZ from './tikz.js';
import { t, getLang } from '../i18n.js';
import { readDocumentclass, resolveLayout, FALLBACK } from './classLayout.js';

/* PaperLite · LaTeX → HTML 渲染器（论文常用子集）
 *
 * 关键设计：
 *  - 注释用「等长空格替换」抹除，保证渲染时统计的偏移量与原文档一一对应，
 *    从而支持样式面板把修改精确写回源码（tikz.js 里的节点/样式区间同理）。
 *  - 宏 (\newcommand) 预扫描后在文本/数学片段中按需展开。
 *  - 交叉引用 / 引文 / 脚注 / 目录 先用占位符，渲染结束后统一回填。
 * 返回 { html, meta, warnings, diagrams, stats, headings }
 *   warnings: [{ msg, line, kind }]，line 为 0 起源码行号（定位不到时为 null）
 */



function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 链接 scheme 白名单：\url/\href 与 KaTeX trust 共用。无 scheme（相对路径/锚点）
// 放行；http/https/mailto/tel 放行；javascript:/data:/vbscript: 等一律清空——
// 文档内容不可信，防止预览里的链接被点击时执行脚本。
function safeUrl(u) {
  var s = String(u == null ? '' : u).trim();
  var m = s.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):/);
  if (!m) return s;
  var k = m[1].toLowerCase();
  return (k === 'http' || k === 'https' || k === 'mailto' || k === 'tel') ? s : '';
}

// 给块级输出的根标签注入 data-off（源码绝对偏移），预览点击据此回跳源码行。
// @@占位符@@ 前缀（@@COLS@@ 等）跳过，注到第一个真实标签；没有标签则原样返回
function withOff(html, off) {
  if (off == null) return html;
  var m = String(html).match(/^((?:@@[A-Z]+@@)*)<([a-zA-Z][a-zA-Z0-9]*)/);
  if (!m) return html;
  return m[1] + '<' + m[2] + ' data-off="' + off + '"' + String(html).slice(m[0].length);
}

// \verb、\verb*、\lstinline（可带 [选项]）：i 指向反斜杠，命中返回 { next, content, star }，否则 null。
// 定界符不能是字母或 *；LaTeX 要求同一字符收尾，但 \verb{…} / \lstinline{…} 是常见写法，
// 故括号类定界符允许配对的另一个收尾。收尾不在同一行时按普通命令处理，
// 免得漏写定界符把后半篇正文全吞掉。
function verbAt(s, i) {
  var m = s.slice(i, i + 10).match(/^\\(verb|lstinline)(\*?)/);
  if (!m) return null;
  var p = i + m[0].length;
  if (m[1] === 'lstinline' && s.charAt(p) === '[') {
    var ce = s.indexOf(']', p);
    if (ce > 0) p = ce + 1;
  }
  var d = s.charAt(p);
  if (!d || /[A-Za-z*\\]/.test(d)) return null;
  var close = d === '{' ? '}' : d === '[' ? ']' : d === '(' ? ')' : d;
  var eol = s.indexOf('\n', p + 1);
  var limit = eol < 0 ? s.length : eol;
  var k = s.indexOf(close, p + 1);
  if (k < 0 || k >= limit) return null;
  return { next: k + 1, content: s.slice(p + 1, k), star: m[2] === '*' };
}

function renderVerb(vb) {
  // \verb* 与 \verb 的唯一差别是空白可见
  var text = vb.star ? vb.content.replace(/ /g, '\u2423') : vb.content;
  return '<code class="verb">' + esc(text) + '</code>';
}

// ---------------- 偏移工具（等长原则） ----------------
// 把行内注释(%..行尾)替换为等长空格，保留换行。
// mermaid 环境内除外：%% 是 mermaid 自己的注释语法（也是布局指令载体），
// 逐字环境（verbatim/lstlisting/minted）与 \verb 定界符内同样不适用注释规则；
// 这些区间原样保留，等长原则不受影响。
function blankComments(src) {
  var out = src.split(''), n = src.length, i = 0;
  while (i < n) {
    var c = src.charAt(i);
    if (c === '\\') {
      if (src.substr(i, 15) === '\\begin{mermaid}') {
        var eM = src.indexOf('\\end{mermaid}', i);
        i = eM < 0 ? i + 15 : eM + 13;
        continue;
      }
      // 逐字环境内 % 不是注释（代码示例里的注释会被抹掉），整段跳过
      var vEnv = src.slice(i).match(/^\\begin\s*\{(verbatim\*?|lstlisting|minted)\}/);
      if (vEnv) {
        var eV = src.indexOf('\\end{' + vEnv[1] + '}', i);
        i = eV < 0 ? i + vEnv[0].length : eV + 7 + vEnv[1].length;
        continue;
      }
      // \verb 定界符内的 % 不是注释，整段原样跳过（等长原则不受影响）
      var vb = verbAt(src, i);
      if (vb) { i = vb.next; continue; }
      i += 2; continue;
    }
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
// at：公式起点在源码中的绝对偏移，KaTeX 抛错时用它定位行
function renderMath(tex, display, ctx, macrosForKatex, at) {
  var html;
  try {
    html = katex.renderToString(tex, {
      displayMode: !!display, throwOnError: false, strict: false,
      // trust 不再全开：\href/\url 的链接经 safeUrl 白名单，其余信任场景一律拒绝
      trust: function (c) { return !!safeUrl(c && c.url); },
      macros: macrosForKatex || {}
    });
  } catch (e) {
    html = '<span class="math-error" title="' + esc(e.message || '') + '">' + esc(tex) + '</span>';
    ctx.warn(t('render.mathError', { msg: String(e.message || '').slice(0, 80) }), at, 'math');
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
  var ctx = {
    warnings: [],
    macros: {},
    headings: [],
    counters: { sec: 0, subsec: 0, subsubsec: 0, fig: 0, tab: 0, eq: 0, footnote: 0, bib: 0 },
    appendix: false,   // \appendix 之后一级章节改用字母编号
    labels: {},        // key -> 显示编号
    cites: {},         // key -> 序号
    bibItems: [],      // { key, html }
    footnotes: [],
    meta: { title: '', author: '', date: null, twocolumn: false, ctex: false, layout: FALLBACK, authorBlocks: [], thanks: [], heads: null, notice: '', keywords: '', institute: '' },
    diagrams: [],      // { id, svg, nodes, tikzsetRanges, wrapperId }
    tables: [],        // { id, envStart/End, colspec(+区间), rows: [{contentStart/End, nextStart, cells:[{start,end,raw}]}] }
    refPos: {},        // ref key -> 引用处绝对偏移，供「未定义引用」回落到行号
    // off 为源码绝对偏移：警告只有挂上行号，问题栏才能给出「第 N 行」并点击跳转
    warn: function (m, off, kind) {
      if (ctx.warnings.length >= 60) return;
      ctx.warnings.push({ msg: m, line: off == null ? null : lineOf(off), kind: kind || null });
    }
  };

  var src = String(srcRaw || '').replace(/\r\n?/g, '\n');
  src = blankComments(src);   // 等长抹除注释，偏移与行号仍对得上源码
  var lineStarts = null;       // 无警告的渲染不必付这次全文扫描
  function lineOf(off) {
    if (!lineStarts) {
      lineStarts = [0];
      for (var k = 0; k < src.length; k++) if (src.charCodeAt(k) === 10) lineStarts.push(k + 1);
    }
    var lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1; }
    return lo;
  }
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
  // 导言里的 \keywords 没有摘要块承接时，紧跟标题带显示，避免内容被丢掉
  if (ctx.meta.keywords && !ctx._kwShown) {
    var kwHtml = keywordsHtml(ctx.meta.keywords, ctx);
    var hEnd = html.indexOf('</header>');
    html = hEnd < 0 ? kwHtml + html : html.slice(0, hEnd + 9) + kwHtml + html.slice(hEnd + 9);
  }
  // 跨栏标题带之后的正文收进双栏容器（脚注仍在文档末尾、栏外）
  if (ctx._colsMarked) html = html.replace('@@COLS@@', '<div class="doc-cols">') + '</div>';

  // ---- 回填 ----
  var refSeen = {};
  html = html.replace(/@@R:([^@]*)@@/g, function (_, key) {
    if (ctx.labels[key] !== undefined) return esc(ctx.labels[key]);
    // 同一个 key 可能被引用多次，按出现次序取各自的出处
    var n = refSeen[key] = (refSeen[key] || 0) + 1;
    ctx.warn(t('render.undefinedRef', { key }), (ctx.refPos[key] || [])[n - 1], 'ref');
    return '<span class="bad-ref">?</span>';
  });
  html = html.replace(/@@C:([^@]*)@@/g, function (_, key) {
    if (ctx.cites[key] !== undefined) return String(ctx.cites[key]);
    return '<span class="bad-ref" title="' + esc(t('render.missingCite')) + '">?</span>';
  });
  html = html.replace(/@@TOC@@/g, function () { return buildToc(ctx); });
  if (ctx.footnotes.length) html += '<section class="footnotes"><hr/><ol>' + ctx.footnotes.map(function (f) { return '<li id="fn' + f.n + '">' + f.html + '</li>'; }).join('') + '</ol></section>';

  var stats = { chars: src.replace(/\s/g, '').length, words: countWords(src), cjk: (src.match(/[\u4e00-\u9fff]/g) || []).length };
  return { html: html, meta: ctx.meta, warnings: ctx.warnings, diagrams: ctx.diagrams, tables: ctx.tables, stats: stats, headings: ctx.headings };
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
  var authorRaw = '';
  if (ma) { var e2 = braceEnd(pre, ma.index + ma[0].length - 1); if (e2 > 0) authorRaw = pre.slice(ma.index + ma[0].length, e2); }
  ctx.meta.author = stripThanks(authorRaw.replace(/\\and/g, '，'));
  var md = pre.match(/\\date\s*\{/);
  ctx.meta.date = null;
  if (md) { var e3 = braceEnd(pre, md.index + md[0].length - 1); if (e3 > 0) ctx.meta.date = pre.slice(md.index + md[0].length, e3); }
  // elegantpaper 类模板把关键词/单位写在导言，随摘要与标题带显示
  var mkw = pre.match(/\\keywords\s*\{/);
  if (mkw) { var e4 = braceEnd(pre, mkw.index + mkw[0].length - 1); if (e4 > 0) ctx.meta.keywords = pre.slice(mkw.index + mkw[0].length, e4); }
  var minst = pre.match(/\\institute\s*\{/);
  // 写在 \author{…} 里的 \institute 随作者块渲染，不再单独显示一遍
  if (minst && !/\\institute(?![A-Za-z])/.test(authorRaw)) {
    var e5 = braceEnd(pre, minst.index + minst[0].length - 1);
    if (e5 > 0) ctx.meta.institute = pre.slice(minst.index + minst[0].length, e5);
  }

  var dcls = readDocumentclass(pre);
  var layout = dcls ? resolveLayout(dcls.cls, dcls.options) : FALLBACK;
  ctx.meta.layout = layout;
  ctx.meta.ctex = layout.family === 'ctex';
  ctx.meta.twocolumn = layout.columns === 2;
  if (layout.family === 'ieee') {
    ctx.meta.authorBlocks = parseAuthorBlocks(authorRaw);
    ctx.meta.thanks = collectThanks(authorRaw).concat(collectThanks(ctx.meta.title));
  }
  // \markboth{左页眉}{右页眉}：期刊版式在标题带上方的_running head_
  var mb = pre.match(/\\markboth\s*/);
  if (mb) {
    var hl = readGroup(pre, mb.index + mb[0].length);
    var hr = hl ? readGroup(pre, hl.end + 1) : null;
    if (hl && hr) ctx.meta.heads = { left: hl.text, right: hr.text };
  }
  var spn = pre.match(/\\(?:IEEE)?specialpapernotice\s*\{/);
  if (spn) { var e4 = braceEnd(pre, spn.index + spn[0].length - 1); if (e4 > 0) ctx.meta.notice = pre.slice(spn.index + spn[0].length, e4); }
}

// IEEEtran 作者带：\and 分作者，块内 \authorblockN{} 姓名、\authorblockA{} 单位（可多段）
function parseAuthorBlocks(raw) {
  var parts = [], cur = '', depth = 0;
  for (var i = 0; i < raw.length; i++) {
    var c = raw.charAt(i);
    if (c === '\\') {
      if (!depth && /^\\and(?![A-Za-z])/.test(raw.slice(i))) { parts.push(cur); cur = ''; i += 3; continue; }
      cur += c + (raw.charAt(i + 1) || ''); i++; continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    cur += c;
  }
  parts.push(cur);
  var blocks = [];
  parts.forEach(function (p) {
    if (!p.replace(/[{}\s\\]/g, '')) return;
    var block = { name: '', affils: [], raw: p };
    var re = /\\(?:IEEE)?authorblock([NA])\s*\{/g, m;
    while ((m = re.exec(p))) {
      var be = braceEnd(p, m.index + m[0].length - 1);
      if (be < 0) { continue }
      var text = p.slice(m.index + m[0].length, be);
      if (m[1] === 'N') block.name = block.name ? block.name + ', ' + text : text;
      else block.affils.push(text);
      re.lastIndex = be;
    }
    block.name = stripThanks(block.name);
    block.affils = block.affils.map(stripThanks);
    if (!block.name && !block.affils.length) { block.name = stripThanks(p).trim(); }
    blocks.push(block);
  });
  return blocks;
}

function collectThanks(raw) {
  var out = [], re = /\\thanks\s*\{/g, m;
  while ((m = re.exec(raw))) {
    var be = braceEnd(raw, m.index + m[0].length - 1);
    if (be < 0) break;
    out.push(raw.slice(m.index + m[0].length, be));
    re.lastIndex = be;
  }
  return out;
}

// 抹掉 \thanks{...}（按括号配平，内部还能有 \cite{}）
function stripThanks(text) {
  var res = '', i = 0;
  while (i < text.length) {
    var m = /\\thanks\s*\{/.exec(text.slice(i));
    if (!m) { res += text.slice(i); break; }
    var start = i + m.index;
    var e = braceEnd(text, start + m[0].length - 1);
    res += text.slice(i, start);
    i = e < 0 ? text.length : e + 1;
  }
  return res;
}

// ---------------- 换行 \\[<dim>] ----------------
// TeX 长度 → CSS 长度；em/ex 交给浏览器按当前字号解析，其余按 96dpi 折算，无单位按 sp
function texDimCss(raw) {
  var m = String(raw == null ? '' : raw).trim().match(/^(-?[\d.]+)\s*([a-zA-Z]+)?$/);
  if (!m) return null;
  var v = parseFloat(m[1]);
  if (!isFinite(v)) return null;
  var u = (m[2] || 'sp').toLowerCase();
  if (u === 'em' || u === 'ex') return +v.toFixed(3) + u;
  var px = { pt: 1.33, bp: 1.33, in: 96, cm: 37.8, mm: 3.78, dd: 1.42, cc: 17.05, sp: 0.00002 }[u];
  if (typeof px !== 'number') return null;
  return +(v * px).toFixed(2) + 'px';
}

// s[pos] 起是紧跟 \\ 的可选长度参数；返回 { css, next }，非长度参数不吞掉（保持原样）
function breakSpace(s, pos) {
  var opt = readOpt(s, pos);
  if (!opt) return null;
  var css = texDimCss(opt.text);
  if (!css) return null;
  return { css: css, next: opt.closeIdx + 1 };
}

// ---------------- 正文流式渲染 ----------------
// 返回 HTML；块级与段落自动分组。inlineMode=true 时不产生 <p> 段落（用于宏展开/标题/题注）
function renderFlow(str, ctx, base, isTop, inlineMode) {
  var tokens = [];  // {block:bool, html}
  var i = 0, n = str.length;
  var inlineBuf = '';
  var paraStart = null;  // 当前段落起始的源码绝对偏移，写入 <p data-off> 供预览点击回跳
  function touch() { if (paraStart === null) paraStart = base + i; }
  function flushP() {
    if (inlineMode) {
      if (inlineBuf.replace(/<[^>]*>/g, '').trim() || inlineBuf.trim()) tokens.push({ block: false, html: inlineBuf });
      inlineBuf = '';
      return;
    }
    if (inlineBuf.replace(/<[^>]*>/g, '').trim()) tokens.push({ block: false, html: '<p' + (paraStart != null ? ' data-off="' + paraStart + '"' : '') + '>' + inlineBuf + '</p>' });
    else if (inlineBuf.trim()) tokens.push({ block: false, html: inlineBuf });
    inlineBuf = '';
    paraStart = null;
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
          tokens.push({ block: true, html: withOff('<div class="equation">' + renderMath(expandMacros(str.slice(i + 2, e), ctx.macros, 0), true, ctx, katexMacrosOf(ctx), base + i) + '</div>', base + i) });
          i = e + 2; continue;
        }
      } else if (str.charAt(i + 1) && str.charAt(i + 1) !== '$') {
        var e2 = findMathEnd(str, i + 1, '$');
        if (e2 > 0) {
          touch(); inlineBuf += renderMath(expandMacros(str.slice(i + 1, e2), ctx.macros, 0), false, ctx, katexMacrosOf(ctx), base + i);
          i = e2 + 1; continue;
        }
      }
    }
    if (c === '\\' && str.substr(i, 2) === '\\[') {
      var e3 = findMathEnd(str, i + 2, '\\]');
      if (e3 > 0) {
        flushP();
        tokens.push({ block: true, html: withOff('<div class="equation">' + renderMath(expandMacros(str.slice(i + 2, e3), ctx.macros, 0), true, ctx, katexMacrosOf(ctx), base + i) + '</div>', base + i) });
        i = e3 + 2; continue;
      }
    }
    if (c === '\\' && str.substr(i, 2) === '\\(') {
      var e4 = findMathEnd(str, i + 2, '\\)');
      if (e4 > 0) {
        touch(); inlineBuf += renderMath(expandMacros(str.slice(i + 2, e4), ctx.macros, 0), false, ctx, katexMacrosOf(ctx), base + i);
        i = e4 + 2; continue;
      }
    }

    // 环境
    if (c === '\\' && str.substr(i, 7) === '\\begin{') {
      var probe = envAt(str, i);
      if (probe) {
        flushP();
        tokens.push({ block: true, html: withOff(renderEnv(probe, ctx, base + probe.innerStart), base + i) });
        i = probe.outerEnd; continue;
      }
    }

    // 命令
    if (c === '\\') {
      var vb = verbAt(str, i);
      if (vb) { touch(); inlineBuf += renderVerb(vb); i = vb.next; continue; }
      var cmdM = str.slice(i).match(/^\\([A-Za-z]+)\*?/);
      if (cmdM) {
        var r = handleCommand(cmdM[1], str, i, ctx, base, tokens, flushP);
        if (r === null) { ctx.warn(t('render.unsupportedCommand', { name: cmdM[1] }), base + i, 'command'); touch(); inlineBuf += esc(cmdM[0]); i += cmdM[0].length; continue; }
        var cmdOff = base + i;
        if (typeof r === 'number') { i = r; continue; }
        if (r.html !== undefined && !r.block) touch();
        i = r.next; if (r.html !== undefined) { if (r.block) { flushP(); tokens.push({ block: true, html: withOff(r.html, cmdOff) }); } else inlineBuf += r.html; }
        continue;
      }
      // \{ \} \\ \% 等
      if (str.substr(i, 2) === '\\\\') {
        var brk = breakSpace(str, i + 2);
        // \\[<dim>] 的额外间距用零高块元素的 margin-top 表达，负值可上移
        var brHtml = '<br/>' + (brk ? '<span class="brk-space" style="display:block;height:0;margin-top:' + brk.css + '"></span>' : '');
        if (inlineMode) { touch(); inlineBuf += brHtml; }
        else { flushP(); tokens.push({ block: true, html: withOff(brHtml, base + i) }); }
        i = brk ? brk.next : i + 2; continue;
      }
      var sp = str.substr(i, 2);
      if (sp === '\\%' || sp === '\\&' || sp === '\\#' || sp === '\\_' || sp === '\\$') { touch(); inlineBuf += esc(sp[1]); i += 2; continue; }
      if (sp === '\\{' || sp === '\\}') { touch(); inlineBuf += esc(sp[1]); i += 2; continue; }
      i++; continue;
    }

    // 文本（展开宏 → 排版细节）
    var next = i + 1;
    while (next < n && '$\\%\n'.indexOf(str.charAt(next)) < 0) next++;
    touch(); inlineBuf += typesetText(expandMacros(str.slice(i, next), ctx.macros, 0));
    i = next;
  }
  flushP();

  // 顶层：包装成 article 容器由调用方处理
  return tokens.map(function (t) { return t.html; }).join('\n');
}

function katexMacrosOf(ctx) {
  if (ctx._katexMacros) return ctx._katexMacros;
  // KaTeX 不认 \mbox 与 booktabs 横线：前者按 \text 排，后者在数学 array 里画 \hline，
  // 否则会渲染成一串红色未知命令字母。文档自定义宏优先级更高。
  var m = { '\\mbox': '\\text', '\\toprule': '\\hline', '\\midrule': '\\hline', '\\bottomrule': '\\hline' };
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

// 引用占位符记下出处偏移：回填不到编号时，警告才知道该挂在哪一行
function refPlaceholder(ctx, at, key) {
  (ctx.refPos[key] || (ctx.refPos[key] = [])).push(at);
  return '@@R:' + key + '@@';
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
      // IEEEtran 的编号体系：I. / A) / 1)，与其他类的 1 / 1.1 / 1.1.1 不同
      var ieee = ctx.meta.layout.family === 'ieee';
      if (!starred && lvl <= 3) {
        if (lvl === 1) { ctx.counters.sec++; ctx.counters.subsec = 0; ctx.counters.subsubsec = 0; num = ctx.appendix ? toAlpha(ctx.counters.sec) : ieee ? toRoman(ctx.counters.sec) : ctx.counters.sec; }
        else if (lvl === 2) { ctx.counters.subsec++; ctx.counters.subsubsec = 0; num = ctx.appendix ? toAlpha(ctx.counters.sec) + '.' + ctx.counters.subsec : ieee ? String.fromCharCode(64 + ctx.counters.subsec) + ')' : ctx.counters.sec + '.' + ctx.counters.subsec; }
        else { ctx.counters.subsubsec++; num = ctx.appendix ? toAlpha(ctx.counters.sec) + '.' + ctx.counters.subsec + '.' + ctx.counters.subsubsec : ieee ? ctx.counters.subsubsec + ')' : ctx.counters.sec + '.' + ctx.counters.subsec + '.' + ctx.counters.subsubsec; }
      }
      var inner = renderFlow(g1.text, ctx, base + g1.start, false, true);
      var hid = 'h-' + ctx.headings.length;
      ctx.headings.push({ level: lvl, num: num, text: stripTags(inner), id: hid, offset: base + i });
      // 标题内的 \label
      var lm = g1.text.match(/\\label\{([^}]+)\}/);
      if (lm) ctx.labels[lm[1]] = num || '';
      var tag = lvl <= 3 ? 'h' + (lvl + 1) : 'p';
      var cls = lvl === 1 ? 'sec1' : lvl === 2 ? 'sec2' : lvl === 3 ? 'sec3' : 'parag';
      var secHtml = '<' + tag + ' id="' + hid + '" class="' + cls + '">' + (num ? '<span class="secnum">' + num + '</span> ' : '') + inner + '</' + tag + '>';
      // IEEE 期刊版式：标题/摘要/术语跨栏，正文从第一个 \section 起进入双栏
      if (ctx.meta.layout.spanHead && !ctx._colsMarked) { ctx._colsMarked = true; secHtml = '@@COLS@@' + secHtml; }
      return { next: g1.end + 1, block: true, html: secHtml };
    }
    case 'maketitle': return { next: afterName, block: true, html: renderTitleBlock(ctx) };
    case 'appendix':
      // 与 article/ctex 一致：附录起一级章节重新计数并改用 A/B/C，图、表编号不受影响
      ctx.appendix = true;
      ctx.counters.sec = 0; ctx.counters.subsec = 0; ctx.counters.subsubsec = 0;
      return afterName;
    case 'tableofcontents': return { next: afterName, block: true, html: '@@TOC@@' };
    case 'today': return { next: afterName, html: zhToday() };
    case 'newpage': case 'clearpage': return { next: afterName, block: true, html: '<div class="pagebreak"></div>' };
    case 'par': flushP(); return afterName;

    // ---- 文本格式 ----
    case 'textbf': g1 = G(afterName); if (!g1) return null; return { next: g1.end + 1, html: '<strong>' + renderFlow(g1.text, ctx, base + g1.start, false, true) + '</strong>' };
    case 'textit': case 'emph': g1 = G(afterName); if (!g1) return null; return { next: g1.end + 1, html: '<em>' + renderFlow(g1.text, ctx, base + g1.start, false, true) + '</em>' };
    case 'underline': g1 = G(afterName); if (!g1) return null; return { next: g1.end + 1, html: '<u>' + renderFlow(g1.text, ctx, base + g1.start, false, true) + '</u>' };
    case 'texttt': g1 = G(afterName); if (!g1) return null; return { next: g1.end + 1, html: '<code>' + renderFlow(g1.text, ctx, base + g1.start, false, true) + '</code>' };
    case 'mbox': case 'hbox': g1 = G(afterName); if (!g1) return null; return { next: g1.end + 1, html: '<span class="mbox">' + renderFlow(g1.text, ctx, base + g1.start, false, true) + '</span>' };
    case 'fbox': g1 = G(afterName); if (!g1) return null; return { next: g1.end + 1, html: '<span class="fbox">' + renderFlow(g1.text, ctx, base + g1.start, false, true) + '</span>' };
    case 'dots': case 'ldots': return { next: afterName, html: '\u2026' };
    case 'textsc': g1 = G(afterName); if (!g1) return null; return { next: g1.end + 1, html: '<span class="smallcaps">' + renderFlow(g1.text, ctx, base + g1.start, false, true) + '</span>' };
    case 'MakeLowercase': case 'MakeUppercase': {
      // 大小写变换作用在源码文本上（先变换再渲染），避免改写已生成的 HTML 标签
      g1 = G(afterName); if (!g1) return null;
      var cv = name === 'MakeLowercase' ? g1.text.toLowerCase() : g1.text.toUpperCase();
      return { next: g1.end + 1, html: renderFlow(cv, ctx, base + g1.start, false, true) };
    }
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
    case 'ref': g1 = G(afterName); if (!g1) return null; return { next: g1.end + 1, html: refPlaceholder(ctx, base + i, g1.text.trim()) };
    case 'autoref': case 'cref': case 'Cref': {
      g1 = G(afterName); if (!g1) return null;
      var pre2 = name === 'Cref' ? esc(t('render.figure')) + ' ' : '';
      return { next: g1.end + 1, html: pre2 + refPlaceholder(ctx, base + i, g1.text.trim()) };
    }
    case 'figref': case 'tabref': {
      // elegantpaper 一类模板的带前缀引用：\figref → 图 n、\tabref → 表 n
      g1 = G(afterName); if (!g1) return null;
      return { next: g1.end + 1, html: esc(t(name === 'figref' ? 'render.figure' : 'render.table')) + '&nbsp;' + refPlaceholder(ctx, base + i, g1.text.trim()) };
    }
    case 'eqref': g1 = G(afterName); if (!g1) return null; return { next: g1.end + 1, html: esc(t('render.equation')) + '&nbsp;(' + refPlaceholder(ctx, base + i, g1.text.trim()) + ')' };
    case 'cite': case 'citep': case 'citet': case 'citealp': case 'parencite': case 'autocite': case 'textcite': {
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
    case 'url': {
      g1 = G(afterName); if (!g1) return null;
      var uUrl = safeUrl(g1.text);
      return { next: g1.end + 1, html: uUrl
        ? '<a href="' + esc(uUrl) + '" target="_blank" rel="noopener">' + esc(g1.text) + '</a>'
        : esc(g1.text) };
    }
    case 'email': {
      g1 = G(afterName); if (!g1) return null;
      var addr = g1.text.trim();
      return { next: g1.end + 1, html: '<a class="doc-email" href="mailto:' + esc(addr) + '">' + esc(addr) + '</a>' };
    }
    case 'keywords': {
      g1 = G(afterName); if (!g1) return null;
      return { next: g1.end + 1, block: true, html: keywordsHtml(g1.text, ctx) };
    }
    case 'institute': {
      g1 = G(afterName); if (!g1) return null;
      return { next: g1.end + 1, block: true, html: '<div class="doc-institute">' + renderFlow(g1.text, ctx, base + g1.start, false, true) + '</div>' };
    }
    case 'hologo': {
      // 只是把 logo 名按普通文本排（XeLaTeX 之类），不做连字图形
      g1 = G(afterName); if (!g1) return null;
      return { next: g1.end + 1, html: renderFlow(g1.text, ctx, base + g1.start, false, true) };
    }
    case 'version': { var gv = G(afterName); return gv ? gv.end + 1 : afterName; }
    case 'appendixpage': case 'addappheadtotoc': case 'printbibliography': case 'listoffigures': case 'listoftables': {
      // 目录/文献由应用自己的环境负责，这些开关不产出内容（可选参数一并吞掉）
      var so = readOpt(str, afterName);
      return so ? so.closeIdx + 1 : afterName;
    }
    case 'href': {
      g1 = G(afterName); g2 = G(g1 ? g1.end + 1 : afterName);
      if (!g1 || !g2) return null;
      var uHref = safeUrl(g1.text.replace(/\\([{}%#&_$])/g, '$1'));
      var label = renderFlow(g2.text, ctx, base + g2.start, false, true);
      return { next: g2.end + 1, html: uHref
        ? '<a href="' + esc(uHref) + '" target="_blank" rel="noopener">' + label + '</a>'
        : label };
    }

    // ---- 导言命令写在正文里（\begin{document} 之后的 \title/\author/\date） ----
    case 'title': case 'author': case 'date': {
      o1 = readOpt(str, afterName);
      g1 = G(o1 ? o1.closeIdx + 1 : afterName);
      if (!g1) return null;
      if (name === 'title') ctx.meta.title = g1.text;
      else if (name === 'date') ctx.meta.date = g1.text;
      else {
        ctx.meta.author = stripThanks(g1.text.replace(/\\and/g, '，'));
        if (ctx.meta.layout.family === 'ieee') {
          ctx.meta.authorBlocks = parseAuthorBlocks(g1.text);
          ctx.meta.thanks = ctx.meta.thanks.concat(collectThanks(g1.text));
        }
      }
      return g1.end + 1;
    }

    // ---- IEEEtran 版式 ----
    case 'IEEEPARstart': {
      g1 = G(afterName); g2 = G(g1 ? g1.end + 1 : afterName);
      if (!g1 || !g2) return null;
      return { next: g2.end + 1, html: '<span class="ieeepar"><span class="ieeepar-c">' + esc(g1.text.trim()) +
        '</span><span class="ieeepar-w">' + renderFlow(g2.text, ctx, base + g2.start, false, true) + '</span></span>' };
    }
    case 'authorblockN': case 'IEEEauthorblockN': case 'authorblockA': case 'IEEEauthorblockA': {
      g1 = G(afterName); if (!g1) return null;
      var kind = /N$/.test(name) ? 'au-name' : 'au-affil';
      return { next: g1.end + 1, html: '<span class="' + kind + '">' + renderFlow(stripThanks(g1.text), ctx, base + g1.start, false, true) + '</span>' };
    }
    case 'IEEEauthorrefmark': case 'authorrefmark': {
      g1 = G(afterName); if (!g1) return null;
      var marks = ['*', '†', '‡', '#', '**', '††', '‡‡', '§', '¶', '*#', '##', '***'];
      var mi = parseInt(g1.text.trim(), 10);
      return { next: g1.end + 1, html: '<sup class="au-mark">' + esc(marks[mi - 1] || g1.text.trim()) + '</sup>' };
    }
    case 'IEEEmembership': {
      g1 = G(afterName); if (!g1) return null;
      return { next: g1.end + 1, html: '<span class="au-member">' + renderFlow(g1.text, ctx, base + g1.start, false, true) + '</span>' };
    }
    case 'markboth': {
      g1 = G(afterName); g2 = G(g1 ? g1.end + 1 : afterName);
      if (!g1 || !g2) return null;
      ctx.meta.heads = { left: g1.text, right: g2.text };
      return g2.end + 1;
    }
    case 'specialpapernotice': case 'IEEEspecialpapernotice': {
      g1 = G(afterName); if (!g1) return null;
      ctx.meta.notice = g1.text;
      return g1.end + 1;
    }
    case 'thanks': {
      // 标题带的 \thanks 由导言解析收集；出现在正文时按脚注处理
      g1 = G(afterName); if (!g1) return null;
      ctx.counters.footnote++;
      var thk = ctx.counters.footnote;
      ctx.footnotes.push({ n: thk, html: renderFlow(g1.text, ctx, base + g1.start, false, true) });
      return { next: g1.end + 1, html: '<sup class="fnref" id="fnr' + thk + '">' + thk + '</sup>' };
    }
    // 声明/锁定类命令：不产出可见内容，连参数一起吞掉，别混进「不支持的命令」警告
    case 'IEEEoverridecommandlockouts': case 'IEEEpubidadjcol': case 'IEEEcodenull': case 'IEEEnoheadbothpages': case 'IEEEallowmathtextinbibitem':
      return afterName;
    case 'IEEEpubid': case 'IEEEtriggeratref': case 'IEEEtriggercmdref': case 'IEEEcompsocitemizethanks': case 'IEEEcompsoctitleabstractindextext': case 'IEEEtitleabstractindextext': case 'IEEEdisplaynotcompsoctitleabstractindextext': case 'IEEEaftertitletext':
      { var gsk = G(afterName); return gsk ? gsk.end + 1 : afterName; }

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

    // ---- 表格横线 ----
    // 行首的 \hline/\toprule/… 由 renderTabular 提取成 tr 类名；出现在别处（单元格内、
    // 表格环境降级后）只吞掉参数，不显示成文字
    case 'hline': case 'toprule': case 'midrule': case 'bottomrule':
      return afterName;
    case 'cline': case 'cmidrule': {
      var rp = afterName;
      if (str.charAt(rp) === '(') { var rc = str.indexOf(')', rp); if (rc >= 0) rp = rc + 1; }
      var rg = G(rp);
      return rg ? rg.end + 1 : rp;
    }

    case 'endfirsthead': case 'endhead': case 'endfoot': case 'endlastfoot':
      // longtable 的分页标记：表体切分后残留的标记不产出内容
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
      return { next: g1.end + 1, html: '<img class="includegraphics" src="' + esc(g1.text.trim()) + '" alt="' + esc(g1.text) + '"' + wstyle + '/>' };
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

// IEEEtran 一级章节用罗马数字
function toRoman(n) {
  var tab = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']], out = '';
  tab.forEach(function (p) { while (n >= p[0]) { out += p[1]; n -= p[0]; } });
  return out;
}

// \appendix 之后一级章节用字母（A / B / … / AA）
function toAlpha(n) {
  var out = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + (n - 1) % 26) + out;
  return out;
}

// 标题带：IEEEtran 按作者块排版（会议多栏、期刊居中），其余类沿用 title/author/date
function renderTitleBlock(ctx) {
  var L = ctx.meta.layout;
  var out = '<header class="titleblock">';
  if (L.heads && ctx.meta.heads) {
    out += '<div class="doc-heads"><span class="head-l">' + renderFlow(ctx.meta.heads.left, ctx, 0, false, true) +
      '</span><span class="head-r">' + renderFlow(ctx.meta.heads.right, ctx, 0, false, true) + '</span></div>';
  }
  if (ctx.meta.notice) out += '<div class="doc-notice">' + renderFlow(ctx.meta.notice, ctx, 0, false, true) + '</div>';
  out += '<h1 class="doc-title">' + (ctx.meta.title ? renderFlow(ctx.meta.title, ctx, 0, false, true) : esc(t('render.untitled'))) + '</h1>';
  if (L.authorLayout !== 'plain' && ctx.meta.authorBlocks.length) {
    out += '<div class="au-row au-' + L.authorLayout + '">' + ctx.meta.authorBlocks.map(function (b) {
      return '<div class="au-block">' +
        (b.name ? '<div class="au-name">' + renderFlow(b.name, ctx, 0, false, true) + '</div>' : '') +
        b.affils.map(function (a) { return '<div class="au-affil">' + renderFlow(a, ctx, 0, false, true) + '</div>'; }).join('') +
        '</div>';
    }).join('') + '</div>';
  } else if (ctx.meta.author) {
    out += '<div class="doc-author">' + renderFlow(ctx.meta.author, ctx, 0, false, true) + '</div>';
  }
  if (ctx.meta.thanks.length) {
    out += '<div class="au-thanks">' + ctx.meta.thanks.map(function (x) { return '<p>' + renderFlow(x, ctx, 0, false, true) + '</p>'; }).join('') + '</div>';
  }
  if (ctx.meta.institute) out += '<div class="doc-institute">' + renderFlow(ctx.meta.institute, ctx, 0, false, true) + '</div>';
  if (L.family !== 'ieee' && ctx.meta.date) out += '<div class="doc-date">' + renderFlow(ctx.meta.date, ctx, 0, false, true) + '</div>';
  return out + '</header>';
}
// 关键词行：导言里的 \keywords 随摘要显示，正文里出现则就地显示
function keywordsHtml(text, ctx) {
  ctx._kwShown = true;
  return '<div class="doc-keywords"><span class="kw-label">' + esc(t('render.keywords')) + esc(t('render.termsSep')) + '</span>' +
    renderFlow(text, ctx, 0, false, true) + '</div>';
}

function zhToday() {
  var d = new Date();
  if (getLang() === 'en') return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
}

// ---------------- 环境渲染 ----------------
function renderEnv(env, ctx, absInnerStart) {
  var inner = env.inner, base = absInnerStart;
  switch (env.name) {
    case 'document': return renderFlow(inner, ctx, base, true);

    case 'abstract':
      if (ctx.meta.layout.family === 'ieee') {
        // IEEE 版式：摘要不带边框，标签与正文同行（Abstract—…）
        return '<div class="abstract ieee-abstract"><span class="abs-label">' + esc(t('render.abstract')) + esc(t('render.termsSep')) + '</span>' + renderFlow(inner, ctx, base, false) + '</div>';
      }
      return '<div class="abstract"><h4>' + esc(t('render.abstract')) + '</h4>' + renderFlow(inner, ctx, base, false) +
        (ctx.meta.keywords ? keywordsHtml(ctx.meta.keywords, ctx) : '') + '</div>';

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
        body2 = renderMath('\\begin{aligned}' + tex.replace(/&/g, '&').replace(/\n/g, ' \\\\ ') + '\\end{aligned}', true, ctx, katexMacrosOf(ctx), base);
      } else if (env.name.indexOf('gather') === 0) {
        body2 = renderMath('\\begin{gathered}' + tex + '\\end{gathered}', true, ctx, katexMacrosOf(ctx), base);
      } else {
        body2 = renderMath(tex, true, ctx, katexMacrosOf(ctx), base);
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
      // 浮动体位置选项（[h]/[!htbp] 等）不参与排版，吞掉避免渲染成正文
      var content = inner.replace(/^\s*\[[^\]]*\]/, '');

      var n2 = isFig ? ++ctx.counters.fig : ++ctx.counters.tab;
      if (label) ctx.labels[label] = String(n2);

      var capHtml = cap !== null ? renderFlow(cap, ctx, base, false, true) : '';
      // content 相对 inner 截去了前导 [..]，base 需同步平移，否则子环境（tikzpicture）的源码偏移会错位
      var contentHtml = renderFlow(content, ctx, base + (inner.length - content.length), false);
      var capName = esc(t(isFig ? 'render.figure' : 'render.table'));
      return '<figure class="float ' + (isFig ? 'fig' : 'tab') + '">' + contentHtml +
        (cap !== null ? '<figcaption>' + capName + '&nbsp;' + n2 + esc(t('render.captionSeparator')) + capHtml + '</figcaption>' : '') + '</figure>';
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
      var out2 = '<section class="bibliography"><h2 class="sec1">' + esc(t('render.references')) + '</h2><ol class="bib-list">';
      bibMatches.forEach(function (bm, ix) {
        var bodyEnd = ix + 1 < bibMatches.length ? bibMatches[ix + 1].cmdStart : inner.length;
        ctx.counters.bib++;
        ctx.cites[bm.key] = ctx.counters.bib;
        out2 += '<li id="bib-' + esc(bm.key) + '">' + renderFlow(inner.slice(bm.bodyStart, bodyEnd), ctx, base + bm.bodyStart, false) + '</li>';
      });
      out2 += '</ol></section>';
      return out2;
    }

    case 'cases': case 'matrix': case 'pmatrix': case 'bmatrix': case 'vmatrix': case 'Bmatrix': case 'array': case 'tabular': case 'tabularx': case 'tabular*': {
      if (env.name === 'tabular') return renderTabular(inner, ctx, base, false, null, env);
      if (env.name === 'tabularx' || env.name === 'tabular*') return renderTabular(inner, ctx, base, true, 'width:100%', env);
      // 数学环境出现在文本流中（少见），直接交给 KaTeX
      return '<div class="equation">' + renderMath('\\begin{' + env.name + '}' + inner + '\\end{' + env.name + '}', true, ctx, katexMacrosOf(ctx), base) + '</div>';
    }

    case 'longtable': {
      // 跨页表头/表脚：只留第一份表头与表体，其余块用等长空格抹掉（源码偏移保持一一对应）
      var lt = inner.replace(/^\s*\[[^\]]*\]/, '');
      var ltBase = base + (inner.length - lt.length);
      var mkRe = /\\end(firsthead|head|lastfoot|foot)(?![A-Za-z])/g, mm, marks = [];
      while ((mm = mkRe.exec(lt))) marks.push({ name: mm[1], from: mm.index, to: mm.index + mm[0].length });
      if (marks.length) {
        var lastMk = marks[marks.length - 1];
        var keepHead = null;
        for (var mi = 0; mi < marks.length; mi++) {
          if (marks[mi].name === 'firsthead' || marks[mi].name === 'head') { keepHead = marks[mi]; break; }
        }
        var chars = lt.split('');
        function blank(from, to) {
          for (var q = Math.max(0, from); q < Math.min(to, chars.length); q++) if (chars[q] !== '\n') chars[q] = ' ';
        }
        blank(keepHead ? keepHead.to : 0, lastMk.to);
        marks.forEach(function (x) { blank(x.from, x.to); });
        lt = chars.join('');
      }
      // longtable 自带题注（不套在 table 浮动体里），按表编号
      var ltCap = null, ltLabel = null;
      var ltCapRe = /\\caption\s*(?:\[[^\]]*\])?\s*\{/g, lcm;
      while ((lcm = ltCapRe.exec(lt))) {
        var lbe = braceEnd(lt, lcm.index + lcm[0].length - 1);
        if (lbe < 0) continue;
        ltCap = lt.slice(lcm.index + lcm[0].length, lbe);
        break;
      }
      var ltLab = lt.match(/\\label\{([^}]+)\}/);
      if (ltLab) ltLabel = ltLab[1];
      var tableHtml = renderTabular(lt, ctx, ltBase, false, 'width:100%');
      if (ltCap === null) return tableHtml;
      var ltN = ++ctx.counters.tab;
      if (ltLabel) ctx.labels[ltLabel] = String(ltN);
      return '<figure class="float tab">' + tableHtml + '<figcaption>' + esc(t('render.table')) + '&nbsp;' + ltN +
        esc(t('render.captionSeparator')) + renderFlow(ltCap, ctx, base, false, true) + '</figcaption></figure>';
    }

    case 'appendix':
      // \begin{appendix}…\end{appendix}（appendix 宏包/部分模板）与 \appendix 同义
      ctx.appendix = true;
      ctx.counters.sec = 0; ctx.counters.subsec = 0; ctx.counters.subsubsec = 0;
      return renderFlow(inner, ctx, base, false);

    case 'split': case 'aligned': case 'gathered':
      return '<div class="equation">' + renderMath('\\begin{' + env.name + '}' + inner + '\\end{' + env.name + '}', true, ctx, katexMacrosOf(ctx), base) + '</div>';

    case 'IEEEkeywords':
      return '<div class="ieee-keywords"><span class="kw-label">' + esc(t('render.indexTerms')) + esc(t('render.termsSep')) + '</span>' + renderFlow(inner, ctx, base, false) + '</div>';

    case 'IEEEbiography': case 'IEEEbiographynophoto': {
      var bopt = env.name === 'IEEEbiography' ? readOpt(inner, 0) : null;
      var bpos = bopt ? bopt.closeIdx + 1 : 0;
      var bname = readGroup(inner, bpos);
      var bbody = bname ? inner.slice(bname.end + 1) : '';
      var bstart = bname ? bname.end + 1 : bpos;
      return '<figure class="ieee-bio">' +
        (bopt ? '<div class="bio-photo">' + renderFlow(bopt.text, ctx, base + bopt.openIdx + 1, false) + '</div>' : '') +
        '<figcaption class="bio-name">' + (bname ? renderFlow(bname.text, ctx, base + bname.start, false, true) : '') + '</figcaption>' +
        '<div class="bio-text">' + renderFlow(bbody, ctx, base + bstart, false) + '</div></figure>';
    }

    case 'IEEEproof':
      return '<div class="proof"><span class="proof-label">' + esc(t('render.proof')) + '</span>' + renderFlow(inner, ctx, base, false) + '<span class="qed">&#8718;</span></div>';

    case 'IEEEeqnarray': case 'IEEEeqnarray*': {
      // 第一组是列格式（rCl 之类），不参与渲染；其余按 align 近似
      var spec = readGroup(inner, 0);
      return renderEnv({ name: env.name === 'IEEEeqnarray' ? 'align' : 'align*', inner: spec ? inner.slice(spec.end + 1) : inner }, ctx, base + (spec ? spec.end + 1 : 0));
    }

    default: {
      ctx.warn(t('render.environmentFallback', { name: env.name }), base, 'env');
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

// 行首的 \caption[..]{..} / \label{..}：longtable 常与 \toprule 同处一行，
// 不先跳过就识别不出行横线（内容本身由 handleCommand 吞掉）
function skipRowDecls(s) {
  var re = /^\s*\\(caption|label)(?![A-Za-z])\s*/;
  var m;
  while ((m = s.match(re))) {
    var p = m.index + m[0].length;
    if (s.charAt(p) === '[') {
      var ce = s.indexOf(']', p);
      if (ce > 0) p = ce + 1;
    }
    while (p < s.length && /\s/.test(s.charAt(p))) p++;
    if (s.charAt(p) !== '{') break;
    var be = braceEnd(s, p);
    if (be < 0) break;
    s = s.slice(be + 1);
  }
  return s;
}

// ---------------- tabular ----------------
// widthArg=true：{宽度} 在列格式之前（tabularx/tabular*），误当成列格式会让整行错位（\toprule 掉进首格）
// tableStyle：表格整体宽度等附加样式
// env：来自 findEnv 的环境对象（outerStart/innerStart 等，相对当前流）。
// 可视化表格编辑需要每个单元格/行/列格式的源码区间——渲染时顺手记录进 ctx.tables，
// id 写到 <table data-tid>，TablePanel 据此把面板编辑精确写回源码（TikZ 图样式同款思路）。
function renderTabular(inner, ctx, base, widthArg, tableStyle, env) {
  // 列格式 {} 前可能有 {宽度}（tabularx）或 [pos]（tabular[t]{...}）
  var pos = 0;
  if (widthArg) { var wg = readGroup(inner, 0); if (wg) pos = wg.end + 1; }
  var g = readGroup(inner, pos);
  if (!g) {
    // 可选的 [t]/[b] 对齐说明符在列格式之前
    var gp = readOpt(inner, pos);
    if (gp) g = readGroup(inner, gp.closeIdx + 1);
  }
  var colspec = g ? g.text : 'c';
  var bodyStr = g ? inner.slice(g.end + 1) : inner;
  var bodyStart = g ? g.end + 1 : 0;
  var cols = parseColspec(colspec);

  // 按顶层 \\ 分行（\tabularnewline 也算），尊重嵌套 {}
  var rows = [], buf = '', bufStart = 0, i = 0;
  var rulesBefore = [];
  var pendingRule = null;
  function depth0Split(s) {
    var depth = 0, out = [], cur = '', curStart = 0, curGap = null;
    for (var j = 0; j < s.length; j++) {
      var c = s.charAt(j);
      if (c === '\\') {
        if (s.substr(j, 2) === '\\\\') {
          out.push({ text: cur, start: curStart, gap: curGap });
          var bs = breakSpace(s, j + 2);   // \\[<dim>]：行间距，不吞掉会让 "[3pt]" 落到下一行首格
          cur = ''; curStart = bs ? bs.next : j + 2;
          curGap = bs ? bs.css : null;
          if (bs) j = bs.next - 2;         // 连同 [<dim>] 一起跳过（下面 j++ 与 for 的 j++ 共两步）
          j++; continue;
        }
        // \verb 定界符里的 & 与 \\ 不是分隔符，整段照抄
        var vb = verbAt(s, j);
        if (vb) { cur += s.slice(j, vb.next); j = vb.next - 1; continue; }
        cur += c + (s.charAt(j + 1) || ''); j++; continue;
      }
      if (c === '{') depth++;
      if (c === '}') depth--;
      cur += c;
    }
    out.push({ text: cur, start: curStart, gap: curGap });
    return out;
  }
  var rawRows = depth0Split(bodyStr);
  // 可视化编辑元数据：行的内容区间 + 每个单元格去空白后的源码区间与原文
  var tblId = ctx.tables.length;
  var tblRows = [];
  // 处理行内规则线
  var trs = [];
  var lastTrIdx = -1;
  rawRows.forEach(function (rr) {
    var t = rr.text;
    // longtable 习惯把 \caption{...}\label{...} 写在首行前，先跳过才认得出行首横线
    t = skipRowDecls(t);
    // 提取行首的 \hline \toprule \midrule \bottomrule \cline \cmidrule（含各自参数）
    var ruleClass = '';
    var re = /^\s*\\(hline|toprule|midrule|bottomrule|cline|cmidrule)(?![A-Za-z])\s*(?:\([^)]*\))?\s*(?:\{[^}]*\})?/;
    var m;
    var pre = '';
    while ((m = t.match(re))) {
      var rn = m[1];
      if (rn === 'cline' || rn === 'cmidrule') ruleClass += ' cl';
      else ruleClass += ' r-' + rn;
      t = t.slice(m[0].length);
    }
    var consumed = rr.text.length - t.length;  // 行首吞掉的声明与横线，单元格偏移需补回
    if (!t.trim()) { // 独立规则行：前导规则给下一行，表尾规则附加到最后一行
      pendingRule = (pendingRule || '') + ruleClass;
      return;
    }
    var rowInfo = { contentStart: base + bodyStart + rr.start + consumed, contentEnd: base + bodyStart + rr.start + consumed + t.length, cells: [] };
    var cells = splitTopLevel(t, '&').map(function (c2, ci) {
      var lead = c2.text.length - c2.text.replace(/^\s+/, '').length;  // trim 掉的前导空白要补进偏移，回跳才落得到单元格行
      var raw = c2.text.trim();
      var orig = raw;   // multicolumn 剥壳前的源码原文（面板按原文编辑）
      var span = 1;
      var mc = raw.match(/\\multicolumn\{(\d+)\}\s*\{[^}]*\}\s*\{/);
      if (mc) {
        span = +mc[1];
        var mcBe = braceEnd(raw, raw.indexOf('{', mc.index + mc[0].length - 1));
        raw = mcBe > 0 ? raw.slice(mc.index + mc[0].length, mcBe) + raw.slice(mcBe + 1) : raw;
      }
      var cellStart = base + bodyStart + rr.start + consumed + c2.start + lead;
      rowInfo.cells.push({ start: cellStart, end: cellStart + orig.length, raw: orig });
      var cell = renderFlow(raw, ctx, cellStart, false);
      var cls = [];
      if (cols.rules[ci]) cls.push('vline');
      if (cols.align[ci] === 'l') cls.push('ta-l');
      if (cols.align[ci] === 'r') cls.push('ta-r');
      var w = cols.widths[ci] ? ' style="width:' + cols.widths[ci] + '"' : '';
      return '<td' + (span > 1 ? ' colspan="' + span + '"' : '') + (cls.length ? ' class="' + cls.join(' ') + '"' : '') + w + '>' + cell + '</td>';
    }).join('');
    tblRows.push(rowInfo);
    var trCls = (pendingRule || '') + ruleClass;
    pendingRule = null;
    trs.push('<tr class="' + trCls.trim() + '"' + (rr.gap ? ' style="--rg:' + rr.gap + '"' : '') + '>' + cells + '</tr>');
    lastTrIdx = trs.length - 1;
  });
  // 末尾独立规则线（如 ... \\ \bottomrule）附加到最后一行
  if (pendingRule && trs.length) {
    trs[trs.length - 1] = trs[trs.length - 1].replace('<tr class="', '<tr class="' + pendingRule.trim() + ' ');
  }

  // 行删除/插入需要「下一原始行的起点」：行内容 + 其 \\ 一并处理，规则线留给下一行
  var nRaw = rawRows.length;
  tblRows.forEach(function (rowInfo) {
    // 找到该行对应的 rawRows 序号（contentStart 落在哪个 raw row 的区间里）
    var hostRi = -1;
    for (var ri = 0; ri < nRaw; ri++) {
      var s = base + bodyStart + rawRows[ri].start;
      if (s <= rowInfo.contentStart && rowInfo.contentStart < s + Math.max(rawRows[ri].text.length, 1)) { hostRi = ri; break; }
    }
    rowInfo.nextStart = hostRi >= 0 && hostRi + 1 < nRaw ? base + bodyStart + rawRows[hostRi + 1].start : rowInfo.contentEnd;
    rowInfo.hasFollowingRow = hostRi >= 0 && hostRi + 1 < nRaw;
  });

  // 记录整表元数据（env 给出 \begin...\end 的绝对区间；colspec 内容区间直接可得）
  var prefixLen = env && env.innerStart != null && env.outerStart != null ? env.innerStart - env.outerStart : '\\begin{tabular}'.length;
  var endLen = env && env.outerEnd != null && env.innerEnd != null ? env.outerEnd - env.innerEnd : '\\end{tabular}'.length;
  ctx.tables.push({
    id: tblId,
    envStart: base - prefixLen,
    envEnd: base + inner.length + endLen,
    colspec: colspec,
    colspecStart: g ? base + g.start : -1,
    colspecEnd: g ? base + g.end : -1,
    cols: cols.align.length,
    rows: tblRows,
  });

  return '<table class="tabular" data-tid="' + tblId + '"' + (tableStyle ? ' style="' + tableStyle + '"' : '') + '><tbody>' + trs.join('') + '</tbody></table>';
}

function splitTopLevel(s, sep) {
  var out = [], depth = 0, cur = '', start = 0;
  for (var j = 0; j < s.length; j++) {
    var c = s.charAt(j);
    if (c === '\\') {
      // \verb 定界符内的 & 属于内容，不是列分隔符
      var vb = verbAt(s, j);
      if (vb) { cur += s.slice(j, vb.next); j = vb.next - 1; continue; }
      cur += c + (s.charAt(j + 1) || ''); j++; continue;
    }
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
    if (c === 'X' || c === 'L' || c === 'C' || c === 'R') { align[j] = c === 'C' ? 'c' : c === 'R' ? 'r' : 'l'; j++; continue; } // tabularx 列
    if (c === 'p' || c === 'm' || c === 'b') {
      var e = spec.indexOf('{', i);
      // 列宽会拼进 <td style="width:...">：只接受 TeX 尺寸（texDimCss 白名单），
      // 其余（含注入载荷）丢弃，避免列格式串逃逸出属性区
      if (e > 0) { var be = spec.indexOf('}', e); widths[j] = texDimCss(spec.slice(e + 1, be > 0 ? be : spec.length)) || ''; }
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
  if (!TIKZ) return '<div class="render-error">' + esc(t('render.tikzMissing')) + '</div>';
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
    else w += '<div class="render-error">' + esc(t('render.diagramError', { msg: (res.warnings || []).join('; ') })) + '</div>';
    w += '</div>';
    ctx.diagrams.push({ id: did, svg: res.svg, nodes: res.nodes, tikzsetRanges: ctx.tikzsetRanges, warnings: res.warnings || [] });
    return w;
  } catch (e) {
    ctx.warn(t('render.tikzError', { msg: e.message || e }), absInnerStart, 'tikz');
    return '<div class="render-error">' + esc(t('render.tikzError', { msg: String(e.message || e) })) + '</div>';
  }
}

// ---------------- TOC ----------------
function buildToc(ctx) {
  if (!ctx.headings.length) return '';
  var out = '<nav class="toc"><h4>' + esc(t('render.contents')) + '</h4><ul>';
  ctx.headings.forEach(function (h) {
    out += '<li class="toc-l' + h.level + '"><a href="#' + h.id + '">' + (h.num ? h.num + '&nbsp;&nbsp;' : '') + esc(h.text) + '</a></li>';
  });
  return out + '</ul></nav>';
}



export { renderLatex };

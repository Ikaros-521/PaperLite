/* PaperLite · PDF ⇄ 源码 近似定位（synctex-lite，纯逻辑，Node 可单测）
 *
 * 为什么不是真 synctex：内置管线的 XeTeX / dvipdfmx wasm（SwiftLaTeX 构建）把 synctex
 * 与命名目标输出整体裁掉了——实测连 hyperref 的 pdf:dest/GoTo special 都不落盘
 * （见 README 已知限制）。这里改用「文本坐标匹配」：编译产物的文本内容用 pdf.js
 * 抽取（每页一组带坐标的字符串），源码侧取光标所在段落的正文，两边都用同一套
 * 归一化（去连字/去连字符断词/去空白与标点）后做子串匹配：
 *   正向（编辑器 Ctrl+点击）→ 段落文本在 PDF 页索引里找位置 → 滚动+闪烁
 *   反向（PDF 双击文本）→ 文本片段在源码行里找归属 → 打开/跳转到该行
 * 匹配是近似的：断行、连字符、数学环境都会降低命中率，找不到就安静失败。 */

// 归一化对照：连字/弯引号/各类破折号 → 基本字符，避免渲染端与源码端字形差异
import { stripTexComments } from './texComments.js';

const UNIFY = [[/\uFB00/g, 'ff'], [/\uFB01/g, 'fi'], [/\uFB02/g, 'fl'], [/\uFB03/g, 'ffi'], [/\uFB04/g, 'ffl'],
  [/[\u2018\u2019\u201A\u201B]/g, "'"], [/[\u201C\u201D\u201E]/g, '"'],
  [/[\u2013\u2014\u2212]/g, '-'], [/\u00AD/g, '']];

/** 两端共用的匹配键：小写 → 统一连字/引号/破折号 → 只留字母数字（去空白/标点/连字符）。
 *  去掉连字符与空白后，PDF 的断行与 hyphenation 不再影响子串匹配；CJK 属于 \p{L} 原样保留。 */
export function matchKey(s) {
  let t = String(s || '').toLowerCase();
  for (const [re, to] of UNIFY) t = t.replace(re, to);
  t = t.replace(/[^0-9a-z\u00c0-\u024f\u0400-\u04ff\u3000-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, '');
  return t;
}

/** 源码查询预处理：去注释、去 TeX 命令名/花括号/数学定界符，只留要排版的正文字词 */
export function stripTexCommands(text) {
  return stripTexComments(text)
    .replace(/\\begin\s*\{[^}]*\}|\\end\s*\{[^}]*\}/g, ' ')
    .replace(/\\[a-zA-Z@]+\*?/g, ' ')
    .replace(/[$&#^_~]/g, ' ')
    .replace(/[{}]/g, ' ');
}

/** 光标所在段落的正文（往前/往后找空行边界），供正向跳转当查询词 */
export function paragraphHeadAtLine(source, lineIndex, maxChars = 200) {
  const lines = String(source || '').split(/\r?\n/);
  const lo = Math.max(0, Math.min(lineIndex, lines.length - 1));
  let start = lo, end = lo;
  while (start > 0 && lines[start - 1].trim() !== '') start--;
  while (end < lines.length - 1 && lines[end + 1].trim() !== '') end++;
  const text = lines.slice(start, end + 1).join(' ').slice(0, maxChars);
  return { text, startLine: start, endLine: end };
}

/** 一页的文本索引：items=[{str,x,y,w,h}]（pdf.js getTextContent，scale=1 的 PDF 坐标）。
 *  返回 {key, ofKey}：key 是整页匹配键；ofKey[i] = 键第 i 个字符来自哪个 item，
 *  命中后据此把键内偏移映射回带坐标的 item。 */
export function buildPageIndex(items, page) {
  const parts = [], ofKey = [];
  for (let i = 0; i < (items || []).length; i++) {
    const s = String((items[i] && items[i].str) || '');
    if (!s) continue;
    const k = matchKey(s);
    for (let j = 0; j < k.length; j++) { parts.push(k[j]); ofKey.push(i); }
  }
  return { page, key: parts.join(''), ofKey, items: items || [] };
}

/** 在页索引里找查询词：从长到短逐级回退（段落被环境打断时仍能命中头部）。
 *  返回 {page, x, y, len}（命中 item 的中心，PDF 坐标，y 向上）或 null。 */
export function findInPageIndex(index, query) {
  const full = matchKey(query);
  if (!index || index.key.length < 4) return null;
  for (const len of [full.length, 120, 80, 50, 30]) {
    if (len < 4 || len > full.length) continue;
    const q = full.slice(0, len);
    const at = index.key.indexOf(q);
    if (at >= 0) {
      const itemNo = index.ofKey[at];
      const it = index.items ? index.items[itemNo] : null;
      return { page: index.page, len, itemIndex: itemNo, ...(it ? { x: it.x + it.w / 2, y: it.y } : {}) };
    }
  }
  return null;
}

/** 反向定位：PDF 文本片段（双击选中的 span 文字）在源码里找归属行。
 *  也是逐级回退；行级粒度，返回 0 基行号或 null。 */
export function locateLineInSource(source, pdfText) {
  const key = matchKey(stripTexCommands(pdfText));
  if (key.length < 4) return null;
  const lines = String(source || '').split(/\r?\n/);
  const lineKeys = lines.map(l => matchKey(stripTexCommands(l)));
  // 相邻行拼接预计算一次：逐查询逐行拼接是 O(n²) 的临时串分配，多档回退查询共用
  const adjacent = new Array(Math.max(0, lineKeys.length - 1));
  for (let i = 0; i < adjacent.length; i++) adjacent[i] = lineKeys[i] + lineKeys[i + 1];
  const tryFind = q => {
    if (q.length < 4) return -1;
    for (let i = 0; i < lineKeys.length; i++) if (lineKeys[i].includes(q)) return i;
    // 行内找不到就拼相邻行（PDF 一行常跨源码两行，如段落折行/表格单元格）
    for (let i = 0; i < adjacent.length; i++) if (adjacent[i].includes(q)) return i;
    return -1;
  };
  for (const len of [key.length, 40, 24, 16, 10]) {
    if (len > key.length) continue;
    const hit = tryFind(key.slice(0, len));
    if (hit >= 0) return hit;
  }
  return null;
}

/** 顺序扫多页：优先从当前页开始（正向跳转通常落在可视页附近），找不到再从头扫 */
export function findTextInDoc(indexes, query, fromPage = 1) {
  const list = indexes || [];
  const ordered = [...list].sort((a, b) => Math.abs(a.page - fromPage) - Math.abs(b.page - fromPage));
  for (const idx of ordered) {
    const hit = findInPageIndex(idx, query);
    if (hit) return hit;
  }
  return null;
}

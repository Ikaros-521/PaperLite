/* PaperLite · LanguageTool 语法检查（纯逻辑，Node 可单测）
 *
 * 复用 spellcheck 的「等长遮罩」：把注释/数学/命令等非正文区域换成空格，
 * 只把自然语言送去 languagetool.org 公共接口；遮罩等长，返回的偏移可以
 * 直接映射回源码行列。长文按空行切块（公共接口对单次请求长度有限制），
 * 每轮最多 N 块，超出部分下轮再说。网络请求在 EditorPane 里。
 */
import { maskNonProse } from './spellcheck.js';

export const LT_ENDPOINT = 'https://api.languagetool.org/v2/check';
export const CHUNK_MAX = 8000;   // 单块字符上限（留足公共接口余量）
export const CHUNKS_PER_RUN = 3; // 每轮最多请求块数：限流友好，超长文只查最前面

/** 按空行边界把遮罩文本切块；返回 [{text, offset}]，单块不超过 maxLen */
export function splitChunks(masked, maxLen = CHUNK_MAX, maxChunks = 0) {
  const s = String(masked || '');
  const out = [];
  let start = 0;
  while (start < s.length) {
    if (s.length - start <= maxLen) { out.push({ text: s.slice(start), offset: start }); break; }
    // 在 [start+maxLen*0.5, start+maxLen] 里找最后一个空行，找不到就找最后一个换行
    let cut = -1;
    const lo = start + Math.floor(maxLen / 2), hi = start + maxLen;
    for (let k = hi; k >= lo; k--) {
      if (s.slice(k, k + 2) === '\n\n' || (s[k] === '\n' && s[k - 1] === '\n')) { cut = k + 1; break; }
    }
    if (cut < 0) for (let k = hi; k >= lo; k--) { if (s[k] === '\n') { cut = k + 1; break; } }
    if (cut <= start) cut = start + maxLen;
    out.push({ text: s.slice(start, cut), offset: start });
    start = cut;
    if (maxChunks && out.length >= maxChunks) break;
  }
  return out;
}

/** POST 表单：language=auto 让 LT 自己判断（中英混排按主要语言算） */
export function buildRequestBody(text) {
  return new URLSearchParams({ text: String(text || ''), language: 'auto', enabledOnly: 'false' }).toString();
}

/** 偏移 → 行/列（0 起）。masked 与源码等长，行列可直接用于 markText */
export function posOf(masked, index) {
  const s = String(masked || '');
  let line = 0, lineStart = 0;
  const target = Math.max(0, Math.min(index, s.length));
  for (let k = 0; k < target; k++) {
    if (s[k] === '\n') { line++; lineStart = k + 1; }
  }
  return { line, ch: target - lineStart };
}

/**
 * LT 响应 → 编辑器标记。
 * @param json LT /v2/check 响应
 * @param masked 整篇遮罩文本（算行列用）
 * @param chunkOffset 本块在整篇中的起始偏移
 * @returns [{line, from, to, msg, replacements[]}]
 */
export function parseMatches(json, masked, chunkOffset = 0) {
  const matches = (json && Array.isArray(json.matches)) ? json.matches : [];
  const out = [];
  for (const m of matches) {
    if (!m || typeof m.offset !== 'number') continue;
    const start = posOf(masked, chunkOffset + m.offset);
    const end = posOf(masked, chunkOffset + m.offset + Math.max(0, m.length | 0));
    // 命中区域整体落在遮罩里（非正文）就丢弃：LT 偶尔会把残缺片段误报
    const slice = String(masked || '').slice(chunkOffset + m.offset, chunkOffset + m.offset + Math.max(0, m.length | 0));
    if (!slice.trim()) continue;
    const replacements = (m.replacements || []).map(r => r.value).filter(v => v != null).slice(0, 3);
    out.push({
      line: start.line, from: start.ch, endLine: end.line, to: end.ch,
      msg: [m.shortMessage || m.rule && m.rule.description || '', m.message].filter(Boolean).join('：'),
      replacements,
    });
  }
  return out;
}

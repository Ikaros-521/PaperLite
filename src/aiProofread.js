/* PaperLite · AI 用词检测（纯逻辑，Node 可单测）
 *
 * LanguageTool 公共接口查不出搭配/可数性一类用词问题（如指单个文档时
 * documentation 应为 document——那是 LT Premium 规则），这一层把遮罩后的
 * 正文交给用户已配置的 LLM 渠道校对。模型不返回偏移（数不准），改为要求
 * 逐字引用原文片段（quote），前端在等长遮罩文本里 indexOf 回定位，找不到
 * 视为幻觉丢弃。与 grammar.js 的 parseMatches 输出同构，EditorPane 共用
 * markText 渲染路径。
 */
import { t } from './i18n.js';
import { splitChunks, posOf } from './grammar.js';

export const AI_CHUNK_MAX = 10000;  // 单块字符上限：一次请求的正文规模
export const AI_MAX_ITEMS = 12;     // 每块最多接受的问题条数（提示词同值）

/** 组装校对对话消息；quote 逐字引用是定位机制，必须在提示词里钉死 */
export function buildProofMessages(text) {
  return [
    { role: 'system', content: t('ai.proofSystem') },
    { role: 'user', content: t('ai.proofUser', { text: String(text || '') }) }
  ];
}

/** 从模型输出里剥出 JSON 数组：容忍 ``` 围栏与前后杂文；解析失败返回 null */
export function extractJSON(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const lo = s.indexOf('[');
  const hi = s.lastIndexOf(']');
  if (lo < 0 || hi <= lo) return null;
  try { return JSON.parse(s.slice(lo, hi + 1)); } catch (e) { return null; }
}

/**
 * 模型输出 → 编辑器标记（与 grammar.parseMatches 同构）。
 * @param raw 模型输出（JSON 数组文本）
 * @param masked 整篇遮罩文本（等长，算行列用）
 * @param chunkOffset 本块在整篇中的起始偏移
 * @returns [{line, from, endLine, to, msg, replacements[]}]
 */
export function parseAIResult(raw, masked, chunkOffset = 0) {
  const arr = extractJSON(raw);
  if (!Array.isArray(arr)) return [];
  const m = String(masked || '');
  const out = [];
  const taken = [];   // 已接受区间 [start, end)，重叠的丢弃
  for (const item of arr) {
    if (out.length >= AI_MAX_ITEMS) break;
    if (!item || typeof item !== 'object') continue;
    const quote = String(item.quote || '').trim();
    // 长度夹在 2–80：太短必误命中，太长模型多半在改写而非引用
    if (quote.length < 2 || quote.length > 80) continue;
    const idx = m.indexOf(quote, chunkOffset);
    if (idx < 0) continue;   // 幻觉：原文（遮罩后）里找不到，丢弃
    const end = idx + quote.length;
    if (taken.some(([a, b]) => idx < b && end > a)) continue; // 与已接受区间重叠
    const start = posOf(m, idx);
    const stop = posOf(m, end);
    const msg = String(item.message || '').trim().slice(0, 200);
    if (!msg) continue;
    const replacements = (Array.isArray(item.suggestions) ? item.suggestions : [])
      .map(v => String(v || '').trim()).filter(Boolean).slice(0, 3);
    taken.push([idx, end]);
    out.push({ line: start.line, from: start.ch, endLine: stop.line, to: stop.ch, msg, replacements });
  }
  return out;
}

/** 整篇遮罩文本分块（块更大、供 LLM 单请求消化）；游标轮转由 EditorPane 持有 */
export function proofChunks(masked) {
  return splitChunks(masked, AI_CHUNK_MAX, 0);
}

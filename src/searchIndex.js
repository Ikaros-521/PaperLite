/* PaperLite · 全局项目搜索（纯逻辑，Node 可单测）
 *
 * 跨所有打开的标签与文件夹扫描结果做 grep：正则/整词/大小写与编辑器内查找
 * 共用同一套模式构造（findModel.buildPattern），行为一致。
 * 文件清单由调用方装配（打开标签的实时内容优先于磁盘扫描）；
 * 这里只负责匹配、行列定位、限量与分组统计。
 */
import { buildPattern } from './findModel.js';

/**
 * 装配搜索文件清单：打开的标签（实时内容）在前，磁盘扫描文件按 path 去重补齐。
 * @param tabs   [{path, name, text}]（调用方把 live 值放进 text）
 * @param disk   [{path, text}]（文件夹扫描结果）
 * @returns [{path, text, open}]
 */
export function collectSearchFiles(tabs, disk) {
  const out = [];
  const seen = new Set();
  for (const tb of tabs || []) {
    const path = tb && tb.path;
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, text: String(tb.text || ''), open: true });
  }
  for (const f of disk || []) {
    if (!f || !f.path || seen.has(f.path)) continue;  // 已打开的标签用编辑中的内容
    seen.add(f.path);
    out.push({ path: f.path, text: String(f.text || ''), open: false });
  }
  return out;
}

/**
 * 在文件清单里搜索。
 * @returns {ok, error?, matches: [{path, line, text, from, to}], fileCount, truncated}
 *   line 为 0 起；from/to 是行内命中区间（高亮用）。超过 maxTotal 截断。
 */
export function searchInFiles(files, { query, regex = false, matchCase = false, wholeWord = false, maxPerFile = 50, maxTotal = 500 }) {
  const q = String(query || '');
  if (!q) return { ok: true, matches: [], fileCount: 0, truncated: false };
  const built = buildPattern(q, { regex, wholeWord, matchCase });
  if (!built.pattern) return { ok: false, error: 'invalid', matches: [], fileCount: 0, truncated: false };
  const re = new RegExp(built.pattern.source, built.pattern.flags.includes('g') ? built.pattern.flags : built.pattern.flags + 'g');

  const matches = [];
  let truncated = false;
  const filesWithHit = new Set();
  for (const file of files || []) {
    const text = String(file.text || '');
    if (!text) continue;
    const lines = text.split('\n');
    let hits = 0;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        if (hits === 0) filesWithHit.add(file.path);
        matches.push({ path: file.path, line: li, text: line.length > 300 ? line.slice(0, 300) : line, from: m.index, to: m.index + m[0].length });
        hits++;
        if (m[0] === '') re.lastIndex++;   // 零宽匹配防死循环
        if (hits >= maxPerFile || matches.length >= maxTotal) break;
      }
      if (hits >= maxPerFile || matches.length >= maxTotal) break;
    }
    if (matches.length >= maxTotal) { truncated = true; break; }
  }
  return { ok: true, matches, fileCount: filesWithHit.size, truncated };
}

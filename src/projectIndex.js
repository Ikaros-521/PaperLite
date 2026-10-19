/* 光标前同行文本 → 补全上下文；不在 \ref/\cite 键位则 null。
 * segment = 最后一个 { 内、最后一个逗号之后的键片段（\cite{a,b|} 补 b 且不吞 a） */
import { stripTexComments } from './texComments.js';
const REF_CITE_RE = /\\(eqref|autoref|labelcref|crefrange|pageref|ref|Citealp|Citeauthor|Citeyear|Citep|Citet|Cite|citealp|citeauthor|citeyear|parencite|Parencite|textcite|Textcite|citep|citet|cite|cref|Cref)(\*)?(?:\[[^\]]*\])*\{([^}]*)$/;
export function matchRefContext(before) {
  const m = String(before || '').match(REF_CITE_RE);
  if (!m) return null;
  const body = m[3];
  const comma = body.lastIndexOf(',');
  return { cmd: m[1], isCite: m[1].indexOf('cite') >= 0, segment: comma >= 0 ? body.slice(comma + 1) : body };
}

// 与 lint/预览同一套奇偶反斜杠口径（texComments）。这里必须等长替换：
// pos 是按剥离后的字符串算的，删掉字符会让偏移整体前移，跳转就落到别的行
function stripComments(text) {
  return stripTexComments(text, { keepLength: true });
}

// collectLabels: [{ key, pos, line }] —— pos/line 用于后续展示来源（暂无 UI，先算出来备着）
export function collectLabels(text) {
  const src = stripComments(text);
  const out = [];
  const re = /\\label\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(src))) {
    if (!m[1].trim()) continue;
    // exec 结果只有 .index，没有 .start —— 写错时 pos 一直是 undefined，跳转拿不到落点
    out.push({ key: m[1].trim(), pos: m.index });
  }
  return out;
}

// collectBibKeys: 解析 .bib 条目 @type{key, …}，key 到第一个逗号/空白为止
export function collectBibKeys(text) {
  const src = stripComments(text);
  const out = [];
  const re = /@\w+\s*\{\s*([^,}\s]+)/g;
  let m;
  while ((m = re.exec(src))) {
    if (!m[1].trim()) continue;
    out.push({ key: m[1].trim(), pos: m.index });
  }
  return out;
}

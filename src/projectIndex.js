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
// 手写 indexOf 游标而不是 /\\label\{([^}]+)\}/g：坏文件里几千个没有 } 的 \label{ 会让
// 正则从每个起点把 [^}]+ 重试到文末，180KB 实测 1.17s、360KB 4.66s（二次方），
// 而补全每敲一下就对所有打开标签调它 —— 一份别人写的 .tex 就能把打字冻住。
const LABEL_NEEDLE = '\\label{';
export function collectLabels(text) {
  const src = stripComments(text);
  const out = [];
  for (let p = src.indexOf(LABEL_NEEDLE); p >= 0; p = src.indexOf(LABEL_NEEDLE, p + LABEL_NEEDLE.length)) {
    const start = p + LABEL_NEEDLE.length;
    const end = src.indexOf('}', start);
    if (end < 0) break;                     // 后面已经没有 } 了，再往前的 \label 同样闭不上
    const key = src.slice(start, end);
    if (key.trim()) out.push({ key: key.trim(), pos: p });
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

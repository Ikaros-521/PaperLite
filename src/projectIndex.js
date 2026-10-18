/* 光标前同行文本 → 补全上下文；不在 \ref/\cite 键位则 null。
 * segment = 最后一个 { 内、最后一个逗号之后的键片段（\cite{a,b|} 补 b 且不吞 a） */
const REF_CITE_RE = /\\(eqref|autoref|labelcref|crefrange|pageref|ref|Citealp|Citeauthor|Citeyear|Citep|Citet|Cite|citealp|citeauthor|citeyear|parencite|Parencite|textcite|Textcite|citep|citet|cite|cref|Cref)(\*)?(?:\[[^\]]*\])*\{([^}]*)$/;
export function matchRefContext(before) {
  const m = String(before || '').match(REF_CITE_RE);
  if (!m) return null;
  const body = m[3];
  const comma = body.lastIndexOf(',');
  return { cmd: m[1], isCite: m[1].indexOf('cite') >= 0, segment: comma >= 0 ? body.slice(comma + 1) : body };
}

// 与 lint/QuickTools 同款去注释：只擦未转义的 %，保住其余文本的相对偏移
function stripComments(text) {
  return text.replace(/(?<!\\)%[^\n]*/g, '');
}

// collectLabels: [{ key, pos, line }] —— pos/line 用于后续展示来源（暂无 UI，先算出来备着）
export function collectLabels(text) {
  const src = stripComments(text);
  const out = [];
  const re = /\\label\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(src))) {
    if (!m[1].trim()) continue;
    out.push({ key: m[1].trim(), pos: m.start });
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
    out.push({ key: m[1].trim(), pos: m.start });
  }
  return out;
}

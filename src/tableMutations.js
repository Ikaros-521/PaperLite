/* PaperLite · 表格可视化编辑写回（纯逻辑，Node 可单测）
 *
 * 排版引擎（latex.js renderTabular）在渲染时记录了每个单元格/行/列格式的
 * 源码绝对区间；这里按区间把面板编辑精确写回。所有操作都是「单点替换」，
 * 列级操作逐行倒序应用（倒序保证前面的区间不被后面的替换位移）。
 * 区间来自最近一次渲染，写回后预览会重渲、区间刷新——面板每次都读新值。
 */

/** 单元格文本转义：& % # _ 只转义未被转义的（保留用户手写的 \& 等）
 * 逐字扫并数反斜杠奇偶，和 texComments 同一口径。原先用
 * /(^|[^\\])([&%#_])/g 一次替换，它会吃掉前一个字符，导致相邻两个特殊字符的
 * 第二个被跳过：'&&' 得到 '\&&'，写回 .tex 后那个裸 & 凭空多出一列。 */
export function escapeCellText(text) {
  const s = String(text == null ? '' : text);
  let out = '', bs = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === '\\') { out += c; bs++; continue; }
    if ((c === '&' || c === '%' || c === '#' || c === '_') && bs % 2 === 0) out += '\\';
    out += c;
    bs = 0;
  }
  return out;
}

function replaceRange(src, start, end, text) {
  return src.slice(0, start) + text + src.slice(end);
}

/** 编辑单元格：替换该单元格的源码区间（保留周围空白与 multicolumn 包装外的结构） */
export function applyCellEdit(src, cell, newText) {
  if (!cell || cell.start < 0) return src;
  return replaceRange(src, cell.start, cell.end, escapeCellText(newText).trim());
}

/** 删除行：行内容 + 其后的 \\；下一行的规则线（\midrule 等）原样保留 */
export function applyRowDelete(src, row) {
  if (!row || row.contentStart < 0) return src;
  return replaceRange(src, row.contentStart, row.nextStart != null ? row.nextStart : row.contentEnd, '');
}

/** 在某行之后插入空行：单元格数与该行一致（面板按列数生成时传 colCount） */
export function applyRowInsertAfter(src, row, colCount, placeholder) {
  if (!row) return src;
  const ph = placeholder == null ? '' : placeholder;
  const cells = Array.from({ length: Math.max(1, colCount || 1) }, () => ph).join(' & ');
  if (row.hasFollowingRow) {
    // 该行后面还有原始行（说明它带 \\）：插「新行 + \\」，规则线仍归下一行。
    // nextStart 可能正落在换行符上（换行归下一行的原始文本）：挪到换行后；
    // 落在行中间（\\[间距] 等情况）则给插入文本补个换行，避免粘进上一行
    let at = row.nextStart;
    let text = cells + ' \\\\\n';
    if (src.charAt(at) === '\n') at += 1;
    else if (at > 0 && src.charAt(at - 1) !== '\n') text = '\n' + text;
    return replaceRange(src, at, at, text);
  }
  // 末行（可能没有 \\）：先给它补 \\，再接新行
  return replaceRange(src, row.contentEnd, row.contentEnd, ' \\\\\n' + cells);
}

/** 删除某列：逐行倒序删除该列单元格 + 左侧分隔符（首列删右侧分隔符） */
export function applyColDelete(src, table, ci) {
  if (!table) return src;
  let out = src;
  for (let ri = table.rows.length - 1; ri >= 0; ri--) {
    const row = table.rows[ri];
    const cells = row.cells;
    if (!cells.length || ci >= cells.length) continue;
    const cell = cells[ci];
    let from = cell.start, to = cell.end;
    if (ci > 0) {
      from = Math.min(cells[ci - 1].end, cell.start);   // 左分隔符（含空白）一起删
    } else if (cells.length > 1) {
      to = cells[1].start;        // 首列：连右侧分隔符一起删
    }
    if (from < to) out = replaceRange(out, from, to, '');
  }
  return out;
}

/** 在某列之后插入空列：逐行倒序在 cells[ci] 区间末尾插「空 &」 */
export function applyColInsertAfter(src, table, ci, placeholder) {
  if (!table) return src;
  const ph = placeholder == null ? '' : placeholder;
  let out = src;
  for (let ri = table.rows.length - 1; ri >= 0; ri--) {
    const cells = table.rows[ri].cells;
    if (!cells.length) continue;
    const idx = Math.min(ci, cells.length - 1);
    const at = cells[idx].end;
    const add = idx === cells.length - 1 ? ' & ' + ph : ' ' + ph + ' &';
    out = replaceRange(out, at, at, add);
  }
  return out;
}

/** 修改列格式（colspec 内容区间整体替换） */
export function applyColspecEdit(src, table, spec) {
  if (!table || table.colspecStart == null || table.colspecStart < 0) return src;
  const clean = String(spec || '').trim() || 'c';
  return replaceRange(src, table.colspecStart, table.colspecEnd, clean);
}

/* 表格可视化编辑测试：真实渲染提取区间（renderLatex.tables）+ 写回纯逻辑 */
import { renderLatex } from '../src/engines/latex.js';
import {
  escapeCellText, applyCellEdit, applyRowDelete, applyRowInsertAfter,
  applyColDelete, applyColInsertAfter, applyColspecEdit,
} from '../src/tableMutations.js';
import { DICT } from '../src/i18n.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.error('  ✗ FAIL:', msg); }
}

const SRC = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\begin{tabular}{lll}',
  '\\toprule',
  '姓名 & 科目 & 成绩 \\\\',
  '\\midrule',
  '张三 & 数学 & 95 \\\\',
  '李四 & 数学 & 88 \\\\',
  '\\bottomrule',
  '\\end{tabular}',
  '\\end{document}',
].join('\n');

const res = renderLatex(SRC);

console.log('== 引擎记录表格元数据 ==');
ok(res.tables.length === 1, '识别到 1 张表：' + res.tables.length);
const tbl = res.tables[0];
ok(tbl.rows.length === 3, '3 个内容行：' + tbl.rows.length);
ok(tbl.cols === 3 || tbl.colspec === 'lll', '列格式 lll');
ok(SRC.slice(tbl.colspecStart, tbl.colspecEnd) === 'lll', 'colspec 区间命中');
ok(tbl.rows.every(r => r.cells.length === 3), '每行 3 个单元格');
// 单元格区间与原文一一对应
ok(SRC.slice(tbl.rows[0].cells[0].start, tbl.rows[0].cells[0].end) === '姓名', '首格区间=姓名');
ok(SRC.slice(tbl.rows[1].cells[2].start, tbl.rows[1].cells[2].end) === '95', '(1,2) 区间=95');
ok(SRC.slice(tbl.rows[2].cells[1].start, tbl.rows[2].cells[1].end) === '数学', '(2,1) 区间=数学');
// 环境区间
ok(SRC.slice(tbl.envStart, tbl.envStart + 7) === '\\begin{', 'envStart 指向 \\begin');
ok(SRC.slice(tbl.envEnd - 9, tbl.envEnd) === '{tabular}', 'envEnd 覆盖 \\end{tabular}');
ok(res.html.includes('data-tid="0"'), '表格 HTML 带 data-tid');

console.log('== escapeCellText ==');
ok(escapeCellText('A & B') === 'A \\& B', '& 转义');
ok(escapeCellText('100%') === '100\\%', '% 转义');
ok(escapeCellText('a_b #c') === 'a\\_b \\#c', '_ # 转义');
ok(escapeCellText('已转义 \\& 保持') === '已转义 \\& 保持', '已转义不重复');
ok(escapeCellText('&首字符') === '\\&首字符', '首字符转义');
ok(escapeCellText('&&') === '\\&\\&', '连写两个 & 都要转义（旧正则只转第一个）');
ok(escapeCellText('A&B&&C') === 'A\\&B\\&\\&C', '相邻特殊字符逐个覆盖');
ok(escapeCellText('100% && 200%') === '100\\% \\&\\& 200\\%', '% 与 && 混排');

console.log('== 单元格编辑 ==');
let next = applyCellEdit(SRC, tbl.rows[1].cells[2], '99');
ok(next.includes('张三 & 数学 & 99 \\\\'), '改成绩 95→99');
ok(next.split('\n').length === SRC.split('\n').length, '行数不变');
next = applyCellEdit(SRC, tbl.rows[0].cells[0], 'Name & No.');
ok(next.includes('Name \\& No. & 科目'), '输入的 & 被转义');

console.log('== 行操作 ==');
next = applyRowDelete(SRC, tbl.rows[1]);   // 删「张三」行
ok(!next.includes('张三'), '行删除：张三行没了');
ok(next.includes('李四 & 数学 & 88'), '行删除：其他行保留');
ok(next.includes('\\midrule') && next.includes('\\bottomrule'), '行删除：规则线保留');
const last = tbl.rows[tbl.rows.length - 1];
ok(tbl.rows[1].hasFollowingRow === true, '中间行标记 hasFollowingRow');
next = applyRowDelete(SRC, last);          // 删末行「李四」
ok(!next.includes('李四') && next.includes('\\bottomrule'), '末行删除：bottomrule 保留');

next = applyRowInsertAfter(SRC, tbl.rows[1], 3);   // 张三行后插空行
const zhangLine = next.split('\n').find(l => l.includes('张三'));
const insertedAt = next.split('\n').indexOf(zhangLine);
ok(/^\s*&\s*&\s*\\+$/.test(next.split('\n')[insertedAt + 1]), '行插入：下一行是空单元格行：' + JSON.stringify(next.split('\n')[insertedAt + 1]));
ok(next.includes('李四'), '行插入：后续行不受影响');
next = applyRowInsertAfter(SRC, last, 3);          // 末行后插
const liIdx = next.split('\n').findIndex(l => l.includes('李四'));
ok(/^\s*&\s*&\s*\\+$/.test(next.split('\n')[liIdx + 1]) && next.includes('\\bottomrule'), '末行后插入：bottomrule 仍在');

console.log('== 列操作 ==');
next = applyColInsertAfter(SRC, tbl, 2);   // 末列后加一列
ok(next.includes('姓名 & 科目 & 成绩 &  \\\\'), '加列：表头行追加空列：' + next.split('\n')[4]);
ok(next.includes('张三 & 数学 & 95 &  \\\\'), '加列：数据行追加空列');
next = applyColInsertAfter(SRC, tbl, 0);   // 首列后加
ok(/张三\s*&\s*&\s*数学\s*&\s*95/.test(next), '首列后插入：' + next.split('\n').find(l => l.includes('张三')).slice(0, 30));
next = applyColDelete(SRC, tbl, 2);        // 删末列
ok(next.includes('姓名 & 科目 \\\\'), '删末列：表头变两列');
ok(next.includes('李四 & 数学 \\\\'), '删末列：数据行变两列');
next = applyColDelete(SRC, tbl, 0);        // 删首列
ok(next.includes('科目 & 成绩'), '删首列：保留后两列');
ok(!next.includes('张三 & 数学'), '删首列：张三的名字没了但行还在：' + next.split('\n')[6]);

console.log('== colspec ==');
next = applyColspecEdit(SRC, tbl, '|l|c|r|');
ok(next.includes('\\begin{tabular}{|l|c|r|}'), 'colspec 替换');
next = applyColspecEdit(SRC, tbl, '  ');
ok(next.includes('\\begin{tabular}{c}'), '空 colspec 回退 c');

console.log('== 链式：编辑后再提取（写回-重渲循环） ==');
const step1 = applyCellEdit(SRC, tbl.rows[1].cells[2], '100');
const res2 = renderLatex(step1);
ok(res2.tables.length === 1 && res2.tables[0].rows.length === 3, '重渲仍识别为 3 行');
ok(step1.slice(res2.tables[0].rows[1].cells[2].start, res2.tables[0].rows[1].cells[2].end) === '100', '新区间命中新值');
const step2 = applyRowDelete(step1, res2.tables[0].rows[2]);
ok(!step2.includes('李四') && step2.includes('100'), '第二次操作用新区间成功');

console.log('== 新增文案双语完整 ==');
for (const key of ['tb.openTip', 'tb.title', 'tb.note', 'tb.cell', 'tb.addRow', 'tb.addRowAfter', 'tb.delRow', 'tb.addCol', 'tb.delLastCol', 'tb.delColConfirm', 'tb.colspec']) {
  ok(typeof DICT.en[key] === 'string' && DICT.en[key].length > 0, '英文文案存在: ' + key);
  ok(!/[\u4e00-\u9fff]/.test(DICT.en[key]), '英文无汉字: ' + key);
}

console.log('== 嵌套矩阵公式与 multicolumn 嵌套括号 ==');
const MATRIX_SRC = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\begin{tabular}{cc}',
  '$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$ & 标量 \\tabularnewline',
  '\\multicolumn{2}{|p{3cm}|}{长表头} \\\\',
  '1 & 2 \\\\',
  '\\end{tabular}',
  '\\end{document}',
].join('\n');
const matrixRes = renderLatex(MATRIX_SRC);
ok(matrixRes.tables.length === 1, '识别到矩阵表格');
const mTbl = matrixRes.tables[0];
ok(mTbl.rows.length === 3, '矩阵行内 \\\\ 与 \\tabularnewline 保持 3 行：' + mTbl.rows.length);
ok(mTbl.rows[0].cells.length === 2, '矩阵内 & 不把单元格切成多列：' + mTbl.rows[0].cells.length);
ok(mTbl.rows[0].cells[0].raw.includes('\\begin{pmatrix}'), '首格保留完整矩阵');
ok(!matrixRes.html.includes('math-error'), 'KaTeX 正常渲染矩阵公式');
ok(matrixRes.html.includes('colspan="2"'), '嵌套括号 p{3cm} 成功提取 colspan=2');
ok(matrixRes.html.includes('长表头'), 'multicolumn 内部文本正常渲染');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

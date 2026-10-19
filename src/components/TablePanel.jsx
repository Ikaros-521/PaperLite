import { useEffect, useMemo, useState } from 'react';
import { useT } from '../useI18n.js';
import {
  applyCellEdit, applyRowDelete, applyRowInsertAfter, applyColDelete, applyColInsertAfter, applyColspecEdit,
} from '../tableMutations.js';

/* 表格可视化编辑面板：预览里的表格点「✎」打开。
 *
 * 每个输入框显示单元格的源码原文（\multicolumn 等包装也照实显示），失焦/回车才写回——
 * 逐键写回会让引擎记录的区间随每次按键失效。所有操作统一走同一个模式：
 * 纯函数算出整篇新源码 → 最小差异区间一次 replaceRange（保住撤销历史的粒度），
 * 写回后预览重渲、区间刷新，面板从新渲染结果重取。 */
export default function TablePanel({ open, onClose, result, cm, selection }) {
  const t = useT();
  const table = useMemo(
    () => (result && result.tables && selection && selection.sel && selection.sel.type === 'table'
      ? (result.tables.filter(x => x.id === selection.sel.id)[0] || null) : null),
    [result, selection]
  );
  // 草稿按 r:c 存：编辑中的单元格先落草稿；换表/写回后清空
  const [drafts, setDrafts] = useState({});
  const [specDraft, setSpecDraft] = useState(null);
  useEffect(() => { setSpecDraft(null); setDrafts({}); }, [table && table.id]);

  const apply = (nextSource) => {
    if (!cm || nextSource == null) return;
    const prev = cm.getValue();
    if (nextSource === prev) return;
    // 区间来自上次渲染：渲染基于的源码与当前不一致（编辑后尚未重渲完成）时
    // 偏移已错位，写回可能吃掉相邻单元格——拒绝并提示，等下一拍重渲后重试
    if (result.src != null && result.src !== prev) {
      setDrafts({}); setSpecDraft(null);
      window.alert(t('app.sourceChanged'));
      return;
    }
    let start = 0;
    while (start < prev.length && prev[start] === nextSource[start]) start++;
    let endP = prev.length, endN = nextSource.length;
    while (endP > start && endN > start && prev[endP - 1] === nextSource[endN - 1]) { endP--; endN--; }
    cm.replaceRange(nextSource.slice(start, endN), cm.posFromIndex(start), cm.posFromIndex(endP), '+table');
    cm.focus();
  };

  if (!open || !table) return null;
  const colCount = Math.max(table.cols || 0, ...table.rows.map(r => r.cells.length), 1);

  const commitCell = (r, c) => {
    const key = r + ':' + c;
    const draft = drafts[key];
    setDrafts(d => { const n = { ...d }; delete n[key]; return n; });
    const cell = table.rows[r] && table.rows[r].cells[c];
    if (draft == null || !cell || draft.trim() === cell.raw) return;
    apply(applyCellEdit(cm.getValue(), cell, draft));
  };

  const cellInput = (r, c) => {
    const key = r + ':' + c;
    const cell = table.rows[r].cells[c];
    return <input key={c} value={key in drafts ? drafts[key] : (cell ? cell.raw : '')}
      disabled={!cell} title={cell ? cell.raw : ''} spellCheck={false} aria-label={t('tb.cell', { r: r + 1, c: c + 1 })}
      onChange={e => setDrafts(d => ({ ...d, [key]: e.target.value }))}
      onBlur={() => commitCell(r, c)}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } if (e.key === 'Escape') { setDrafts(d => { const n = { ...d }; delete n[key]; return n; }); e.target.blur(); } }} />;
  };

  return <aside id="tablePanel" className="open" aria-label={t('tb.title')}>
    <div className="panel-h">
      <span>{t('tb.title')}</span>
      <span className="hint">{table.rows.length} × {colCount}</span>
      <button className="btn sm" aria-label={t('file.close')} onClick={onClose}>✕</button>
    </div>
    <div className="panel-body">
      <p className="hint">{t('tb.note')}</p>
      <div className="tb-rows">
        {table.rows.map((row, r) => (
          <div className="tb-row" key={r}>
            {Array.from({ length: colCount }, (_, c) => cellInput(r, c))}
            <span className="tb-rowops">
              <button className="btn sm" title={t('tb.addRowAfter')} aria-label={t('tb.addRowAfter')}
                onClick={() => apply(applyRowInsertAfter(cm.getValue(), row, colCount))}>＋</button>
              <button className="btn sm" title={t('tb.delRow')} aria-label={t('tb.delRow')}
                onClick={() => apply(applyRowDelete(cm.getValue(), row))}>✕</button>
            </span>
          </div>
        ))}
      </div>
      <div className="tb-actions">
        <button className="btn sm" disabled={!table.rows.length}
          onClick={() => apply(applyRowInsertAfter(cm.getValue(), table.rows[table.rows.length - 1], colCount))}>{t('tb.addRow')}</button>
        <button className="btn sm" onClick={() => apply(applyColInsertAfter(cm.getValue(), table, colCount - 1))}>{t('tb.addCol')}</button>
        <button className="btn sm" disabled={colCount < 2}
          onClick={() => { if (window.confirm(t('tb.delColConfirm'))) apply(applyColDelete(cm.getValue(), table, colCount - 1)); }}>{t('tb.delLastCol')}</button>
      </div>
      <label className="tb-spec">
        {t('tb.colspec')}
        <input value={specDraft != null ? specDraft : table.colspec}
          onChange={e => setSpecDraft(e.target.value)}
          onBlur={() => {
            if (specDraft == null || specDraft.trim() === table.colspec) { setSpecDraft(null); return; }
            apply(applyColspecEdit(cm.getValue(), table, specDraft));
            setSpecDraft(null);
          }}
          onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }}
          spellCheck={false} />
      </label>
    </div>
  </aside>;
}

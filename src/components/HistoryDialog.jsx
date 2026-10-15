import { useEffect, useMemo, useRef, useState } from 'react';
import { compareVersions, inlineChanges } from '../historyDiff.js';
import { useLang, useT } from '../useI18n.js';

export default function HistoryDialog({ name, current, versions, onClose, onSnapshot, onRename, onRestore, error }) {
  const t = useT(), lang = useLang();
  const dialog = useRef(null), scroller = useRef(null);
  const [baseId, setBaseId] = useState((versions.find(v => v.text !== current) || versions[0])?.id || 'current');
  const [targetId, setTargetId] = useState('current');
  const [layout, setLayout] = useState('split');
  const [allLines, setAllLines] = useState(false);
  const [change, setChange] = useState(-1);
  const [label, setLabel] = useState('');
  const [renameLabel, setRenameLabel] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [restoreConfirm, setRestoreConfirm] = useState(false);
  const working = { id: 'current', text: current, label: t('hist.current') };
  const options = [working, ...versions];
  const base = options.find(v => v.id === baseId) || working;
  const target = options.find(v => v.id === targetId) || working;
  const diff = useMemo(() => compareVersions(base.text, target.text), [base.text, target.text]);
  const wordDiffs = useMemo(() => {
    if (diff.added + diff.removed > 500 || base.text.length + target.text.length > 100000) return new Map();
    return new Map(diff.rows.filter(row => row.changed).map(row => [row, inlineChanges(row.left, row.right)]));
  }, [diff, base.text, target.text]);
  const date = v => new Date(v.date).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US');
  const title = v => v.id === 'current' ? v.label : v.label || t('hist.' + (v.reason || 'auto'));
  const optionTitle = v => v.id === 'current' ? title(v) : `${title(v)} · ${date(v)}`;
  useEffect(() => { dialog.current.showModal(); }, []);
  useEffect(() => { setChange(-1); setRestoreConfirm(false); setRenaming(false); if (scroller.current) scroller.current.scrollTop = 0; }, [baseId, targetId, base.text, target.text]);
  const visible = useMemo(() => {
    if (allLines) return null;
    const result = new Set();
    diff.rows.forEach((row, index) => {
      if (row.changed) for (let j = Math.max(0, index - 3); j <= Math.min(diff.rows.length - 1, index + 3); j++) result.add(j);
    });
    return result;
  }, [diff, allLines]);
  const jump = direction => {
    const next = (change + direction + diff.changes.length) % diff.changes.length;
    setChange(next);
    scroller.current?.querySelector(`[data-row="${diff.changes[next]}"]`)?.scrollIntoView({ block: 'center' });
  };
  const text = (row, side) => {
    const value = row[side];
    if (value === undefined) return null;
    const parts = wordDiffs.get(row);
    return <>{parts ? parts.filter(p => side === 'left' ? !p.added : !p.removed).map((p, i) => <span key={i} className={p.added || p.removed ? 'diff-word' : undefined}>{p.value.replace(/\n$/, '')}</span>) : value.replace(/\n$/, '')}{!value.endsWith('\n') && <span className="diff-eof" title={t('hist.noNewline')}> ∅</span>}</>;
  };
  let hidden = false;
  return <dialog ref={dialog} className="modal history-dialog" aria-labelledby="history-title" onCancel={onClose}>
    <div className="modal-h"><span id="history-title">{t('m.history').replace('…', '')} <small>{name}</small></span><button className="btn sm" aria-label={t('file.close')} onClick={onClose}>✕</button></div>
    <div className="history-body">
      <aside className="history-sidebar">
        <form className="history-create" onSubmit={e => { e.preventDefault(); if (onSnapshot(label)) setLabel(''); }}>
          <label htmlFor="history-label">{t('hist.checkpoint')}</label>
          <input id="history-label" value={label} maxLength={100} placeholder={t('hist.labelPlaceholder')} onChange={e => setLabel(e.target.value)} />
          <button className="btn sm" type="submit">＋ {t('file.snapshot')}</button>
        </form>
        <nav className="history-timeline" aria-label={t('m.history')}>
          {options.map(v => <button key={v.id} className={'history-entry' + (base.id === v.id ? ' on' : '')} aria-pressed={base.id === v.id} onClick={() => setBaseId(v.id)}>
            <span className="history-dot" /><strong>{title(v)}</strong>
            <small>{v.date ? date(v) + (v.label ? ' · ' + t('hist.' + (v.reason || 'auto')) : '') : t('hist.live')}</small>
            {v.date && <code>{v.id.slice(-7)}</code>}
          </button>)}
        </nav>
        <p className="hint history-note">{t('file.historyNote')}</p>
      </aside>
      <section className="history-main" aria-label={t('hist.compare')}>
        <div className="history-compare">
          <label>{t('hist.base')}<select value={base.id} onChange={e => setBaseId(e.target.value)}>{options.map(v => <option key={v.id} value={v.id}>{optionTitle(v)}</option>)}</select></label>
          <button className="btn sm" title={t('hist.swap')} aria-label={t('hist.swap')} onClick={() => { setBaseId(target.id); setTargetId(base.id); }}>⇄</button>
          <label>{t('hist.target')}<select value={target.id} onChange={e => setTargetId(e.target.value)}>{options.map(v => <option key={v.id} value={v.id}>{optionTitle(v)}</option>)}</select></label>
        </div>
        <div className="history-tools">
          <span className="diff-added">+{diff.added}</span><span className="diff-removed">−{diff.removed}</span>
          <button className="btn sm" disabled={!diff.changes.length} onClick={() => jump(change < 0 ? 1 : -1)} aria-label={t('hist.prev')}>↑</button>
          <span className="hint">{change < 0 ? 0 : change + 1} / {diff.changes.length}</span>
          <button className="btn sm" disabled={!diff.changes.length} onClick={() => jump(1)} aria-label={t('hist.next')}>↓</button>
          <label className="history-context"><input type="checkbox" checked={allLines} onChange={e => setAllLines(e.target.checked)} />{t('hist.allLines')}</label>
          <div className="history-layout" role="group" aria-label={t('hist.layout')}>{['split', 'unified'].map(mode => <button key={mode} className="btn sm" aria-pressed={layout === mode} onClick={() => setLayout(mode)}>{t('hist.' + mode)}</button>)}</div>
        </div>
        <div ref={scroller} className="history-diff" tabIndex={0}>
          {!diff.changes.length && !allLines ? <div className="history-empty">✓ {t('hist.identical')}</div> : <table className={'diff-table ' + layout} aria-label={t('hist.compare')}>
            <colgroup>{layout === 'split' ? <><col style={{ width: 48 }} /><col /><col style={{ width: 48 }} /><col /></> : <><col style={{ width: 48 }} /><col style={{ width: 48 }} /><col style={{ width: 22 }} /><col /></>}</colgroup>
            <thead><tr>{layout === 'split' ? <><th colSpan={2}>{t('hist.base')} · {title(base)}</th><th colSpan={2}>{t('hist.target')} · {title(target)}</th></> : <th colSpan={4}>{t('hist.base')} → {t('hist.target')}</th>}</tr></thead>
            <tbody>{diff.rows.map((row, index) => {
              if (visible && !visible.has(index)) {
                if (hidden) return null;
                hidden = true;
                return <tr key={'gap-' + index}><td colSpan={4} className="diff-gap"><button onClick={() => setAllLines(true)}>{t('hist.expand')}</button></td></tr>;
              }
              hidden = false;
              const active = diff.changes[change] === index ? ' diff-active' : '';
              if (layout === 'split') return <tr key={index} data-row={index} className={active}>
                <td className={'diff-number' + (row.changed && row.left !== undefined ? ' diff-del' : '')}>{row.oldLine}</td><td className={row.changed ? row.left === undefined ? 'diff-blank' : 'diff-del' : ''}><pre>{text(row, 'left')}</pre></td>
                <td className={'diff-number' + (row.changed && row.right !== undefined ? ' diff-add' : '')}>{row.newLine}</td><td className={row.changed ? row.right === undefined ? 'diff-blank' : 'diff-add' : ''}><pre>{text(row, 'right')}</pre></td>
              </tr>;
              if (!row.changed) return <tr key={index}><td className="diff-number">{row.oldLine}</td><td className="diff-number">{row.newLine}</td><td className="diff-sign"> </td><td><pre>{text(row, 'right')}</pre></td></tr>;
              return <tr key={index} data-row={index} className={active}><td colSpan={4} className="diff-unified-pair">{['left', 'right'].filter(side => row[side] !== undefined).map(side => <div key={side} className={side === 'left' ? 'diff-del' : 'diff-add'}><span className="diff-number">{side === 'left' ? row.oldLine : ''}</span><span className="diff-number">{side === 'right' ? row.newLine : ''}</span><span className="diff-sign">{side === 'left' ? '−' : '+'}</span><pre>{text(row, side)}</pre></div>)}</td></tr>;
            })}</tbody>
          </table>}
        </div>
        <div className="history-footer">
          {error && <span className="diff-removed" role="alert">{error}</span>}
          {renaming ? <form onSubmit={e => { e.preventDefault(); if (onRename(base.id, renameLabel)) setRenaming(false); }}><input aria-label={t('hist.rename')} maxLength={100} value={renameLabel} onChange={e => setRenameLabel(e.target.value)} autoFocus /><button className="btn sm">{t('m.save')}</button><button type="button" className="btn sm" onClick={() => setRenaming(false)}>{t('hist.cancel')}</button></form> : <button className="btn sm" disabled={base.id === 'current'} onClick={() => { setRenameLabel(base.label || ''); setRenaming(true); }}>{t('hist.rename')}</button>}
          {restoreConfirm ? <div className="history-confirm"><span>{t('hist.confirm')}</span><button className="btn primary sm" onClick={() => { if (onRestore(base)) setRestoreConfirm(false); }}>{t('file.restore')}</button><button className="btn sm" onClick={() => setRestoreConfirm(false)}>{t('hist.cancel')}</button></div> : <button className="btn primary sm" disabled={base.id === 'current' || base.text === current} onClick={() => setRestoreConfirm(true)}>{t('hist.restoreBase')}</button>}
        </div>
      </section>
    </div>
  </dialog>;
}

import { useEffect, useRef } from 'react';
import { useT } from '../useI18n.js';
import { THEME_IDS } from '../theme.js';

export default function FileDialog({ mode, onClose, name, counts, selectionCounts, settings, onSettings, engines, engine, setEngine, onSource, onPdf, pdfAvailable, busy, theme, setTheme }) {
  const t = useT();
  const ref = useRef(null);
  useEffect(() => { ref.current.showModal(); }, []);
  const countTable = c => <dl className="file-counts">{['total', 'cjk', 'words', 'characters'].map(key => <div key={key}><dt>{t('file.' + key)}</dt><dd>{c[key]}</dd></div>)}</dl>;
  return <dialog ref={ref} className="modal file-dialog" aria-labelledby="file-dialog-title" onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) { const r = ref.current.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }}>
    <div className="modal-h"><span id="file-dialog-title">{t('m.' + mode)}</span><button className="btn sm" aria-label={t('file.close')} onClick={onClose}>✕</button></div>
    <div className="modal-body">
      <p className="file-doc-name">{name}</p>
      {mode === 'wordCount' && <><p className="hint">{t('file.countNote')}</p>{countTable(counts)}{selectionCounts && <><h4>{t('file.selection')}</h4>{countTable(selectionCounts)}</>}</>}
      {mode === 'submit' && <><p>{t('file.submitNote')}</p><div className="file-dialog-actions"><button className="btn" disabled={busy} onClick={onSource}>{busy ? t('file.packaging') : t('file.sourceZip')}</button><button className="btn primary" disabled={!pdfAvailable} onClick={onPdf}>{t('m.exportPdf')}</button></div></>}
      {mode === 'settings' && <div className="file-settings">
        <div className="file-theme">
          <div className="file-theme-h"><span>{t('file.theme')}</span><span className="hint">{t('file.themeHint')}</span></div>
          <div className="theme-pick" role="radiogroup" aria-label={t('file.theme')}>
            {THEME_IDS.map(id => (
              <button key={id} type="button" role="radio" aria-checked={theme === id} data-pick={id} className={'theme-card' + (theme === id ? ' on' : '')} onClick={() => setTheme(id)}>
                <span className="theme-strip"><i /><i /><i /><i /></span><span>{t('theme.' + id)}</span>
              </button>
            ))}
          </div>
        </div>
        <label>{t('file.fontSize')}<select value={settings.fontSize} onChange={e => onSettings({ ...settings, fontSize: Number(e.target.value) })}>{[12, 14, 16, 18, 20].map(n => <option key={n} value={n}>{n}px</option>)}</select></label>
        <label><span>{t('file.lineWrapping')}</span><input type="checkbox" checked={settings.lineWrapping} onChange={e => onSettings({ ...settings, lineWrapping: e.target.checked })} /></label>
        <label><span>{t('m.syncScroll')}</span><input type="checkbox" checked={settings.syncScroll} onChange={e => onSettings({ ...settings, syncScroll: e.target.checked })} /></label>
        <label>{t('file.compiler')}<select value={engines.length ? engine : ''} disabled={!engines.length} onChange={e => setEngine(e.target.value)}>{engines.length ? engines.map(en => <option key={en}>{en}</option>) : <option value="">{t('m.noEngine')}</option>}</select></label>
      </div>}
    </div>
  </dialog>;
}

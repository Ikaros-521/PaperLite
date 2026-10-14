import { useEffect, useRef, useState } from 'react';
import { useT, useLang } from '../useI18n.js';

export default function FileDialog({ mode, onClose, name, counts, selectionCounts, versions, onSnapshot, onRestore, settings, onSettings, engines, engine, setEngine, onSource, onPdf, pdfAvailable, busy }) {
  const t = useT(), lang = useLang();
  const ref = useRef(null);
  const [selected, setSelected] = useState(null);
  useEffect(() => { ref.current.showModal(); }, []);
  const countTable = c => <dl className="file-counts">{['total', 'cjk', 'words', 'characters'].map(key => <div key={key}><dt>{t('file.' + key)}</dt><dd>{c[key]}</dd></div>)}</dl>;
  return <dialog ref={ref} className="modal file-dialog" aria-labelledby="file-dialog-title" onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) { const r = ref.current.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }}>
    <div className="modal-h"><span id="file-dialog-title">{t('m.' + mode)}</span><button className="btn sm" aria-label={t('file.close')} onClick={onClose}>✕</button></div>
    <div className="modal-body">
      <p className="file-doc-name">{name}</p>
      {mode === 'wordCount' && <><p className="hint">{t('file.countNote')}</p>{countTable(counts)}{selectionCounts && <><h4>{t('file.selection')}</h4>{countTable(selectionCounts)}</>}</>}
      {mode === 'history' && <><p className="hint">{t('file.historyNote')}</p><button className="btn sm" onClick={onSnapshot}>{t('file.snapshot')}</button><div className="version-list">{!versions.length && <p className="hint">{t('file.noVersions')}</p>}{versions.map(v => <button key={v.id} className={'version-row' + (selected?.id === v.id ? ' on' : '')} onClick={() => setSelected(v)}>{new Date(v.date).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')}<span>{v.text.length} {t('file.sourceCharacters')}</span></button>)}</div>{selected && <><pre className="version-preview">{selected.text}</pre><button className="btn primary" onClick={() => onRestore(selected)}>{t('file.restore')}</button></>}</>}
      {mode === 'submit' && <><p>{t('file.submitNote')}</p><div className="file-dialog-actions"><button className="btn" disabled={busy} onClick={onSource}>{busy ? t('file.packaging') : t('file.sourceZip')}</button><button className="btn primary" disabled={!pdfAvailable} onClick={onPdf}>{t('m.exportPdf')}</button></div></>}
      {mode === 'settings' && <div className="file-settings">
        <label>{t('file.fontSize')}<select value={settings.fontSize} onChange={e => onSettings({ ...settings, fontSize: Number(e.target.value) })}>{[12, 14, 16, 18, 20].map(n => <option key={n} value={n}>{n}px</option>)}</select></label>
        <label><span>{t('file.lineWrapping')}</span><input type="checkbox" checked={settings.lineWrapping} onChange={e => onSettings({ ...settings, lineWrapping: e.target.checked })} /></label>
        <label><span>{t('m.syncScroll')}</span><input type="checkbox" checked={settings.syncScroll} onChange={e => onSettings({ ...settings, syncScroll: e.target.checked })} /></label>
        <label>{t('file.compiler')}<select value={engines.length ? engine : ''} disabled={!engines.length} onChange={e => setEngine(e.target.value)}>{engines.length ? engines.map(en => <option key={en}>{en}</option>) : <option value="">{t('m.noEngine')}</option>}</select></label>
      </div>}
    </div>
  </dialog>;
}

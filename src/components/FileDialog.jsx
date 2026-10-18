import { useEffect, useRef, useState } from 'react';
import { useT } from '../useI18n.js';
import { THEME_IDS } from '../theme.js';
import { validateSnippetName, nextSnippetId } from '../snippets.js';

export default function FileDialog({ mode, onClose, name, counts, selectionCounts, settings, onSettings, engines, engine, setEngine, mainDoc, mainDocOptions, onMainDoc, onSource, onPdf, pdfAvailable, compiledPdf, busy, theme, setTheme, snippets, onSnippets }) {
  const t = useT();
  const ref = useRef(null);
  useEffect(() => { ref.current.showModal(); }, []);
  // 片段管理：本地编辑态，点「保存全部」才落盘；名称校验用 snippets 模块的规则
  const [editing, setEditing] = useState(null); // {id, name, content, isNew}
  const [snipError, setSnipError] = useState('');
  const startNew = () => setEditing({ id: nextSnippetId(), name: '', content: '', isNew: true });
  const startEdit = s => setEditing({ ...s, isNew: false });
  const applyEdit = () => {
    const v = validateSnippetName(editing.name, snippets, editing.id);
    if (!v.ok) { setSnipError(t(v.error === 'empty' ? 'sn.nameEmpty' : 'sn.nameDup')); return; }
    const rest = snippets.filter(s => s.id !== editing.id);
    onSnippets([...rest, { id: editing.id, name: v.name, content: editing.content }].sort((a, b) => a.name.localeCompare(b.name, 'zh')));
    setEditing(null); setSnipError('');
  };
  const countTable = c => <dl className="file-counts">{['total', 'cjk', 'words', 'characters'].map(key => <div key={key}><dt>{t('file.' + key)}</dt><dd>{c[key]}</dd></div>)}</dl>;
  return <dialog ref={ref} className="modal file-dialog" aria-labelledby="file-dialog-title" onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) { const r = ref.current.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }}>
    <div className="modal-h"><span id="file-dialog-title">{t('m.' + mode)}</span><button className="btn sm" aria-label={t('file.close')} onClick={onClose}>✕</button></div>
    <div className="modal-body">
      <p className="file-doc-name">{name}</p>
      {mode === 'wordCount' && <><p className="hint">{t('file.countNote')}</p>{countTable(counts)}{selectionCounts && <><h4>{t('file.selection')}</h4>{countTable(selectionCounts)}</>}</>}
      {mode === 'submit' && <><p>{t('file.submitNote')}</p><div className="file-dialog-actions"><button className="btn" disabled={busy} onClick={onSource}>{busy ? t('file.packaging') : t('file.sourceZip')}</button><button className="btn primary" disabled={!pdfAvailable} onClick={onPdf}>{t(compiledPdf ? 'm.dlCompiled' : 'm.exportPdf')}</button></div></>}
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
        <label><span>{t('file.spellcheck')}</span><input type="checkbox" checked={settings.spellcheck !== false} onChange={e => onSettings({ ...settings, spellcheck: e.target.checked })} /></label>
        <label className="file-grammar"><span>{t('file.grammar')}<em className="hint">{t('file.grammarHint')}</em></span><input type="checkbox" checked={settings.grammarCheck === true} onChange={e => onSettings({ ...settings, grammarCheck: e.target.checked })} /></label>
        <label className="file-grammar"><span>{t('file.aiProofread')}<em className="hint">{t('file.aiProofreadHint')}</em></span><input type="checkbox" checked={settings.aiProofread === true} onChange={e => onSettings({ ...settings, aiProofread: e.target.checked })} /></label>
        <label><span>{t('m.syncScroll')}</span><input type="checkbox" checked={settings.syncScroll} onChange={e => onSettings({ ...settings, syncScroll: e.target.checked })} /></label>
        <label><span>{t('file.vimMode')}</span><input type="checkbox" checked={settings.vimMode === true} onChange={e => onSettings({ ...settings, vimMode: e.target.checked })} /></label>
        <label>{t('file.engine')}<select value={engines.length ? engine : ''} disabled={!engines.length} onChange={e => setEngine(e.target.value)}>{engines.length ? engines.map(en => <option key={en} value={en}>{en === 'builtin' ? t('app.builtinEngine') : en}</option>) : <option value="">{t('m.noEngine')}</option>}</select></label>
        <label>{t('file.mainDoc')}<select value={mainDoc || 'auto'} onChange={e => onMainDoc(e.target.value === 'auto' ? '' : e.target.value)}>
          <option value="auto">{t('file.mainDocAuto')}</option>
          {(mainDocOptions || []).map(o => <option key={o.path} value={o.path}>{o.label}</option>)}
        </select><span className="hint">{t('file.mainDocHint')}</span></label>
        <label>{t('file.autoCompile')}<select value={settings.autoCompile || 'off'} onChange={e => onSettings({ ...settings, autoCompile: e.target.value })}>
          <option value="off">{t('file.acOff')}</option>
          <option value="save">{t('file.acSave')}</option>
          <option value="idle">{t('file.acIdle')}</option>
        </select></label>
      </div>}
      {mode === 'snippets' && <div className="sn-manager">
        <p className="hint">{t('sn.note')}</p>
        {!editing && <>
          <div className="sn-list">
            {snippets.length ? snippets.map(s => (
              <div key={s.id} className="sn-item">
                <button type="button" className="sn-name" title={t('sn.edit')} onClick={() => startEdit(s)}>{s.name}</button>
                <code className="sn-preview">{s.content.slice(0, 60).replace(/\n/g, ' ⏎ ')}</code>
                <button type="button" className="btn sm" title={t('sn.del')} onClick={() => { if (window.confirm(t('sn.delConfirm', { name: s.name }))) onSnippets(snippets.filter(x => x.id !== s.id)); }}>🗑</button>
              </div>
            )) : <p className="hint">{t('sn.empty')}</p>}
          </div>
          <div className="file-dialog-actions"><button className="btn" onClick={startNew}>{t('sn.add')}</button></div>
        </>}
        {editing && <div className="sn-edit">
          <label>{t('sn.name')}<input autoFocus value={editing.name} onChange={e => { setEditing({ ...editing, name: e.target.value }); setSnipError(''); }} /></label>
          <label>{t('sn.content')}<textarea rows={8} value={editing.content} onChange={e => setEditing({ ...editing, content: e.target.value })} placeholder="\\begin{theorem}…" /></label>
          {snipError && <p className="cite-status">{snipError}</p>}
          <div className="file-dialog-actions">
            <button className="btn" onClick={() => { setEditing(null); setSnipError(''); }}>{t('sn.cancel')}</button>
            <button className="btn primary" onClick={applyEdit}>{editing.isNew ? t('sn.add') : t('sn.save')}</button>
          </div>
        </div>}
      </div>}
    </div>
  </dialog>;
}

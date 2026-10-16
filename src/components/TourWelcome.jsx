import { useLayoutEffect, useRef } from 'react';
import { useT } from '../useI18n.js';

export default function TourWelcome({ onStart, onClose, onNewDraft, onOpenFolder, folderSupported }) {
  const t = useT();
  const ref = useRef(null);
  const close = () => onClose(true);
  useLayoutEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    dialog.querySelector('.tw-foot .primary')?.focus();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className="modal tour-welcome" aria-labelledby="welcome-title"
    aria-describedby="welcome-description" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="tw-hero">
      <span className="brand-seal">论</span>
      <div><h1 id="welcome-title" className="tw-title">{t('tour.welcome.title')}</h1>
        <p id="welcome-description" className="tw-slogan">{t('welcome.description')}</p></div>
      <button className="btn sm tw-close" aria-label={t('file.close')} onClick={close}>✕</button>
    </div>
    <div className="tw-choices">
      <button className="tw-choice" onClick={onNewDraft}>
        <strong>{t('welcome.blank')}</strong><span>{t('welcome.blankNote')}</span>
      </button>
      <button className="tw-choice" disabled={!folderSupported} onClick={onOpenFolder}>
        <strong>{t('welcome.folder')}</strong><span>{t(folderSupported ? 'welcome.folderNote' : 'welcome.folderUnsupported')}</span>
      </button>
    </div>
    <p className="tw-note">{t('welcome.localNote')}</p>
    <div className="tw-foot">
      <button className="btn sm" onClick={onStart}>{t('welcome.tutorial')}</button>
      <span className="tw-sp" />
      <button className="btn sm primary" autoFocus onClick={close}>{t('welcome.continue')}</button>
    </div>
  </dialog>;
}

import { useState } from 'react';
import { useT } from '../useI18n.js';

/* 首次访问的欢迎弹窗：一条价值说明 + 四个能力点 + 开始/跳过，
 * 「不再自动弹出」勾选只影响下次打开是否自动出现，不影响手动从帮助菜单重看。 */

const ICONS = ['⚡', '▤', '∑', '◈'];

export default function TourWelcome({ stepCount, onStart, onClose }) {
  const t = useT();
  const [noAuto, setNoAuto] = useState(false);
  const close = () => onClose(noAuto);

  return (
    <div className="modal-mask" onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal tour-welcome" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={t('tour.welcome.title')}>
        <div className="tw-hero">
          <span className="brand-seal">论</span>
          <div>
            <div className="tw-title">{t('tour.welcome.title')}</div>
            <div className="tw-slogan">{t('tour.welcome.slogan')}</div>
          </div>
        </div>
        <ul className="tw-list">
          {['w1', 'w2', 'w3', 'w4'].map((k, idx) => (
            <li className="tw-item" key={k}><span className="tw-ico">{ICONS[idx]}</span><span>{t('tour.welcome.' + k)}</span></li>
          ))}
        </ul>
        <div className="tw-note">{t('tour.welcome.note', { n: stepCount })}</div>
        <div className="tw-foot">
          <label className="tw-check">
            <input type="checkbox" checked={noAuto} onChange={e => setNoAuto(e.target.checked)} />
            {t('tour.welcome.noAuto')}
          </label>
          <span className="tw-sp"></span>
          <button className="btn sm" onClick={close}>{t('tour.welcome.skip')}</button>
          <button className="btn sm primary" autoFocus onClick={onStart}>{t('tour.welcome.start')}</button>
        </div>
      </div>
    </div>
  );
}

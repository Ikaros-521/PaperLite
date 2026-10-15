import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../useI18n.js';

/* 聚光灯式分步导览：遮罩只在锚点处挖洞，卡片贴在锚点旁讲下一步。
 * 不引第三方库（driver.js / shepherd.js 都要几十 KB 且样式对不上皮肤），
 * 这里只做「量锚点 → 摆卡片 → 跟随滚动重算」，锚点找不到时退化成居中卡片。 */

const PAD = 5;   // 高亮框相对锚点外扩
const GAP = 14;  // 卡片与高亮框的间距
const EDGE = 10; // 卡片距视口边缘最小留白

function rectOf(step) {
  if (!step.target) return null;
  const el = document.querySelector(step.target);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // 裁到视口内：纸面这类几千像素高的锚点若不裁剪，压暗与卡片定位会一起失效
  const top = Math.max(0, r.top - PAD), left = Math.max(0, r.left - PAD);
  const bottom = Math.min(window.innerHeight, r.bottom + PAD), right = Math.min(window.innerWidth, r.right + PAD);
  if (bottom - top < 2 || right - left < 2) return null;
  return { top, left, width: right - left, height: bottom - top };
}

// 优先按 place 摆放；该侧放不下就翻到对面，最后夹回视口内
function placeCard(s, place, cw, ch, vw, vh) {
  let top, left;
  const below = s.top + s.height + GAP;
  const above = s.top - GAP - ch;
  const after = s.left + s.width + GAP;
  const before = s.left - GAP - cw;
  if (place === 'inside') {
    top = s.top + (s.height - ch) / 2;
    left = s.left + (s.width - cw) / 2;
  } else if (place === 'left') {
    left = before >= EDGE ? before : (after + cw <= vw - EDGE ? after : before);
    top = s.top;
  } else if (place === 'right') {
    left = after + cw <= vw - EDGE ? after : (before >= EDGE ? before : after);
    top = s.top;
  } else if (place === 'top') {
    top = above >= EDGE ? above : (below + ch <= vh - EDGE ? below : above);
    left = s.left;
  } else {
    top = below + ch <= vh - EDGE ? below : (above >= EDGE ? above : below);
    left = s.left;
  }
  // 卡片比视口还大时贴边放，避免出现负偏移把标题顶出屏幕
  const clamp = (v, size, span) => (size + EDGE * 2 >= span ? 0 : Math.max(EDGE, Math.min(v, span - size - EDGE)));
  return { top: clamp(top, ch, vh), left: clamp(left, cw, vw) };
}

export default function TourGuide({ steps, onClose }) {
  const t = useT();
  const [i, setI] = useState(0);
  const [spot, setSpot] = useState(null);
  const [pos, setPos] = useState(null);
  const cardRef = useRef(null);
  const step = steps[i];
  const last = i === steps.length - 1;

  const update = useCallback(() => {
    const s = rectOf(step);
    setSpot(s);
    if (!s) { setPos(null); return; }
    const card = cardRef.current;
    setPos(placeCard(s, step.place || 'bottom', card?.offsetWidth || 360, card?.offsetHeight || 240, window.innerWidth, window.innerHeight));
  }, [step]);

  // 换步：先把锚点滚进视野，再连续跟随若干帧 + 滚动/缩放事件重算，避免平滑滚动期间错位
  useLayoutEffect(() => {
    const el = step.target ? document.querySelector(step.target) : null;
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    update();
    let n = 0, raf = 0;
    const tick = () => { update(); if (++n < 50) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [step, update]);

  useEffect(() => {
    const on = () => update();
    window.addEventListener('resize', on);
    window.addEventListener('scroll', on, true);
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); if (!last) setI(i + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); if (i > 0) setI(i - 1); }
    };
    document.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('resize', on);
      window.removeEventListener('scroll', on, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [i, last, onClose, update]);

  return (
    <div className={'tour-root' + (spot ? '' : ' plain')} role="dialog" aria-modal="true" aria-label={t('tour.aria')}>
      {spot && <div className="tour-spot" style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }} />}
      <div
        ref={cardRef}
        className={'tour-card' + (spot ? '' : ' center')}
        style={spot ? { top: pos?.top, left: pos?.left, visibility: pos ? 'visible' : 'hidden' } : undefined}
      >
        <div className="tour-h">
          <span className="tour-ch">{t(step.chapter)}</span>
          <span className="tour-n">{t('tour.stepOf', { n: i + 1, total: steps.length })}</span>
          <button className="btn sm tour-x" aria-label={t('tour.close')} onClick={onClose}>✕</button>
        </div>
        <div className="tour-prog"><i style={{ width: ((i + 1) / steps.length * 100) + '%' }}></i></div>
        <div className="tour-b">
          <div className="tour-t">{t('tour.' + step.key + '.title')}</div>
          <p className="tour-p">{t('tour.' + step.key + '.body')}</p>
        </div>
        <div className="tour-f">
          <button className="btn sm tour-skip" onClick={onClose}>{t('tour.skip')}</button>
          <span className="tour-sp"></span>
          {i > 0 && <button className="btn sm" onClick={() => setI(i - 1)}>{t('tour.prev')}</button>}
          <button className="btn sm primary" autoFocus onClick={() => (last ? onClose() : setI(i + 1))}>
            {last ? t('tour.finish') : t('tour.next')}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useMemo } from 'react';
import { useT } from '../useI18n.js';

/* 大纲面板：多级标题，点击跳转（编辑器行 + 预览锚点） */
export default function OutlinePanel({ kind, headings, onJump }) {
  const t = useT();
  const items = useMemo(() => (headings || []).slice(0, 300), [headings]);

  if (kind !== 'tex' && kind !== 'md' && kind !== 'draft') {
    return <div className="side-pad hint">{t('outline.unsupported')}</div>;
  }
  if (!items.length) {
    return <div className="side-pad hint">{t('outline.empty1')}<br />{t('outline.empty2')}<br />{t('outline.empty3')}</div>;
  }

  return (
    <div className="outline">
      {items.map((h, i) => (
        <div
          key={i}
          className={'ol-item ol-l' + h.level}
          onClick={() => onJump(h)}
          title={h.text}
        >
          {h.num ? <span className="ol-num">{h.num}</span> : null}
          <span className="ol-text">{h.text || t('outline.emptyHead')}</span>
        </div>
      ))}
    </div>
  );
}

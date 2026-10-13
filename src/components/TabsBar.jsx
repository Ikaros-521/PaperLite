import { infoFor } from '../fileTypes.js';
import { useT } from '../useI18n.js';

/* 编辑器标签栏（VSCode 风格）：未保存圆点、关闭按钮 */
export default function TabsBar({ tabs, activeId, onActivate, onClose }) {
  const t = useT();
  if (!tabs.length) return null;
  return (
    <div id="tabsBar">
      {tabs.map(x => (
        <div
          key={x.id}
          className={'tab' + (x.id === activeId ? ' on' : '')}
          onClick={() => onActivate(x.id)}
          title={x.kind === 'draft' ? t('app.draftPath') : (x.path || x.name)}
        >
          <span className="tab-icon">{infoFor(x.name).icon}</span>
          {/* 草稿标签的显示名随界面语言实时派生（存储名仍作为另存时的默认文件名） */}
          <span className="tab-name">{x.kind === 'draft' ? t('app.draftName') : x.name}</span>
          {x.dirty && <span className="tab-dot" title={t('tab.unsaved')}></span>}
          <button
            className="tab-close"
            title={t('tab.close')}
            onClick={e => { e.stopPropagation(); onClose(x.id); }}
          >✕</button>
        </div>
      ))}
    </div>
  );
}

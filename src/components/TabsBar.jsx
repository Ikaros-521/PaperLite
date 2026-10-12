import { infoFor } from '../fileTypes.js';

/* 编辑器标签栏（VSCode 风格）：未保存圆点、关闭按钮 */
export default function TabsBar({ tabs, activeId, onActivate, onClose }) {
  if (!tabs.length) return null;
  return (
    <div id="tabsBar">
      {tabs.map(t => (
        <div
          key={t.id}
          className={'tab' + (t.id === activeId ? ' on' : '')}
          onClick={() => onActivate(t.id)}
          title={t.path || t.name}
        >
          <span className="tab-icon">{infoFor(t.name).icon}</span>
          <span className="tab-name">{t.name}</span>
          {t.dirty && <span className="tab-dot" title="未保存"></span>}
          <button
            className="tab-close"
            title="关闭"
            onClick={e => { e.stopPropagation(); onClose(t.id); }}
          >✕</button>
        </div>
      ))}
    </div>
  );
}

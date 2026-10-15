import { useT } from '../useI18n.js';

/* 问题面板：静态语法检测 + 渲染警告 + 编译错误；点击跳转行；支持 AI 修复 */
export default function DiagnosticsPanel({ issues = [], dismissedCount = 0, onRestore, onDismiss, onClear, onJump, onAiFix, aiBusy }) {
  const t = useT();
  const all = issues;
  const errs = all.filter(d => d.severity === 'error').length;

  return (
    <div className="diag">
      <div className="diag-head">
        <span>{all.length ? t(errs ? 'diag.count' : 'diag.countNoErr', { n: all.length, errs }) : dismissedCount ? t('diag.hidden', { n: dismissedCount }) : t('diag.none')}</span>
        {all.length > 0 && (
          <div className="diag-actions">
            <button className="btn sm" onClick={onClear} title={t('diag.dismissTip')}>{t('diag.clear')}</button>
            <button className="btn sm" disabled={aiBusy || !all.some(d => d.src !== 'render')} onClick={onAiFix} title={t('diag.fixTip')}>
              {aiBusy ? t('diag.fixing') : t('diag.fix')}
            </button>
          </div>
        )}
      </div>
      {dismissedCount > 0 && <div className="diag-note">{t('diag.hidden', { n: dismissedCount })} <button className="btn sm" onClick={onRestore}>{t('diag.restore')}</button></div>}
      {all.length > 0 && <div className="diag-note">{t('diag.dismissTip')}</div>}
      {all.map(d => (
        <div key={d.id} className={'diag-item ' + d.severity} onClick={() => d.line != null && onJump(d)}>
          <span className="diag-sev">{d.severity === 'error' ? '✖' : '⚠'}</span>
          <span className="diag-msg">{d.msg}</span>
          {d.line != null && <span className="diag-line">{t('diag.line', { n: d.line + 1 })}</span>}
          <span className="diag-line dim">{t('diag.src' + (d.src === 'render' ? 'Render' : d.src === 'compile' ? 'Compile' : 'Lint'))}</span>
          <button className="diag-dismiss" title={t('diag.dismiss')} aria-label={t('diag.dismiss') + ': ' + d.msg}
            onClick={event => { event.stopPropagation(); onDismiss(d); }}>×</button>
        </div>
      ))}
    </div>
  );
}

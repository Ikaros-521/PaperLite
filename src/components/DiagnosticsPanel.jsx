import { useT } from '../useI18n.js';

/* 问题面板：静态语法检测 + 渲染警告 + 编译错误；点击跳转行。
 * AI 修复改为「勾选 + 串行队列」：可选部分或全部，逐条发送，运行中显示进度并可停止。 */
const ST_ICON = { queued: '○', fixing: '🔧', retrying: '↻', done: '✓', failed: '✗', cancelled: '⊘' };

export default function DiagnosticsPanel({
  issues = [], dismissedCount = 0, onRestore, onDismiss, onClear, onJump,
  onAiFix, aiBusy, selected, onToggle, onToggleAll, fixRun, onStop
}) {
  const t = useT();
  const all = issues;
  const errs = all.filter(d => d.severity === 'error').length;
  const selCount = all.reduce((n, d) => n + (selected && selected.has(d.id) ? 1 : 0), 0);
  const allSelected = all.length > 0 && selCount === all.length;
  const someSelected = selCount > 0 && !allSelected;
  const running = !!(fixRun && fixRun.active);
  const per = (fixRun && fixRun.per) || {};

  return (
    <div className="diag">
      <div className="diag-head">
        <span>{all.length ? t(errs ? 'diag.count' : 'diag.countNoErr', { n: all.length, errs }) : dismissedCount ? t('diag.hidden', { n: dismissedCount }) : t('diag.none')}</span>
        {all.length > 0 && (
          <div className="diag-actions">
            {running ? (
              <>
                <span className="diag-prog">{t('diag.progress', { done: fixRun.done, total: fixRun.total })}</span>
                <button className="btn sm" onClick={onStop} title={t('diag.stop')}>{t('diag.stop')}</button>
              </>
            ) : (
              <>
                <label className="diag-all" title={t('diag.fixSelTip')}>
                  <input type="checkbox" checked={allSelected}
                    ref={el => { if (el) el.indeterminate = someSelected; }}
                    onChange={e => onToggleAll && onToggleAll(e.target.checked)} />
                  <span>{t('diag.selectAll')}</span>
                </label>
                <button className="btn sm" onClick={onClear} title={t('diag.dismissTip')}>{t('diag.clear')}</button>
                <button className="btn sm" disabled={aiBusy || !all.length} onClick={onAiFix} title={t('diag.fixSelTip')}>
                  {selCount > 0 ? t('diag.fixSelected', { n: selCount }) : t('diag.fixAll', { n: all.length })}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {dismissedCount > 0 && <div className="diag-note">{t('diag.hidden', { n: dismissedCount })} <button className="btn sm" onClick={onRestore}>{t('diag.restore')}</button></div>}
      {all.length > 0 && !running && <div className="diag-note">{t('diag.dismissTip')}</div>}
      {all.map(d => {
        const st = per[d.id];
        return (
          <div
            key={d.id}
            className={'diag-item ' + d.severity + (d.line == null ? ' no-line' : '') + (st ? ' st-' + st.status : '')}
            role={d.line != null ? 'button' : undefined}
            tabIndex={d.line != null ? 0 : undefined}
            title={d.line != null ? t('diag.jump') : t('diag.noLine')}
            onClick={() => d.line != null && onJump(d)}
            onKeyDown={e => {
              if (d.line != null && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                onJump(d);
              }
            }}
          >
            <input
              className="diag-check" type="checkbox"
              checked={!!(selected && selected.has(d.id))}
              disabled={running}
              aria-label={t('diag.fix') + ': ' + d.msg}
              onClick={e => e.stopPropagation()}
              onChange={() => onToggle && onToggle(d.id)}
            />
            <span className="diag-sev">{d.severity === 'error' ? '✖' : '⚠'}</span>
            <span className="diag-msg">{d.msg}</span>
            {st && (
              <span className={'diag-status ' + st.status} title={st.error || t('diag.st' + st.status[0].toUpperCase() + st.status.slice(1))}>
                {ST_ICON[st.status]}{st.status === 'retrying' && st.attempt ? ' ' + st.attempt : ''}
              </span>
            )}
            {d.line != null && <span className="diag-line">{t('diag.line', { n: d.line + 1 })}</span>}
            <span className="diag-line dim">{t('diag.src' + (d.src === 'render' ? 'Render' : d.src === 'compile' ? 'Compile' : 'Lint'))}</span>
            <button className="diag-dismiss" title={t('diag.dismiss')} aria-label={t('diag.dismiss') + ': ' + d.msg} disabled={running}
              onClick={event => { event.stopPropagation(); onDismiss(d); }}>×</button>
          </div>
        );
      })}
    </div>
  );
}

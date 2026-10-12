import { useMemo } from 'react';

/* 问题面板：静态语法检测 + 渲染警告 + 编译错误；点击跳转行；支持 AI 修复 */
export default function DiagnosticsPanel({ diagnostics, renderWarnings, compileErrors, onJump, onAiFix, aiBusy }) {
  const all = useMemo(() => {
    const ds = (diagnostics || []).map(d => ({ ...d, src: 'lint' }));
    const rs = (renderWarnings || []).map(w => ({ line: null, msg: w, severity: 'warn', src: 'render' }));
    const cs = (compileErrors || []).map(e => ({ line: e.line, msg: (e.msg || '') + (e.line != null ? '' : ''), severity: 'error', src: 'compile' }));
    return [...cs, ...ds, ...rs].slice(0, 120);
  }, [diagnostics, renderWarnings, compileErrors]);

  const errs = all.filter(d => d.severity === 'error').length;

  return (
    <div className="diag">
      <div className="diag-head">
        <span>{all.length ? `${all.length} 个问题${errs ? `（含 ${errs} 个错误）` : ''}` : '未发现问题 ✓'}</span>
        {all.length > 0 && (
          <button className="btn sm" disabled={aiBusy} onClick={onAiFix} title="把问题清单与相关上下文发给 AI 修复">
            {aiBusy ? 'AI 修复中…' : '✨ AI 修复'}
          </button>
        )}
      </div>
      {all.map((d, i) => (
        <div key={i} className={'diag-item ' + d.severity} onClick={() => d.line != null && onJump(d)}>
          <span className="diag-sev">{d.severity === 'error' ? '✖' : '⚠'}</span>
          <span className="diag-msg">{d.msg}</span>
          {d.line != null && <span className="diag-line">第 {d.line + 1} 行</span>}
          {d.line == null && <span className="diag-line dim">{d.src === 'render' ? '渲染' : d.src === 'compile' ? '编译' : ''}</span>}
        </div>
      ))}
    </div>
  );
}

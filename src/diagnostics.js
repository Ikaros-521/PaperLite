// One issue list drives the panel, badge, editor markers, and AI fixes.
export function collectIssues(diagnostics = [], renderWarnings = [], compileErrors = []) {
  // 渲染引擎与静态检查可能撞在同一行的同一类问题上（例如未定义引用）：留语法那条，
  // 它带行号也带修法；渲染提示只在 lint 不覆盖这一行时才值得占一格。
  const linted = new Set(diagnostics.map(d => `${d.line}|${d.kind}`));
  return [
    ...compileErrors.map(e => ({ ...e, severity: 'error', src: 'compile' })),
    ...diagnostics.map(d => ({ ...d, src: 'lint' })),
    ...renderWarnings
      .map(w => ({ line: w.line ?? null, msg: w.msg, kind: w.kind || null, severity: 'warn', src: 'render' }))
      .filter(w => w.line == null || !linted.has(`${w.line}|${w.kind}`))
  ].map((issue, index) => ({ ...issue, id: `${issue.src}:${index}` }));
}

export function currentCompileErrors(result, tabId, source) {
  return result?.tabId === tabId && result.source === source ? (result.errors || []) : [];
}

// Dismissals must survive unrelated typing: identify an issue by what it says about
// its own source line, not by its position in the freshly rebuilt list.
export function issueFingerprint(issue, lineTextOf) {
  const src = issue.line == null ? '' : lineTextOf(issue.line);
  return `${issue.src}|${issue.kind || ''}|${issue.msg}|${src}`;
}

// One issue list drives the panel, badge, editor markers, and AI fixes.
export function collectIssues(diagnostics = [], renderWarnings = [], compileErrors = []) {
  return [
    ...compileErrors.map(e => ({ ...e, severity: 'error', src: 'compile' })),
    ...diagnostics.map(d => ({ ...d, src: 'lint' })),
    ...renderWarnings.map(msg => ({ line: null, msg, severity: 'warn', src: 'render' }))
  ].map((issue, index) => ({ ...issue, id: `${issue.src}:${index}` }));
}

export function currentCompileErrors(result, tabId, source) {
  return result?.tabId === tabId && result.source === source ? (result.errors || []) : [];
}

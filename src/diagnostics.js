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

export function currentCompileErrors(result, tabId) {
  if (!result || result.tabId !== tabId) return [];
  // 过期以「编译入口文档的内容是否又变了」为准（useCompile 的 staleNow 闭包）。
  // 旧实现比较 result.source === 当前标签全文：主文档入口编译时 source 是主文档
  // 全文，与发起编译的子文件标签永不相等，错误会被整段吞掉。编辑时的即时
  // 失效另由 retireErrors 在 onDocChange 清空，这里是纯函数侧的第二道防线。
  if (result.staleNow && result.staleNow()) return [];
  return result.errors || [];
}

// Dismissals must survive unrelated typing: identify an issue by what it says about
// its own source line, not by its position in the freshly rebuilt list.
export function issueFingerprint(issue, lineTextOf) {
  const src = issue.line == null ? '' : lineTextOf(issue.line);
  return `${issue.src}|${issue.kind || ''}|${issue.msg}|${src}`;
}

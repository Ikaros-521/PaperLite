/* PaperLite · TeX 注释剥离（共享口径）
 *
 * % 前是偶数个连续反斜杠（0/2/4…）才是注释：`\\%` 是「换行命令 + 真·注释」，
 * 奇数个反斜杠后的 % 是转义的字面百分号（如 100\%）。正则 lookbehind 数不了
 * 奇偶，用「(^ | 非反斜杠 + 成对反斜杠) + %」匹配并把前缀整组捕获保留，
 * 替换后换行命令 \\ 不丢。逐字环境（verbatim 等）不在此处理——各调用方按需自行跳过。
 */

const COMMENT_RE = /(^|[^\\](?:\\{2})*)%[^\r\n]*/g;

/** 删除注释行内容；keepLength=true 时空格等长替换（保偏移的场景用） */
export function stripTexComments(text, { keepLength = false } = {}) {
  const s = String(text || '');
  return keepLength
    ? s.replace(COMMENT_RE, (m, lead) => lead + ' '.repeat(m.length - lead.length))
    : s.replace(COMMENT_RE, '$1');
}

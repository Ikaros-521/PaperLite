/** 移动壳纯格式化工具：与桌面 statusbar / i18n 的显示口径保持一致 */

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

/** 文稿行与历史时间线的相对时间；超过一周退回具体日期 */
export function formatRelative(ts: number, now = Date.now()): string {
  const d = now - ts
  if (d < 2 * MINUTE) return '刚刚'
  if (d < HOUR) return `${Math.round(d / MINUTE)} 分钟前`
  if (d < DAY) return `${Math.round(d / HOUR)} 小时前`
  if (d < 2 * DAY) return '昨天'
  if (d < 7 * DAY) return `${Math.round(d / DAY)} 天前`
  const date = new Date(ts)
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

/** 字数：桌面用 '{n} 字'，此处加千分位并配合 tabular-nums 对齐 */
export function formatWords(n: number): string {
  return `${n.toLocaleString('zh-CN')} 字`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 编译耗时：桌面实测 2005ms，移动端需与「引擎预热中」区分 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  return `${(ms / 1000).toFixed(1)} 秒`
}

/** 诊断/编译错误的行号文案；line 为 null 表示引擎级失败（对齐 xelatex.js） */
export function formatLine(line: number | null): string {
  return line === null ? '引擎级错误' : `第 ${line} 行`
}

export function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

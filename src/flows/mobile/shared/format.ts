/** 移动壳纯格式化工具：与桌面 statusbar / i18n 的显示口径保持一致 */
import { t } from '../../../i18n.js'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

/** 文稿行与历史时间线的相对时间；超过一周退回具体日期 */
export function formatRelative(ts: number, now = Date.now()): string {
  const d = now - ts
  if (d < 2 * MINUTE) return t('mb.fmt.justNow')
  if (d < HOUR) return t('mb.fmt.minAgo', { n: Math.round(d / MINUTE) })
  if (d < DAY) return t('mb.fmt.hourAgo', { n: Math.round(d / HOUR) })
  if (d < 2 * DAY) return t('mb.fmt.yesterday')
  if (d < 7 * DAY) return t('mb.fmt.dayAgo', { n: Math.round(d / DAY) })
  const date = new Date(ts)
  return t('mb.fmt.date', { m: date.getMonth() + 1, d: date.getDate() })
}

/** 字数：桌面用 '{n} 字'，此处加千分位并配合 tabular-nums 对齐 */
export function formatWords(n: number): string {
  return t('mb.fmt.words', { n: n.toLocaleString('zh-CN') })
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 编译耗时：桌面实测 2005ms，移动端需与「引擎预热中」区分 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return t('mb.fmt.ms', { n: Math.round(ms) })
  return t('mb.fmt.sec', { n: (ms / 1000).toFixed(1) })
}

/** 诊断/编译错误的行号文案；line 为 null 表示引擎级失败（对齐 xelatex.js） */
export function formatLine(line: number | null): string {
  return line === null ? t('mb.fmt.engineError') : t('mb.fmt.line', { n: line })
}

export function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

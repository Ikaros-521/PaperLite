import type { DocKind, EngineName, PreviewMode, SaveState } from './types'

/** 保存态文案对齐 src/i18n.js 的 save.* 六态，移动端改为顶栏常驻徽标 */
export const SAVE_STATE: Record<SaveState, { text: string; color: string; tip: string }> = {
  'browser-saved': { text: '已存浏览器', color: 'primary', tip: '草稿只存在这台浏览器，不会写入文件或同步到其他设备' },
  'browser-pending': { text: '等待自动保存', color: 'default', tip: '编辑停顿后自动存入当前浏览器' },
  'disk-saved': { text: '已写入文件', color: 'success', tip: '内容与磁盘文件一致' },
  'disk-dirty': { text: '有未保存修改', color: 'warning', tip: '内容与磁盘不同，点「保存」写入' },
  saving: { text: '正在写入…', color: 'primary', tip: '保存中，此时继续输入的新改动会保留标记' },
  failed: { text: '保存失败', color: 'danger', tip: '内容尚未安全保存，请重试或先导出源码备份' },
}

export const DOC_KIND_LABEL: Record<DocKind, string> = {
  tex: 'LaTeX',
  md: 'Markdown',
  image: '图片',
  pdf: 'PDF',
}

/** 段控件文案：预览侧刻意写成「近似排版」，避免用户把它当成投稿用的真实分页 */
export const VIEW_LABEL: Record<PreviewMode, string> = {
  source: '源码',
  rich: '近似排版',
  pdf: '编译 PDF',
  log: '编译日志',
}

export const ENGINE_LABEL: Record<EngineName, string> = {
  builtin: '网页近似排版',
  xelatex: 'XeLaTeX（本机）',
  pdflatex: 'pdfLaTeX（本机）',
  lualatex: 'LuaLaTeX（本机）',
}

export const REASON_LABEL: Record<string, string> = {
  auto: '自动快照',
  manual: '手动版本',
  'before-restore': '恢复前快照',
}

export const SEVERITY_LABEL = {
  error: { text: '错误', color: 'danger' },
  warn: { text: '警告', color: 'warning' },
} as const

export const DIFF_LAYOUT_LABEL = {
  inline: '行内',
  side: '并排',
} as const

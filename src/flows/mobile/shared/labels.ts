import type { DocKind, EngineName, PreviewMode, SaveState } from './types'
import { saveState as desktopSaveState } from '../../../saveState.js'

/**
 * 这些映射存的是 i18n **键名**，不是成品文案：语言可以在运行时切换，
 * 模块顶层翻译会把英文界面锁死在中文上。渲染处统一 t(XXX[key])。
 * 少数值（LaTeX / Markdown / PDF）是专有名词，主词典里没有该键时 tr() 原样返回，正好。
 */

/** 保存态：判据复用桌面 src/saveState.js，文案与 save.* 同义，移动端做成顶栏常驻徽标 */
export const SAVE_STATE: Record<SaveState, { textKey: string; color: string; tipKey: string }> = {
  'browser-saved': { textKey: 'mb.lb.browserSaved', color: 'primary', tipKey: 'mb.lb.browserSavedTip' },
  'browser-pending': { textKey: 'mb.lb.browserPending', color: 'default', tipKey: 'mb.lb.browserPendingTip' },
  'disk-saved': { textKey: 'mb.lb.diskSaved', color: 'success', tipKey: 'mb.lb.diskSavedTip' },
  'disk-dirty': { textKey: 'mb.lb.diskDirty', color: 'warning', tipKey: 'mb.lb.diskDirtyTip' },
  unsaved: { textKey: 'mb.lb.unsaved', color: 'warning', tipKey: 'mb.lb.unsavedTip' },
  saving: { textKey: 'mb.lb.saving', color: 'primary', tipKey: 'mb.lb.savingTip' },
  failed: { textKey: 'mb.lb.failed', color: 'danger', tipKey: 'mb.lb.failedTip' },
}

/** 复用桌面唯一的「脏」判据，两端不各定一套定义 */
const DESKTOP_STATE: Record<string, SaveState> = {
  saving: 'saving',
  failed: 'failed',
  browserSaved: 'browser-saved',
  browserPending: 'browser-pending',
  diskSaved: 'disk-saved',
  diskUnsaved: 'disk-dirty',
  unsaved: 'unsaved',
}

export function saveStateOf(tab: Parameters<typeof desktopSaveState>[0]): SaveState {
  const raw = desktopSaveState(tab as never)
  return (raw && DESKTOP_STATE[raw]) || 'browser-pending'
}

export const DOC_KIND_LABEL: Record<DocKind, string> = {
  tex: 'LaTeX',
  md: 'Markdown',
  image: 'mb.lb.image',
  pdf: 'PDF',
}

/** 段控件文案：预览侧刻意写成「近似排版」，避免用户把它当成投稿用的真实分页 */
export const VIEW_LABEL: Record<PreviewMode, string> = {
  source: 'mb.lb.viewSource',
  rich: 'mb.lb.viewRich',
  pdf: 'mb.lb.viewPdf',
  log: 'mb.lb.viewLog',
}

export const ENGINE_LABEL: Record<EngineName, string> = {
  builtin: 'mb.lb.engineBuiltin',
  xelatex: 'mb.lb.engineXelatex',
  pdflatex: 'mb.lb.enginePdflatex',
  lualatex: 'mb.lb.engineLualatex',
}

/** 内置 wasm 引擎的预热状态 → 人话（语义对齐 App 的 app.engine* 文案） */
export const ENGINE_STATUS_LABEL: Record<string, string> = {
  idle: 'mb.lb.stIdle',
  loading: 'mb.lb.stLoading',
  warming: 'mb.lb.stWarming',
  busy: 'mb.lb.stBusy',
  ready: 'mb.lb.stReady',
  error: 'mb.lb.stError',
}

/** 版本来源：沿用桌面约定 t('hist.' + reason)，缺省 auto，两端同一套词表 */
export const reasonKey = (reason?: string) => 'hist.' + (reason || 'auto')

export const SEVERITY_LABEL = {
  error: { textKey: 'mb.lb.sevError', color: 'danger' },
  warn: { textKey: 'mb.lb.sevWarn', color: 'warning' },
} as const

export const DIFF_LAYOUT_LABEL = {
  inline: 'mb.lb.diffInline',
  side: 'mb.lb.diffSide',
} as const

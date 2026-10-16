/**
 * PaperLite Mobile · 跨 flow 共用类型
 * 字段形状对齐桌面实现：
 *   lint 问题 ← src/engines/linter.js
 *   编译结果 ← src/engines/xelatex.js（{ ok, log, errors, engine, cancelled }）
 *   历史快照 ← src/historyStorage.js（{ id, date, text, label, reason }）
 */

export type DocKind = 'tex' | 'md' | 'image' | 'pdf'

/**
 * 顶栏保存态徽标。取值对齐 i18n 的 save.* 六态：
 * browser-saved / browser-pending / disk-saved / disk-dirty / saving / failed
 */
export type SaveState = 'browser-saved' | 'browser-pending' | 'disk-saved' | 'disk-dirty' | 'saving' | 'failed'

/** 工作区段控件：源码 ⇄ 排版；pdf / log 是编译结果态，不属于视图切换 */
export type WorkspaceView = 'source' | 'rich'
export type PreviewMode = WorkspaceView | 'pdf' | 'log'

export type EngineName = 'builtin' | 'xelatex' | 'pdflatex' | 'lualatex'

export interface DocumentMeta {
  id: string
  name: string
  kind: DocKind
  /** 所属文件夹名；null = 浏览器内草稿（无本机文件夹） */
  folder: string | null
  saveState: SaveState
  words: number
  updatedAt: number
  /** 上次离开时的滚动位置（px），用于 ↩ Abandon 后恢复 */
  scrollY: number
}

export interface OutlineItem {
  level: 1 | 2 | 3
  text: string
  /** 源码行号，点击跳段 */
  line: number
}

/** 与 linter.js 产出一致 */
export interface Issue {
  line: number
  msg: string
  severity: 'error' | 'warn'
  kind: 'env' | 'brace' | 'math' | 'ref'
}

/** 与 xelatex.js parseLog() 产出一致：line 为 null 表示引擎级失败 */
export interface CompileError {
  line: number | null
  msg: string
}

export interface CompileConfig {
  engine: EngineName
  mainFile: string
  /** XeLaTeX 需要一并上传的 \input/\include 子文件 */
  includedFiles: string[]
  /** 只编当前文档（章节文件常缺导言区）还是整项目 */
  scope: 'current' | 'project'
}

export interface CompileOutcome {
  ok: boolean
  engine: EngineName
  elapsedMs: number
  pdfUrl: string | null
  pageCount: number
  log: string
  errors: CompileError[]
  cancelled?: boolean
  /** 编译时的源码快照；与当前文档不一致即「PDF 已过期」（对齐 App.jsx 的 compileResult.source !== activeValue） */
  source?: string
}

export interface EngineState {
  name: EngineName
  available: boolean
  /** 不可用时给用户的降级说明 */
  note: string
}

/** 与 historyStorage.js recordVersion() 产出一致 */
export interface HistoryVersion {
  id: string
  date: number
  text: string
  label: string
  reason: 'auto' | 'manual' | 'before-restore'
}

export interface DiffLine {
  sign: '+' | '-' | ' '
  oldNo: number | null
  newNo: number | null
  text: string
}

export interface StorageQuota {
  usedBytes: number
  quotaBytes: number
  /** 低于该值时历史 Sheet 顶部显示配额预警 */
  warnAtBytes: number
}

/** 与 src/historyStorage.js 的 historyUsage() 返回一致（真实配额信号） */
export interface HistoryUsage {
  bytes: number
  maxBytes: number
  versions: number
  files: number
  fileVersions: number
}

export interface RestorePrompt {
  /** 冷启动时检测到的未保存标签数 */
  pendingTabs: Array<{ id: string; name: string; words: number }>
  folderName: string | null
}

export type NetworkState = 'online' | 'offline' | 'slow'

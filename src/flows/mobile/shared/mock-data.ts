import type {
  CompileOutcome,
  DiffLine,
  DocumentMeta,
  EngineState,
  HistoryVersion,
  Issue,
  OutlineItem,
  RestorePrompt,
  StorageQuota,
} from './types'

const DAY = 86_400_000
const NOW = Date.now()

/** 模板锚点：与 src/engines/samples.js 的 { demo, flow, blank } 一一对应 */
export const mockTemplates = [
  { id: 'demo', name: '论文示例', note: 'ctexart + BiLSTM-Att 情感分析，含图与表' },
  { id: 'flow', name: '流程图示例', note: 'TikZ 决策框 + Mermaid 块' },
  { id: 'blank', name: '空白文档', note: '仅 documentclass 与导言区' },
] as const

export const mockDocuments: DocumentMeta[] = [
  { id: 'd1', name: '第三章-方法设计.tex', kind: 'tex', folder: '毕业论文', saveState: 'disk-dirty', words: 3_812, updatedAt: NOW - 6 * 60_000, scrollY: 1_240 },
  { id: 'd2', name: '参考文献.bib', kind: 'tex', folder: '毕业论文', saveState: 'disk-saved', words: 940, updatedAt: NOW - 42 * 60_000, scrollY: 0 },
  { id: 'd3', name: '摘要-中英文.md', kind: 'md', folder: null, saveState: 'browser-saved', words: 320, updatedAt: NOW - 3 * 3_600_000, scrollY: 210 },
  { id: 'd4', name: '技术路线图.png', kind: 'image', folder: '毕业论文', saveState: 'disk-saved', words: 0, updatedAt: NOW - 1 * DAY, scrollY: 0 },
  { id: 'd5', name: '盲审意见回复.tex', kind: 'tex', folder: null, saveState: 'failed', words: 1_105, updatedAt: NOW - 2 * DAY, scrollY: 660 },
  { id: 'd6', name: '文献综述-草稿.tex', kind: 'tex', folder: null, saveState: 'browser-pending', words: 6_240, updatedAt: NOW - 5 * DAY, scrollY: 0 },
]

export const mockFolders = [
  { name: '毕业论文', docCount: 14, lastOpenedAt: NOW - 6 * 60_000, writable: true },
  { name: '课程论文', docCount: 5, lastOpenedAt: NOW - 9 * DAY, writable: false },
]

/** 导入 Sheet 的可选文件（webkitdirectory / 多选降级路径的产物） */
export const mockImportable = [
  { name: 'main.tex', kind: 'tex' as const, size: 18_204, picked: true },
  { name: 'method.tex', kind: 'tex' as const, size: 32_991, picked: true },
  { name: 'refs.bib', kind: 'tex' as const, size: 7_512, picked: false },
  { name: 'fig-arch.svg', kind: 'image' as const, size: 41_003, picked: false },
  { name: '盲审终稿.pdf', kind: 'pdf' as const, size: 1_284_920, picked: false },
]

export const mockOutline: OutlineItem[] = [
  { level: 1, text: '1 引言', line: 41 },
  { level: 2, text: '1.1 研究背景', line: 43 },
  { level: 2, text: '1.2 本文贡献', line: 58 },
  { level: 1, text: '2 相关工作', line: 71 },
  { level: 1, text: '3 方法设计', line: 96 },
  { level: 2, text: '3.1 预处理管线', line: 98 },
  { level: 2, text: '3.2 BiLSTM-Att 模型', line: 132 },
  { level: 3, text: '3.2.1 注意力权重', line: 149 },
  { level: 1, text: '4 实验', line: 188 },
]

export const mockIssues: Issue[] = [
  { line: 132, msg: '环境 mismatch：\\begin{equation} 在 132 行，但 \\end{equation} 出现在 118 行', severity: 'error', kind: 'env' },
  { line: 149, msg: '缺少右花括号（仍有 1 层未闭合）', severity: 'error', kind: 'brace' },
  { line: 76, msg: '该行 $ 数量为奇数，公式可能未闭合', severity: 'warn', kind: 'math' },
  { line: 202, msg: '\\ref{tab:ablation} 无对应 \\label', severity: 'warn', kind: 'ref' },
]

/** 工作区源码屏的编辑内容（截自 samples.js 的 DEMO 导言区 + 方法节） */
export const mockSource = [
  '\\documentclass[12pt]{ctexart}',
  '\\usepackage{booktabs,amsmath,graphicx}',
  '\\newcommand{\\model}{BiLSTM-Att}',
  '',
  '\\title{基于 \\model{} 的中文影评情感分析系统设计与实现}',
  '\\author{罗西 \\\\ 某某大学 计算机学院}',
  '',
  '\\begin{abstract}',
  '针对现有英文情感分析模型在中文口语化影评上迁移效果差的问题，',
  '本文提出 \\model{}：在 BiLSTM 编码层上叠加加性注意力，并用领域词典做输入增强。',
  '\\end{abstract}',
  '',
  '\\section{方法设计}',
  '设词序列为 $X=\\{x_1,\\dots,x_n\\}$，编码后隐藏状态记为 $h_i$。',
  '\\begin{equation}',
  '  a_i = \\mathbf{v}^{\\top} \\tanh(W h_i + b), \\quad \\alpha_i = \\frac{\\exp(a_i)}{\\sum_j \\exp(a_j)}',
  '\\end{equation}',
].join('\n')

/** 排版预览屏的语义块（由 flow 渲染成纸面，而非塞死 HTML） */
export const mockPaperBlocks = [
  { type: 'title' as const, text: '基于 BiLSTM-Att 的中文影评情感分析系统设计与实现' },
  { type: 'meta' as const, text: '罗西 · 某某大学 计算机学院 · 2026 年 10 月' },
  { type: 'heading' as const, level: 2, text: '摘要' },
  { type: 'para' as const, indent: true, text: '针对现有英文情感分析模型在中文口语化影评上迁移效果差的问题，本文提出 BiLSTM-Att：在 BiLSTM 编码层上叠加加性注意力，并用领域词典做输入增强。' },
  { type: 'heading' as const, level: 2, text: '3 方法设计' },
  { type: 'para' as const, indent: true, text: '设词序列为 X = {x₁, …, xₙ}，编码后隐藏状态记为 hᵢ，则注意力权重按下式归一化：' },
  { type: 'formula' as const, text: 'aᵢ = vᵀ tanh(W hᵢ + b),  αᵢ = exp(aᵢ) / Σⱼ exp(aⱼ)' },
  { type: 'figure' as const, caption: '图 3-1 预处理管线：分词 → 停用词过滤 → 领域词典增强', width: 640 },
  { type: 'table' as const, caption: '表 4-2 消融实验（准确率 %）', rows: [['模型', '准确率'], ['BiLSTM', '81.4'], ['+ 注意力', '85.2'], ['+ 领域词典', '88.7']] },
]

/** 近似排版引擎的降级信号，文案对齐 i18n 的 render.* （engines/latex.js 的 ctx.warn） */
export const mockRenderWarnings = [
  '不支持的命令 \\myimme',
  '公式渲染失败: Expected & in tabular',
  '未定义的引用: fig:pipeline',
]

export const mockEngines: EngineState[] = [
  { name: 'builtin', available: true, note: '网页排版：公式与图实时渲染，不产出真实分页 PDF' },
  { name: 'xelatex', available: true, note: '本机 TeX 服务（server.mjs /api/compile），需局域网可达' },
  { name: 'pdflatex', available: false, note: '未检测到 TeX 发行版，中文需改用 xelatex' },
  { name: 'lualatex', available: false, note: '未检测到 TeX 发行版' },
]

export const mockCompileRunning: CompileOutcome = {
  ok: false, engine: 'xelatex', elapsedMs: 0, pdfUrl: null, pageCount: 0, log: '', errors: [],
}

/** 上次编译时的源码快照：与当前 mockSource 不同 → PDF 已过期 */
export const mockSourceSnapshot = mockSource.replace(
  '  a_i = \\mathbf{v}^{\\top} \\tanh(W h_i + b), \\quad \\alpha_i = \\frac{\\exp(a_i)}{\\sum_j \\exp(a_j)}',
  '  a_i = \\mathbf{v}^{\\top} \\tanh(W h_i + b)',
)

export const mockCompileOk: CompileOutcome = {
  ok: true,
  engine: 'xelatex',
  elapsedMs: 2_005,
  pdfUrl: 'blob:paperlite/main-7f3c.pdf',
  pageCount: 12,
  log: 'This is XeTeX, Version 3.1415926 (TeX Live 2024)\nOutput written on main.pdf (12 pages).\n',
  errors: [],
  source: mockSourceSnapshot,
}

export const mockCompileFail: CompileOutcome = {
  ok: false,
  engine: 'xelatex',
  elapsedMs: 1_318,
  pdfUrl: null,
  pageCount: 0,
  log: [
    '! LaTeX Error: Environment equation undefined.',
    'l.132 \\begin{equation}',
    '! Missing } inserted.',
    'l.149 \\alpha_i = \\frac{\\exp(a',
    '(job aborted: 2 fatal errors)',
  ].join('\n'),
  errors: [
    { line: 132, msg: 'Environment equation undefined（\\begin 与 \\end 顺序反了）' },
    { line: 149, msg: 'Missing } inserted.' },
  ],
}

/**
 * 只编译当前章节文件（没有导言区）时的失败形态：
 * 既有引擎级错误（line 为 null），也有可跳行的行级错误 —— 覆盖两种展示分支。
 * 必须声明在 mockCompileFail 之后，否则模块初始化时读不到（TDZ）。
 */
export const mockCompileFailSingle: CompileOutcome = {
  ...mockCompileFail,
  elapsedMs: 742,
  errors: [{ line: null, msg: 'Missing \\documentclass —— 单文件编译缺少导言区与宏包' }, ...mockCompileFail.errors],
}

/** 对齐 historyStorage.js：maxBytes = HISTORY_LIMITS.characters * 2 = 2,000,000 */
export const mockHistoryUsage = {
  bytes: 1_384_200,
  maxBytes: 2_000_000,
  versions: 63,
  files: 7,
  fileVersions: 5,
}

export const mockVersions: HistoryVersion[] = [
  { id: 'v5', date: NOW - 4 * 60_000, text: '', label: '补完 3.2 注意力推导', reason: 'manual' },
  { id: 'v4', date: NOW - 55 * 60_000, text: '', label: '', reason: 'auto' },
  { id: 'v3', date: NOW - 6 * 3_600_000, text: '', label: '导师批注后改写摘要', reason: 'manual' },
  { id: 'v2', date: NOW - 1 * DAY, text: '', label: '', reason: 'auto' },
  { id: 'v1', date: NOW - 2 * DAY, text: '', label: '初稿框架', reason: 'manual' },
]

export const mockDiff: DiffLine[] = [
  { sign: ' ', oldNo: 128, newNo: 128, text: '\\section{方法设计}' },
  { sign: '-', oldNo: 129, newNo: null, text: '设词序列为 $X$，编码后隐藏状态记为 $h_i$。' },
  { sign: '+', oldNo: null, newNo: 129, text: '设词序列为 $X=\\{x_1,\\dots,x_n\\}$，编码后隐藏状态记为 $h_i$。' },
  { sign: ' ', oldNo: 130, newNo: 130, text: '' },
  { sign: '-', oldNo: 131, newNo: null, text: '% 注意力公式待补' },
  { sign: '+', oldNo: null, newNo: 131, text: '\\begin{equation}' },
  { sign: '+', oldNo: null, newNo: 132, text: '  a_i = \\mathbf{v}^{\\top} \\tanh(W h_i + b)' },
  { sign: '+', oldNo: null, newNo: 133, text: '\\end{equation}' },
]

export const mockQuota: StorageQuota = {
  usedBytes: 71_699_456,
  quotaBytes: 104_857_600,
  warnAtBytes: 83_886_080,
}

export const mockRestorePrompt: RestorePrompt = {
  folderName: '毕业论文',
  pendingTabs: [
    { id: 'd1', name: '第三章-方法设计.tex', words: 3_812 },
    { id: 'd3', name: '摘要-中英文.md', words: 320 },
  ],
}

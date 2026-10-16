// =============================================
// FLOW: Mobile Edit & Live Preview (4 screens)
// Scenario: Mobile Productivity（适配到 LaTeX 写作工具）
//   锚点 = Canonical Flow 3「日视图核心容器屏」
//   差异 = ① 核心容器不是时间轴，而是「源码 ⇄ 近似排版」双视图栈
//          ② 新增软键盘避让与就地跳段（任务管理无此矛盾）
//          ③ 工具带从桌面 113px 换行改为单行横滑（audit-3 实测溢出到 630px）
// Platform: H5 (Ant Design Mobile)
// =============================================

import { type CSSProperties, type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActionSheet,
  Button,
  Input,
  List,
  NavBar,
  NoticeBar,
  Popup,
  Segmented,
  Selector,
  Tag,
  TextArea,
  Toast,
  type TextAreaRef,
} from 'antd-mobile'
import {
  AddOutline,
  ClockCircleOutline,
  ContentOutline,
  EditSOutline,
  MoreOutline,
  PictureOutline,
  PlayOutline,
  RedoOutline,
  UndoOutline,
  UnorderedListOutline,
} from 'antd-mobile-icons'
import { useNavigate, useParams } from 'react-router-dom'
import { useKeyboardInset, useLongPress } from './shared/hooks'
import { SAVE_STATE, VIEW_LABEL } from './shared/labels'
import { formatBytes } from './shared/format'
import { mockIssues, mockOutline, mockPaperBlocks, mockQuota, mockRenderWarnings, mockSource } from './shared/mock-data'
import type { DocumentMeta, OutlineItem, SaveState, WorkspaceView } from './shared/types'

/** 桌面 #toolbelt 的 18 个按钮在 390px 会换行成 113px 高，移动端只保留高频 11 项 */
const TOOLS = [
  { id: 'undo', label: '撤销', icon: <UndoOutline /> },
  { id: 'redo', label: '重做', icon: <RedoOutline /> },
  { id: 'bold', label: '加粗', icon: <b>B</b> },
  { id: 'italic', label: '斜体', icon: <i>I</i> },
  { id: 'math', label: '公式', icon: <span>$x$</span> },
  { id: 'symbols', label: '符号', icon: <span>Ω</span> },
  { id: 'ref', label: '引用', icon: <ContentOutline /> },
  { id: 'table', label: '表格', icon: <span>▥</span> },
  { id: 'figure', label: '图表', icon: <PictureOutline /> },
  { id: 'outline', label: '大纲', icon: <UnorderedListOutline /> },
  { id: 'insert', label: '插入', icon: <AddOutline /> },
  // 顶栏已有「编译」，底部再放一次：主操作不能只落在单手持机的拇指盲区（顶部 1/3）
  { id: 'compile', label: '编译', icon: <PlayOutline /> },
] as const

/** 工具带上一键插入的高频片段；符号/引用/表格/图表走插入 Sheet 的多选路径 */
const SNIPPETS: Record<string, string> = {
  bold: '\\textbf{加粗文字}',
  italic: '\\textit{斜体文字}',
  math: '$\\alpha_i$',
}

const FIGURE_SNIPPET = '\\includegraphics[width=0.9\\linewidth]{fig-arch.png}'

const SYMBOLS = ['α', 'β', 'γ', 'δ', 'ε', 'θ', 'λ', 'μ', 'π', 'σ', 'ω', '∑', '∏', '∫', '√', '≤', '≥', '≠', '≈', '∞', '∈', '⊂', '∀', '∃']

/** 段落跳源码用：近似排版块按源码顺序排布，索引即锚点行 */
const BLOCK_LINES = [21, 22, 23, 25, 27, 29, 31, 34, 38]

/**
 * 长按预览段落：桌面靠 hover 出工具条（audit-23：触屏与键盘用户都拿不到），
 * 移动端改为长按就地菜单。
 */
function PreviewBlock({
  block,
  line,
  selected,
  onTap,
  onLongPress,
}: {
  block: (typeof mockPaperBlocks)[number]
  line: number
  selected: boolean
  onTap: (line: number) => void
  onLongPress: (line: number) => void
}) {
  const { handlers, consumeClick } = useLongPress(() => onLongPress(line))

  const inner = () => {
    if (block.type === 'title') return <h2 style={{ textIndent: 0 }}>{block.text}</h2>
    if (block.type === 'meta') return <p className="pl-meta">{block.text}</p>
    if (block.type === 'heading') return block.level === 2 ? <h2>{block.text}</h2> : <h3>{block.text}</h3>
    if (block.type === 'formula') return <div className="pl-formula">{block.text}</div>
    if (block.type === 'figure') {
      return (
        <div>
          <div className="pl-figure">
            <div
              style={{
                minWidth: 320,
                height: 120,
                display: 'grid',
                placeItems: 'center',
                border: '1px dashed var(--edge)',
                background: 'var(--doc-block-bg)',
                color: 'var(--ink-faint)',
              }}
            >
              图（横向可滚动 · {block.width}px）
            </div>
          </div>
          <p className="pl-caption">{block.caption}</p>
        </div>
      )
    }
    if (block.type === 'table') {
      return (
        <div>
          <table>
            <thead>
              <tr>
                {block.rows[0].map(cell => (
                  <th key={cell}>{cell}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.slice(1).map(row => (
                <tr key={row.join('|')}>
                  {row.map(cell => (
                    <td key={cell}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="pl-caption">{block.caption}</p>
        </div>
      )
    }
    return <p style={block.indent ? undefined : { textIndent: 0 }}>{block.text}</p>
  }

  return (
    <div
      className={'pl-para' + (selected ? ' pl-para-selected' : '')}
      {...handlers}
      onClick={() => {
        // 长按已弹就地菜单，吞掉抬起补发的 click
        if (consumeClick()) return
        onTap(line)
      }}
    >
      {inner()}
    </div>
  )
}

/* ================================================
   FLOW: Mobile Edit & Live Preview
   SCREEN 1 of 4: 工作区 · 源码
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  文稿根页点行 / 新建草稿「完成」/ Segmented 切到「源码」
   EXIT:   输入即改，停顿后落 IndexedDB；「编译」→ Flow 3 Screen 1
   BRANCH: Segmented → Screen 2；工具带「大纲」→ Screen 3；「插入/符号/表格/引用」→ Screen 4
   ================================================ */
function Screen1_SourceEditor({
  editorRef,
  source,
  onSourceChange,
  pendingLine,
  fontSize,
  onCaretLine,
}: {
  editorRef: RefObject<TextAreaRef>
  source: string
  onSourceChange: (value: string) => void
  pendingLine: number | null
  fontSize: number
  onCaretLine: (line: number | null) => void
}) {
  // STATE: default — 光标在可视区，行号 gutter 隐藏（窄屏行号吃掉 28px）
  // STATE: typing — 键盘弹起，--pl-keyboard 让编辑区高度收缩、工具带贴键盘
  // STATE: error — 存在 error 级诊断时顶部常驻黄条，不阻断继续输入
  // STATE: loading — 无（源码本地即时，渲染在 Screen 2）
  const hasError = mockIssues.some(i => i.severity === 'error')

  // 近似行高 = 内容高度 / 行数，用于把大纲/预览跳过来的行号滚进可视区
  useEffect(() => {
    if (pendingLine === null) return
    const node = editorRef.current?.nativeElement
    if (!node) return
    const lines = node.value.split('\n').length
    const lineHeight = node.scrollHeight / Math.max(1, lines)
    node.scrollTop = Math.max(0, (pendingLine - 1) * lineHeight - node.clientHeight / 3)
    node.focus()
    onCaretLine(null)
  }, [pendingLine, editorRef, onCaretLine])

  return (
    <>
      {hasError && (
        <NoticeBar
          color="alert"
          wrap
          content={`${mockIssues.filter(i => i.severity === 'error').length} 个错误会影响真实编译，可点「编译」查看逐错跳行。`}
        />
      )}
      <div className="pl-editor">
        <TextArea
          ref={editorRef}
          value={source}
          onChange={onSourceChange}
          rows={20}
          enterKeyHint="enter"
          style={{ '--font-size': `${fontSize}px` }}
          placeholder="\\begin{document}"
        />
      </div>
    </>
  )
}

// → Segmented 切「近似排版」→ SCREEN 2: 工作区 · 近似排版
// → 工具带「大纲」→ SCREEN 3: 大纲 & 跳段 Sheet
// → 工具带「插入」/「符号」/「表格」/「引用」/「图表」→ SCREEN 4: 快捷插入 Sheet

/* ================================================
   FLOW: Mobile Edit & Live Preview
   SCREEN 2 of 4: 工作区 · 近似排版
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  Screen 1 的 Segmented 切到「近似排版」，或长按预览段落后「用源码编辑」
   EXIT:   长按段落 → 就地菜单 → 跳回源码指定行
   BRANCH: 「编译」→ Flow 3；NoticeBar「差异说明」可关闭
   ================================================ */
function Screen2_RichPreview({
  scale,
  onScaleChange,
  onTapBlock,
  onLongPressBlock,
  selectedLine,
}: {
  scale: 'small' | 'normal' | 'large'
  onScaleChange: (value: 'small' | 'normal' | 'large') => void
  onTapBlock: (line: number) => void
  onLongPressBlock: (line: number) => void
  selectedLine: number | null
}) {
  const [rendering, setRendering] = useState(true)
  const [showDisclaimer, setShowDisclaimer] = useState(true)

  // 首次切到排版视图要渲染公式与图，给一个明确的加载态而不是白屏
  useEffect(() => {
    setRendering(true)
    const timer = window.setTimeout(() => setRendering(false), 450)
    return () => clearTimeout(timer)
  }, [])

  const firstError = mockIssues.find(i => i.severity === 'error')

  // STATE: loading — 渲染中占位
  // STATE: default — 单栏纸面 + 字号三档
  // STATE: error — 有 error 级诊断时在对应位置插红卡，说明「近似排版通过、真实编译可能失败」
  if (rendering) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--ink-faint)' }}>
        正在按 LaTeX 子集排版…
      </div>
    )
  }

  return (
    <>
      {showDisclaimer && (
        <NoticeBar
          closeable
          onClose={() => setShowDisclaimer(false)}
          color="info"
          wrap
          content="网页预览按 LaTeX 常用子集近似渲染：双栏分页、bibtex、自定义宏包与复杂 TikZ 一律以「编译」后的 PDF 为准。"
        />
      )}

      {/* 降级态：近似排版跳过的命令，桌面只在预览条提示，移动端必须常驻（不阻断继续写） */}
      {mockRenderWarnings.length > 0 && (
        <NoticeBar
          color="alert"
          wrap
          content={`近似排版跳过了 ${mockRenderWarnings.length} 处，例如「${mockRenderWarnings[0]}」；以「编译」后的 PDF 为准。`}
        />
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--chrome)' }}>
        <span style={{ color: 'var(--ink-soft)', fontSize: 12 }}>字号</span>
        <Segmented
          value={scale}
          onChange={v => onScaleChange(v as 'small' | 'normal' | 'large')}
          options={[
            { label: '小', value: 'small' },
            { label: '标准', value: 'normal' },
            { label: '大', value: 'large' },
          ]}
        />
      </div>

      <div className="pl-paper" data-scale={scale}>
        {mockPaperBlocks.map((block, index) => {
          const line = BLOCK_LINES[index] ?? fallbackLine(index)
          if (firstError && index === 5) {
            return (
              <div key={`err-${line}`} className="pl-error-card">
                第 {firstError.line} 行：{firstError.msg}
                <div style={{ marginTop: 6, opacity: 0.8 }}>近似排版忽略该错误继续渲染，真实编译会中断。</div>
              </div>
            )
          }
          return (
            <PreviewBlock
              key={`${block.type}-${line}`}
              block={block}
              line={line}
              selected={selectedLine === line}
              onTap={onTapBlock}
              onLongPress={onLongPressBlock}
            />
          )
        })}
      </div>
    </>
  )
}

/** 块数多于锚点时按行号外推，保证长按总能跳到一个合理位置 */
function fallbackLine(index: number) {
  return 20 + index * 4
}

{/* → 长按段落 → 就地 Action Sheet → 跳回 SCREEN 1 指定行 */}

/* ================================================
   FLOW: Mobile Edit & Live Preview
   SCREEN 3 of 4: 大纲 & 跳段 Sheet
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  Screen 1/2 工具带「大纲」
   EXIT:   点章节 → 关闭 Sheet 并跳到源码行（Screen 1）
   BRANCH: 下拉关闭 / 点遮罩 → 回原视图，滚动位置不变
   ================================================ */
function OutlineSheet({
  visible,
  currentLine,
  onClose,
  onJump,
}: {
  visible: boolean
  currentLine: number | null
  onClose: () => void
  onJump: (line: number) => void
}) {
  const activeHeading = useMemo(() => {
    if (currentLine === null) return null
    const passed = mockOutline.filter(h => h.line <= currentLine)
    return passed.length ? passed[passed.length - 1] : null
  }, [currentLine])

  const indent = (item: OutlineItem) => (item.level - 1) * 14

  return (
    <Popup
      visible={visible}
      onMaskClick={onClose}
      onClose={onClose}
      position="bottom"
      closeOnSwipe
      showCloseButton
      bodyStyle={{ borderTopLeftRadius: 12, borderTopRightRadius: 12 }}
    >
      <div className="pl-sheet">
        <div className="pl-sheet-head">
          <span>大纲 · {mockOutline.length} 节</span>
          <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
            {activeHeading ? `当前：${activeHeading.text}` : '未在章节内'}
          </span>
        </div>
        <div className="pl-sheet-body">
          <List>
            {mockOutline.map(item => (
              <List.Item
                key={`${item.level}-${item.line}`}
                clickable
                style={{ paddingLeft: `${indent(item)}px` }}
                extra={<span className="pl-num" style={{ color: 'var(--ink-faint)' }}>L{item.line}</span>}
                onClick={() => onJump(item.line)}
              >
                <span style={item.level === 1 ? { fontWeight: 600 } : undefined}>{item.text}</span>
              </List.Item>
            ))}
          </List>
        </div>
      </div>
    </Popup>
  )
}

/* ================================================
   FLOW: Mobile Edit & Live Preview
   SCREEN 4 of 4: 快捷插入 Sheet
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  Screen 1 工具带「插入」，或「符号 / 表格 / 引用 / 图表」直达对应分类
   EXIT:   点片段 → 写入光标处 → 关闭 Sheet，编辑区滚到新位置
   BRANCH: 「取消」/下拉关闭 → 源码不变
   ================================================ */
function InsertSheet({
  visible,
  initialCategory,
  onClose,
  onInsert,
}: {
  visible: boolean
  initialCategory: string
  onClose: () => void
  onInsert: (text: string) => void
}) {
  const [category, setCategory] = useState(initialCategory)
  const [refKey, setRefKey] = useState('')
  const [grid, setGrid] = useState({ rows: 0, cols: 0 })

  useEffect(() => {
    if (visible) setCategory(initialCategory)
  }, [visible, initialCategory])

  const insert = (text: string) => {
    onInsert(text)
    onClose()
  }

  const booktabs = [
    '\\begin{table}[htbp]',
    '  \\centering',
    '  \\begin{tabular}{lrr}',
    '    \\toprule',
    '    模型 & 准确率 & 提升 \\\\',
    '    \\midrule',
    '  \\end{tabular}',
    '\\end{table}',
  ].join('\n')

  const tableSnippet = () => {
    const head = Array.from({ length: grid.cols }, (_, i) => `列${i + 1}`).join(' & ')
    const body = Array.from({ length: grid.rows }, () => Array.from({ length: grid.cols }, () => '   ').join(' & ')).join(' \\\\\n    ')
    return `\\begin{tabular}{${'l'.repeat(grid.cols)}}\n    ${head} \\\\\n    ${body}\n\\end{tabular}`
  }

  return (
    <Popup
      visible={visible}
      onMaskClick={onClose}
      onClose={onClose}
      position="bottom"
      closeOnSwipe
      showCloseButton
      bodyStyle={{ borderTopLeftRadius: 12, borderTopRightRadius: 12 }}
    >
      <div className="pl-sheet">
        <div className="pl-sheet-head">
          <span>插入到光标处</span>
          <Button fill="none" size="small" onClick={onClose}>
            取消
          </Button>
        </div>

        <div style={{ padding: '12px 16px 0' }}>
          <Selector
            columns={3}
            value={[category]}
            onChange={v => setCategory((v[0] as string) ?? 'format')}
            options={[
              { label: '格式', value: 'format' },
              { label: '公式', value: 'math' },
              { label: '符号', value: 'symbols' },
              { label: '引用', value: 'ref' },
              { label: '表格', value: 'table' },
              { label: '图表', value: 'figure' },
            ]}
          />
        </div>

        <div className="pl-sheet-body" style={{ padding: '8px 16px 16px' }}>
          {category === 'format' && (
            <List>
              {[
                { text: '一级标题 \\section', value: '\\section{标题}' },
                { text: '二级标题 \\subsection', value: '\\subsection{标题}' },
                { text: '三级标题 \\subsubsection', value: '\\subsubsection{标题}' },
                { text: '下划线 \\underline', value: '\\underline{文字}' },
                { text: '等宽 \\texttt', value: '\\texttt{code}' },
              ].map(item => (
                <List.Item key={item.value} clickable onClick={() => insert(item.value)}>
                  {item.text}
                </List.Item>
              ))}
            </List>
          )}

          {category === 'math' && (
            <List>
              {[
                { text: '行内公式 $…$', value: '$E=mc^2$' },
                { text: '行间公式 equation', value: '\\begin{equation}\n  \n\\end{equation}' },
                { text: '多行对齐 align', value: '\\begin{align}\n  a &= b \\\\\n  c &= d\n\\end{align}' },
                { text: '分数 \\frac', value: '\\frac{a}{b}' },
                { text: '根号 \\sqrt', value: '\\sqrt{x}' },
              ].map(item => (
                <List.Item key={item.text} clickable onClick={() => insert(item.value)}>
                  {item.text}
                </List.Item>
              ))}
            </List>
          )}

          {category === 'symbols' && (
            <div className="pl-sym-grid">
              {SYMBOLS.map(symbol => (
                <button
                  key={symbol}
                  type="button"
                  className="pl-sym"
                  aria-label={`插入符号 ${symbol}`}
                  onClick={() => insert(`$\\${symbol}$`)}
                >
                  {symbol}
                </button>
              ))}
            </div>
          )}

          {category === 'ref' && (
            <>
              <div style={{ margin: '8px 0' }}>
                <Input
                  placeholder="标签键，例如 sec:introduction"
                  value={refKey}
                  onChange={setRefKey}
                  clearable
                  enterKeyHint="done"
                />
              </div>
              <List>
                {['fig:arch', 'tab:ablation', 'sec:introduction', 'eq:attention'].map(label => (
                  <List.Item key={label} clickable onClick={() => insert(`\\ref{${label}}`)}>
                    已有标签 · {label}
                  </List.Item>
                ))}
              </List>
              {refKey.trim() && (
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <Button block fill="outline" size="small" onClick={() => insert(`\\label{${refKey.trim()}}`)}>
                    插入 \label
                  </Button>
                  <Button block color="primary" size="small" onClick={() => insert(`\\ref{${refKey.trim()}}`)}>
                    插入 \ref
                  </Button>
                </div>
              )}
            </>
          )}

          {category === 'table' && (
            <>
              {/* 桌面靠 onMouseEnter 选 6×6 网格（audit-23：触屏拿不到），移动端改为点选 + 显式确认 */}
              <div style={{ textAlign: 'center', color: 'var(--ink-soft)', fontSize: 12, margin: '8px 0' }}>
                {grid.rows ? `${grid.rows} 行 × ${grid.cols} 列` : '点击格子选择行列数'}
              </div>
              <div className="pl-cell-grid" style={{ justifyContent: 'center' }}>
                {Array.from({ length: 36 }, (_, index) => {
                  const rows = Math.floor(index / 6) + 1
                  const cols = (index % 6) + 1
                  const active = rows <= grid.rows && cols <= grid.cols
                  return (
                    <button
                      key={index}
                      type="button"
                      aria-label={`${rows} 行 ${cols} 列`}
                      onClick={() => setGrid({ rows, cols })}
                      style={{
                        height: 34,
                        border: '1px solid var(--line)',
                        background: active ? 'var(--accent)' : 'var(--paper)',
                      }}
                    />
                  )
                })}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <Button block fill="outline" disabled={!grid.rows} onClick={() => insert(tableSnippet())}>
                  插入普通表
                </Button>
                <Button block color="primary" onClick={() => insert(booktabs)}>
                  插入 booktabs 表
                </Button>
              </div>
            </>
          )}

          {category === 'figure' && (
            <List>
              {[
                { text: '插图 \\includegraphics', value: FIGURE_SNIPPET },
                { text: 'TikZ 流程图 flow', value: '\\begin{figure}\n  \\begin{tikzpicture}\n  \n  \\end{tikzpicture}\n\\end{figure}' },
                { text: 'Mermaid 图（仅网页预览）', value: '\\begin{mermaid}\ngraph TD; A-->B;\n\\end{mermaid}' },
                { text: '参考文献 \\cite', value: '\\cite{ref-key}' },
                { text: '脚注 \\footnote', value: '\\footnote{说明}' },
              ].map(item => (
                <List.Item key={item.text} clickable onClick={() => insert(item.value)}>
                  {item.text}
                </List.Item>
              ))}
            </List>
          )}
        </div>
      </div>
    </Popup>
  )
}

/* ================================================
   FLOW: Mobile Edit & Live Preview · 容器
   持有 view / source / sheets / 键盘避让，按 Segmented 渲染 Screen 1 或 Screen 2
   ================================================ */
export function Flow2_Workspace() {
  const navigate = useNavigate()
  const { docId } = useParams()
  const editorRef = useRef<TextAreaRef>(null)
  const keyboard = useKeyboardInset()

  const [tabs, setTabs] = useState<DocumentMeta[]>(mockTabs())
  const [activeId, setActiveId] = useState(docId ?? 'd1')
  const [source, setSource] = useState(mockSource)
  const [view, setView] = useState<WorkspaceView>('source')
  const [saved, setSaved] = useState(true)
  const [scale, setScale] = useState('normal')
  const [pendingLine, setPendingLine] = useState<number | null>(null)
  const [caretLine, setCaretLine] = useState<number | null>(null)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [insertOpen, setInsertOpen] = useState(false)
  const [insertCategory, setInsertCategory] = useState('format')
  const [blockSheetLine, setBlockSheetLine] = useState<number | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)

  const doc = tabs.find(t => t.id === activeId) ?? tabs[0]
  const saveState: SaveState = saved
    ? doc.folder
      ? 'disk-saved'
      : 'browser-saved'
    : doc.folder
      ? 'disk-dirty'
      : 'browser-pending'

  // 自动保存：桌面是编辑停顿后落 IndexedDB，移动端同样不做每键写盘
  useEffect(() => {
    if (saved) return
    const timer = window.setTimeout(() => setSaved(true), 1200)
    return () => clearTimeout(timer)
  }, [saved, source])

  const jumpToLine = (line: number) => {
    setView('source')
    setPendingLine(line)
    setCaretLine(line)
    setOutlineOpen(false)
    setBlockSheetLine(null)
  }

  const runTool = (id: string) => {
    if (id === 'undo' || id === 'redo') {
      Toast.show({ content: id === 'undo' ? '撤销（接 CodeMirror 历史栈）' : '重做（接 CodeMirror 历史栈）' })
      return
    }
    if (id === 'outline') {
      setOutlineOpen(true)
      return
    }
    if (id === 'compile') {
      navigate(`/m/compile/${doc.id}`)
      return
    }
    if (id === 'insert') {
      setInsertCategory('format')
      setInsertOpen(true)
      return
    }
    if (id in SNIPPETS && SNIPPETS[id]) {
      insertAtCaret(SNIPPETS[id])
      return
    }
    setInsertCategory(id)
    setInsertOpen(true)
  }

  function insertAtCaret(text: string) {
    const node = editorRef.current?.nativeElement
    if (!node) {
      setSource(src => src + '\n' + text)
      setSaved(false)
      return
    }
    const from = node.selectionStart ?? node.value.length
    const to = node.selectionEnd ?? from
    setSource(node.value.slice(0, from) + text + node.value.slice(to))
    setSaved(false)
    // 插入后把光标移到片段末尾，保持移动端「输入继续」而不是回到文末
    requestAnimationFrame(() => {
      node.focus()
      node.setSelectionRange(from + text.length, from + text.length)
    })
  }

  return (
    <div className="pl-screen" style={{ '--pl-keyboard': `${keyboard}px` } as CSSProperties}>
      {/* NavBar 没有 title prop，标题只能走 children（写成 title= 会静默不渲染） */}
      <NavBar
        onBack={() => navigate(-1)}
        right={
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Button color="primary" size="mini" onClick={() => navigate(`/m/compile/${doc.id}`)}>
              编译
            </Button>
            {/* 桌面菜单栏（168px 高、纵向换行）在移动端整体降级为 ⋯ Action Sheet */}
            <Button fill="none" size="mini" aria-label="更多操作" onClick={() => setMoreOpen(true)}>
              <MoreOutline />
            </Button>
          </span>
        }
      >
        <span className="pl-nav-title">
          <span className="pl-nav-name">{doc.name}</span>
          <Tag color={SAVE_STATE[saveState].color} fill="outline">
            {SAVE_STATE[saveState].text}
          </Tag>
        </span>
      </NavBar>

      {/* 打开的标签：桌面 #tabsBar 是固定条，移动端收成单行横滑 chips */}
      <div className="pl-scroll-x" style={{ background: 'var(--chrome)', borderBottom: '1px solid var(--line-soft)' }}>
        {tabs.map(tab => (
          <Button
            key={tab.id}
            size="mini"
            fill={tab.id === activeId ? 'solid' : 'none'}
            color={tab.id === activeId ? 'primary' : 'default'}
            className="pl-tab-chip"
            onClick={() => setActiveId(tab.id)}
          >
            {tab.name}
          </Button>
        ))}
        <Button
          size="mini"
          fill="none"
          className="pl-tab-chip"
          onClick={() => {
            const created: DocumentMeta = {
              id: `d${Date.now()}`,
              name: `草稿-${tabs.length + 1}.tex`,
              kind: 'tex',
              folder: null,
              saveState: 'browser-pending',
              words: 0,
              updatedAt: Date.now(),
              scrollY: 0,
            }
            setTabs(list => [...list, created])
            setActiveId(created.id)
            setSource(mockSource)
            setSaved(false)
          }}
        >
          <AddOutline /> 新标签
        </Button>
      </div>

      <Segmented
        value={view}
        onChange={v => setView(v as WorkspaceView)}
        options={[
          { label: VIEW_LABEL.source, value: 'source' },
          { label: VIEW_LABEL.rich, value: 'rich' },
        ]}
        style={{ margin: '8px 12px', '--segmented-background': 'var(--chrome)' } as CSSProperties}
      />

      {view === 'source' ? (
        <Screen1_SourceEditor
          editorRef={editorRef}
          source={source}
          onSourceChange={value => {
            setSource(value)
            setSaved(false)
          }}
          pendingLine={pendingLine}
          fontSize={14}
          onCaretLine={setPendingLine}
        />
      ) : (
        <Screen2_RichPreview
          scale={scale}
          onScaleChange={setScale}
          onTapBlock={setCaretLine}
          onLongPressBlock={setBlockSheetLine}
          selectedLine={caretLine}
        />
      )}

      {/* 工具带：单行横滑，键盘弹起时贴键盘（--pl-keyboard 由容器写入，Shell 高度同步收缩） */}
      <div className="pl-toolbelt" data-keyboard={keyboard > 0}>
        <div className="pl-scroll-x">
          {TOOLS.map(tool => (
            <button
              key={tool.id}
              type="button"
              className="pl-tool"
              aria-label={tool.label}
              onClick={() => runTool(tool.id)}
            >
              {tool.icon}
              <span>{tool.label}</span>
            </button>
          ))}
        </div>
      </div>

      <OutlineSheet
        visible={outlineOpen}
        currentLine={caretLine}
        onClose={() => setOutlineOpen(false)}
        onJump={jumpToLine}
      />

      <InsertSheet
        visible={insertOpen}
        initialCategory={insertCategory}
        onClose={() => setInsertOpen(false)}
        onInsert={insertAtCaret}
      />

      {/* → 长按预览段落 → 就地 Action Sheet → 跳回 Screen 1 指定行 */}
      <ActionSheet
        visible={blockSheetLine !== null}
        onClose={() => setBlockSheetLine(null)}
        cancelText="取消"
        extra={
          <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--ink-soft)' }}>
            对应源码第 {blockSheetLine ?? 0} 行 · 全文 {source.split('\n').length} 行
          </div>
        }
        actions={[
          {
            key: 'edit',
            text: <span><EditSOutline /> 用源码编辑此段</span>,
            onClick: () => blockSheetLine !== null && jumpToLine(blockSheetLine),
          },
          {
            key: 'copy',
            text: '复制此段文字',
            onClick: () => {
              setBlockSheetLine(null)
              Toast.show({ content: '已复制到剪贴板', icon: 'success' })
            },
          },
          {
            key: 'insert-after',
            text: <span><AddOutline /> 在其后插入</span>,
            onClick: () => {
              setBlockSheetLine(null)
              setInsertCategory('format')
              setInsertOpen(true)
            },
          },
        ]}
      />

      {/* → 顶栏 ⋯ → 桌面「文件/视图/工具」三级菜单的移动端等价物 */}
      <ActionSheet
        visible={moreOpen}
        onClose={() => setMoreOpen(false)}
        cancelText="取消"
        extra={<div style={{ textAlign: 'center' }}>{doc.name}</div>}
        actions={[
          {
            key: 'history',
            text: <span><ClockCircleOutline /> 版本历史</span>,
            onClick: () => {
              setMoreOpen(false)
              navigate(`/m/history/${doc.id}`)
            },
          },
          {
            key: 'quota',
            text: '本机存储用量',
            onClick: () => {
              setMoreOpen(false)
              Toast.show({
                content: `已用 ${formatBytes(mockQuota.usedBytes)} / ${formatBytes(mockQuota.quotaBytes)}`,
              })
            },
          },
          {
            key: 'export',
            text: '导出源码备份',
            onClick: () => {
              setMoreOpen(false)
              Toast.show({ content: '已生成 .tex 下载（走桌面同款 exporter）', icon: 'success' })
            },
          },
        ]}
      />
    </div>
  )
}

function mockTabs() {
  return [
    {
      id: 'd1',
      name: '第三章-方法设计.tex',
      kind: 'tex' as const,
      folder: '毕业论文',
      saveState: 'disk-saved' as const,
      words: 3812,
      updatedAt: Date.now(),
      scrollY: 0,
    },
    {
      id: 'd2',
      name: '参考文献.bib',
      kind: 'tex' as const,
      folder: '毕业论文',
      saveState: 'disk-saved' as const,
      words: 940,
      updatedAt: Date.now(),
      scrollY: 0,
    },
    {
      id: 'd3',
      name: '摘要-中英文.md',
      kind: 'md' as const,
      folder: null,
      saveState: 'browser-saved' as const,
      words: 320,
      updatedAt: Date.now(),
      scrollY: 0,
    },
  ]
}

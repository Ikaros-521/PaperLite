// =============================================
// FLOW: Mobile Edit & Live Preview (4 screens)
// Scenario: Mobile Productivity（适配到 LaTeX 写作工具）
//   锚点 = Canonical Flow 3「日视图核心容器屏」
//   差异 = ① 核心容器是「源码 ⇄ 近似排版」双视图栈，不是时间轴
//          ② 新增软键盘避让与就地跳段
//          ③ 工具带从桌面 113px 换行改为单行横滑
// Platform: H5 (Ant Design Mobile)
// 数据源 = 共享工作区的真实 CodeMirror Doc + 桌面同一套渲染引擎
// =============================================

import { type CSSProperties, useEffect, useMemo, useState } from 'react'
import {
  ActionSheet,
  Button,
  Dialog,
  Input,
  List,
  NavBar,
  NoticeBar,
  Popup,
  Segmented,
  Selector,
  Tag,
  Toast,
} from 'antd-mobile'
import {
  CheckOutline,
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
import EditorPane from '../../components/EditorPane.jsx'
import PreviewPane from '../../components/PreviewPane.jsx'
import { renderLatex } from '../../engines/latex.js'
import { renderMarkdownFull } from '../../engines/markdown.js'
import { lintLaTeX } from '../../engines/linter.js'
import { wordCount } from '../../fileActions.js'
import { tr, getLang } from '../../i18n.js'
import { formatWords } from './shared/format'
import { SAVE_STATE, VIEW_LABEL } from './shared/labels'
import { useKeyboardInset, useLongPress } from './shared/hooks'
import { useMobileWorkspace, type MobileTab } from './mobileWorkspace'

/** 桌面 #toolbelt 有 18 个按钮，390px 会换行成 113px 高；移动端留高频 11 项 */
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
  { id: 'compile', label: '编译', icon: <PlayOutline /> },
] as const

/** 一键插入的片段；符号/表格/引用/图表走插入 Sheet 的多选路径 */
const SNIPPETS: Record<string, string> = {
  bold: '\\textbf{加粗文字}',
  italic: '\\textit{斜体文字}',
  math: '$\\alpha_i$',
}

const SYMBOLS = ['α', 'β', 'γ', 'δ', 'ε', 'θ', 'λ', 'μ', 'π', 'σ', 'ω', '∑', '', '∫', '√', '≤', '≥', '≠', '≈', '∞', '∈', '⊂', '∀', '∃']

/** 近似排版块长按：桌面靠 hover 出工具条，触屏拿不到，改长按就地菜单 */

/* ================================================
   FLOW: Mobile Edit & Live Preview
   SCREEN 1 of 4: 工作区 · 源码（真 CodeMirror）
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  文稿根页点行 / 新建草稿「完成」/ Segmented 切到「源码」
   EXIT:   输入即改，停顿后由共享层落盘；「编译」→ Flow 3 Screen 1
   BRANCH: Segmented → Screen 2；工具带「大纲」→ Screen 3；符号/表格/引用 → Screen 4
   ================================================ */
function Screen1_SourceEditor({ tab }: { tab: MobileTab }) {
  const ws = useMobileWorkspace()
  const keyboard = useKeyboardInset()

  return (
    <div className="pl-editor" data-keyboard={keyboard > 0}>
      {/* STATE: default — 真实 Doc 挂载，语法高亮/括号匹配/撤销栈全部来自 CodeMirror
          STATE: typing — 键盘弹起，容器加高避开软键盘
          STATE: error — 诊断由工具带上方的黄条常驻，不阻断输入 */}
      <EditorPane
        doc={tab.doc as never}
        onChange={(doc: never, value: string) => ws.onDocChange(doc, value)}
        onInit={(cm: unknown) => { ws.cmRef.current = cm }}
      />
    </div>
  )
}

// → Segmented 切「近似排版」→ SCREEN 2: 工作区 · 近似排版
// → 工具带「大纲」→ SCREEN 3
// → 工具带「符号 / 引用 / 表格 / 图表」→ SCREEN 4

/* ================================================
   FLOW: Mobile Edit & Live Preview
   SCREEN 2 of 4: 工作区 · 近似排版（真引擎渲染）
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  Screen 1 的 Segmented，或长按预览段落后「用源码编辑」
   EXIT:   长按段落 → 就地菜单 → 跳回源码指定行
   BRANCH: 「编译」→ Flow 3；差异说明可关闭
   ================================================ */
function Screen2_RichPreview({
  result,
  onLongPress,
}: {
  result: ReturnType<typeof renderLatex> & { isMd?: boolean }
  onLongPress: () => void
}) {
  const { handlers, consumeClick } = useLongPress(onLongPress)

  return (
    <div className="pl-preview-host" {...handlers} onClick={() => { consumeClick() }}>
      {/* STATE: default — 真引擎产出的 HTML（含 KaTeX、TikZ SVG、Mermaid、图片解析）
          STATE: error — 引擎 warnings 常驻黄条；渲染抛错时 html 里是 .render-error
          长按预览区 → 就地菜单回源码（桌面是 hover 工具条，触屏拿不到） */}
      {result.warnings?.length > 0 && (
        <NoticeBar
          color="alert"
          wrap
          content={`近似排版跳过了 ${result.warnings.length} 处，例如「${result.warnings[0]}」；以「编译」后的 PDF 为准。`}
        />
      )}
      <PreviewPane
        result={result}
        zoom={1}
        onZoom={() => {}}
        syncScroll={false}
        onSyncToggle={() => {}}
        onScrollRatio={() => {}}
        selection={{ did: 0, sel: null }}
        engines={[]}
        engine="builtin"
        setEngine={() => {}}
        compiling={false}
        hasCompile={false}
        builtinStatus="ready"
        assetDir={null}
      />
    </div>
  )
}

/* ================================================
   FLOW: Mobile Edit & Live Preview
   SCREEN 3 of 4: 大纲 & 跳段 Sheet（真 headings）
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  工具带「大纲」
   EXIT:   点章节 → 关闭 Sheet 并把光标与滚动定位到该标题
   BRANCH: 下拉关闭 → 回原视图，位置不变
   ================================================ */
function OutlineSheet({
  visible,
  headings,
  onClose,
  onJump,
}: {
  visible: boolean
  headings: Array<{ level: number; text: string; offset: number }>
  onClose: () => void
  onJump: (offset: number) => void
}) {
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
          <span>大纲 · {headings.length} 节</span>
          <Button fill="none" size="small" onClick={onClose}>
            收起
          </Button>
        </div>
        <div className="pl-sheet-body">
          {headings.length === 0 ? (
            <div style={{ padding: 16, color: 'var(--ink-faint)', fontSize: 12 }}>还没有 \\section，写了标题就能跳。</div>
          ) : (
            <List>
              {headings.map((h, index) => (
                <List.Item
                  key={`${h.offset}-${index}`}
                  clickable
                  style={{ paddingLeft: `${(h.level - 1) * 14}px` }}
                  onClick={() => onJump(h.offset)}
                >
                  <span style={h.level === 1 ? { fontWeight: 600 } : undefined}>{h.text}</span>
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
   FLOW: Mobile Edit & Live Preview
   SCREEN 4 of 4: 快捷插入 Sheet（真光标处写入）
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  工具带「符号 / 引用 / 表格 / 图表」
   EXIT:   点片段 → 写入 CodeMirror 光标处并保持焦点
   BRANCH: 「取消」/下拉关闭 → 源码不变
   ================================================ */
function InsertSheet({
  visible,
  initialCategory,
  labels,
  onClose,
  onInsert,
}: {
  visible: boolean
  initialCategory: string
  labels: string[]
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
            onChange={v => setCategory((v[0] as string) || 'format')}
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
                  onClick={() => insert(`$${symbol}$`)}
                >
                  {symbol}
                </button>
              ))}
            </div>
          )}

          {category === 'ref' && (
            <>
              <div style={{ margin: '8px 0' }}>
                <Input placeholder="标签键，例如 sec:introduction" value={refKey} onChange={setRefKey} clearable enterKeyHint="done" />
              </div>
              <List>
                {labels.length ? labels.map(label => (
                  <List.Item key={label} clickable onClick={() => insert(`\\ref{${label}}`)}>
                    已有标签 · {label}
                  </List.Item>
                )) : (
                  <List.Item>文档里还没有 \\label</List.Item>
                )}
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
              <div style={{ textAlign: 'center', color: 'var(--ink-soft)', fontSize: 12, margin: '8px 0' }}>
                {grid.rows ? `${grid.rows} 行 × ${grid.cols} 列` : '点击格子选择行列数'}
              </div>
              <div className="pl-cell-grid">
                {Array.from({ length: 36 }, (_, index) => {
                  const rows = Math.floor(index / 6) + 1
                  const cols = (index % 6) + 1
                  return (
                    <button
                      key={index}
                      type="button"
                      aria-label={`${rows} 行 ${cols} 列`}
                      data-active={rows <= grid.rows && cols <= grid.cols}
                      onClick={() => setGrid({ rows, cols })}
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
                { text: '插图 \\includegraphics', value: '\\includegraphics[width=0.9\\linewidth]{fig-arch.png}' },
                { text: 'TikZ 流程图', value: '\\begin{tikzpicture}\n  \\node[block] (a) {开始};\n\\end{tikzpicture}' },
                { text: 'Mermaid 图（仅网页预览）', value: '\\begin{mermaid}\nflowchart LR; A-->B;\n\\end{mermaid}' },
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
   ================================================ */
export function Flow2_Workspace() {
  const navigate = useNavigate()
  const { docId } = useParams()
  const ws = useMobileWorkspace()
  const keyboard = useKeyboardInset()

  const [view, setView] = useState<'source' | 'rich'>('source')
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [insertOpen, setInsertOpen] = useState(false)
  const [insertCategory, setInsertCategory] = useState('format')
  const [previewMenu, setPreviewMenu] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)

  const tab = useMemo(
    () => ws.tabs.filter(x => String(x.id) === String(docId))[0] || ws.activeTab,
    [ws.tabs, ws.activeTab, docId],
  )

  // 深链进来时先激活该标签，保证 activeValue / 保存态指向同一篇
  useEffect(() => {
    if (tab && tab.id !== ws.activeId) ws.openTab(tab.id)
  }, [tab, ws])

  const cm = () => ws.cmRef.current as {
    getValue: () => string
    replaceSelection: (text: string, select?: string) => void
    setCursor: (pos: { line: number; ch: number }) => void
    scrollIntoView: (range: unknown, margin?: number) => void
    undo: () => void
    redo: () => void
    focus: () => void
    doc: { lineAt: (offset: number) => { lineNumber: number } }
  } | null

  const value = tab?.doc ? tab.doc.getValue() : ''
  const issues = useMemo(() => (tab?.kind === 'md' ? [] : lintLaTeX(value)), [value, tab?.kind])

  // 只渲染一次：预览与大纲共用同一份 result（renderLatex 对长文不便宜）
  const result = useMemo(() => {
    try {
      if (tab?.kind === 'md') return { ...renderMarkdownFull(value), isMd: true } as never
      return renderLatex(value, {}) as never
    } catch (e) {
      return {
        html: '<div class="render-error">' + tr(getLang(), 'app.renderErr') + String((e as Error).message || e) + '</div>',
        warnings: [], headings: [], diagrams: [], stats: { words: 0 },
      } as never
    }
  }, [value, tab?.kind])

  const headings = useMemo(
    () => ((result as { headings?: Array<{ level: number; text: string; offset: number }> })?.headings || []),
    [result],
  )
  const labels = useMemo(() => Array.from(value.matchAll(/\\label\{([^}]+)\}/g)).map(m => m[1]), [value])

  if (!tab || !tab.doc) {
    return (
      <div className="pl-screen">
        <NavBar onBack={() => navigate('/m')}>工作区</NavBar>
        <div className="pl-content" style={{ padding: 16, color: 'var(--ink-soft)' }}>
          这篇稿件已经不在了，可能刚被关掉。回列表重新打开一篇。
        </div>
      </div>
    )
  }

  const state = SAVE_STATE[ws.saveStateOf(tab)]

  const insertAtCaret = (text: string) => {
    const instance = cm()
    if (!instance) {
      Toast.show({ content: '编辑器还没就绪', icon: 'fail' })
      return
    }
    instance.replaceSelection(text, 'around')
    instance.focus()
  }

  const jumpToOffset = (offset: number) => {
    const instance = cm()
    if (!instance) return
    const line = instance.doc.lineAt(offset).lineNumber
    setView('source')
    setOutlineOpen(false)
    requestAnimationFrame(() => {
      instance.setCursor({ line, ch: 0 })
      instance.scrollIntoView({ line, ch: 0 }, 120)
      instance.focus()
    })
  }

  const runTool = (id: string) => {
    const instance = cm()
    if (id === 'undo') { instance?.undo(); return }
    if (id === 'redo') { instance?.redo(); return }
    if (id === 'outline') { setOutlineOpen(true); return }
    if (id === 'compile') { navigate(`/m/compile/${tab.id}`); return }
    if (SNIPPETS[id]) { insertAtCaret(SNIPPETS[id]); return }
    setInsertCategory(id)
    setInsertOpen(true)
  }

  return (
    <div className="pl-screen" style={{ '--pl-keyboard': `${keyboard}px` } as CSSProperties}>
      <NavBar
        onBack={() => navigate('/m')}
        right={
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Button color="primary" size="mini" onClick={() => navigate(`/m/compile/${tab.id}`)}>
              编译
            </Button>
            {/* 桌面菜单栏在移动端整体降级为 ⋯ Action Sheet */}
            <Button fill="none" size="mini" aria-label="更多操作" onClick={() => setMoreOpen(true)}>
              <MoreOutline />
            </Button>
          </span>
        }
      >
        <span className="pl-nav-title">
          <span className="pl-nav-name">{tab.name}</span>
          <Tag color={state.color} fill="outline">
            {state.text}
          </Tag>
        </span>
      </NavBar>

      <Segmented
        value={view}
        onChange={v => setView(v as 'source' | 'rich')}
        options={[
          { label: VIEW_LABEL.source, value: 'source' },
          { label: VIEW_LABEL.rich, value: 'rich' },
        ]}
        style={{ margin: '8px 12px', '--segmented-background': 'var(--chrome)' } as CSSProperties}
      />

      {issues.some(i => i.severity === 'error') && (
        <NoticeBar
          color="alert"
          wrap
          content={`${issues.filter(i => i.severity === 'error').length} 个错误会影响真实编译，可点「编译」查看逐错跳行。`}
        />
      )}

      {view === 'source'
        ? <Screen1_SourceEditor tab={tab} />
        : <Screen2_RichPreview result={result as never} onLongPress={() => setPreviewMenu(true)} />}

      <div className="pl-toolbelt" data-keyboard={keyboard > 0}>
        <div className="pl-scroll-x">
          {TOOLS.map(tool => (
            <button key={tool.id} type="button" className="pl-tool" aria-label={tool.label} onClick={() => runTool(tool.id)}>
              {tool.icon}
              <span>{tool.label}</span>
            </button>
          ))}
        </div>
      </div>

      <OutlineSheet visible={outlineOpen} headings={headings} onClose={() => setOutlineOpen(false)} onJump={jumpToOffset} />

      <InsertSheet
        visible={insertOpen}
        initialCategory={insertCategory}
        labels={labels}
        onClose={() => setInsertOpen(false)}
        onInsert={insertAtCaret}
      />

      {/* → 长按预览区 → 就地菜单（桌面靠 hover 工具条，触屏拿不到） */}
      <ActionSheet
        visible={previewMenu}
        onClose={() => setPreviewMenu(false)}
        cancelText="取消"
        extra={
          <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--ink-soft)' }} className="pl-num">
            {value.split('\n').length} 行 · {formatWords(wordCount(value).total)}
          </div>
        }
        actions={[
          {
            key: 'edit',
            text: <span><EditSOutline /> 回到源码继续改</span>,
            onClick: () => { setPreviewMenu(false); setView('source') },
          },
          {
            key: 'outline',
            text: <span><UnorderedListOutline /> 看大纲跳段</span>,
            onClick: () => { setPreviewMenu(false); setOutlineOpen(true) },
          },
        ]}
      />

      {/* → 顶栏 ⋯ */}
      <ActionSheet
        visible={moreOpen}
        onClose={() => setMoreOpen(false)}
        cancelText="取消"
        extra={<div style={{ textAlign: 'center' }}>{tab.name}</div>}
        actions={[
          {
            key: 'save',
            text: <span><CheckOutline /> 保存</span>,
            onClick: () => {
              setMoreOpen(false)
              ws.saveActive()
            },
          },
          {
            key: 'history',
            text: <span><ClockCircleOutline /> 版本历史</span>,
            onClick: () => {
              setMoreOpen(false)
              navigate(`/m/history/${tab.id}`)
            },
          },
          {
            key: 'export',
            text: '导出源码备份',
            onClick: () => {
              setMoreOpen(false)
              Dialog.confirm({
                title: '导出这篇稿件？',
                content: '会下载当前源码为 .tex，避免浏览器数据被清时丢稿。',
                confirmText: '导出',
                cancelText: '取消',
                onConfirm: () => {
                  const blob = new Blob([value], { type: 'text/plain;charset=utf-8' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = tab.name
                  a.click()
                  URL.revokeObjectURL(url)
                },
              })
            },
          },
        ]}
      />
    </div>
  )
}

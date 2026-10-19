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

import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  TextArea,
  Toast,
} from 'antd-mobile'
import {
  CheckOutline,
  ClockCircleOutline,
  ContentOutline,
  EditSOutline,
  ExclamationTriangleOutline,
  EyeOutline,
  MessageOutline,
  MoreOutline,
  PictureOutline,
  PlayOutline,
  RedoOutline,
  SearchOutline,
  UndoOutline,
  UnorderedListOutline,
} from 'antd-mobile-icons'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import EditorPane from '../../components/EditorPane.jsx'
import PreviewPane from '../../components/PreviewPane.jsx'
import TablePanel from '../../components/TablePanel.jsx'
import { collectLabels, collectBibKeys } from '../../projectIndex.js'
import { PROVIDERS } from '../../citation.js'
import { searchCitations } from '../../citationSearch.js'
import { loadSnippets, saveSnippets, nextSnippetId, validateSnippetName } from '../../snippets.js'
import { collectSearchFiles, searchInFiles } from '../../searchIndex.js'
import * as fs from '../../fs.js'
import { collectUserCommands } from '../../completion.js'
import { renderLatex } from '../../engines/latex.js'
import { renderMarkdownFull } from '../../engines/markdown.js'
import { lintLaTeX } from '../../engines/linter.js'
import { aiFixIssuePrompt } from '../../workspace/chatContext.js'
import { wordCount } from '../../fileActions.js'
import { tr, getLang } from '../../i18n.js'
import { useT } from '../../useI18n.js'
import { formatWords } from './shared/format'
import { SAVE_STATE, VIEW_LABEL } from './shared/labels'
import { useKeyboardInset, useLongPress } from './shared/hooks'
import { useMobileWorkspace, type MobileCiteEntry, type MobileTab } from './mobileWorkspace'

/** 桌面 #toolbelt 有 18 个按钮，390px 会换行成 113px 高；移动端留高频 13 项（单行横滑）
 *  语言运行时可切换，模块顶层不能取文案，这里只存键，渲染时再 t() */
const TOOLS = [
  { id: 'undo', key: 'mb.ed.toolUndo', icon: <UndoOutline /> },
  { id: 'redo', key: 'mb.ed.toolRedo', icon: <RedoOutline /> },
  { id: 'bold', key: 'mb.ed.toolBold', icon: <b>B</b> },
  { id: 'italic', key: 'mb.ed.toolItalic', icon: <i>I</i> },
  { id: 'math', key: 'mb.ed.toolMath', icon: <span>$x$</span> },
  { id: 'symbols', key: 'mb.ed.toolSymbols', icon: <span>Ω</span> },
  { id: 'ref', key: 'mb.ed.toolRef', icon: <ContentOutline /> },
  { id: 'cite', key: 'mb.ed.toolCite', icon: <span>❝</span> },
  { id: 'table', key: 'mb.ed.toolTable', icon: <span>▥</span> },
  { id: 'figure', key: 'mb.ed.toolFigure', icon: <PictureOutline /> },
  { id: 'outline', key: 'mb.ed.toolOutline', icon: <UnorderedListOutline /> },
  { id: 'search', key: 'mb.ed.toolSearch', icon: <SearchOutline /> },
  { id: 'compile', key: 'mb.ed.toolCompile', icon: <PlayOutline /> },
] as const

/** 一键插入的片段；符号/表格/引用/图表走插入 Sheet 的多选路径
 *  片段要写进文档，示例文字随语言变化，所以只能在组件里按当前 t 生成；LaTeX 命令原样不动 */
type Translate = (key: string, params?: Record<string, unknown>) => string
const makeSnippets = (t: Translate): Record<string, string> => ({
  bold: `\\textbf{${t('mb.ed.snBoldText')}}`,
  italic: `\\textit{${t('mb.ed.snItalicText')}}`,
  math: '$\\alpha_i$',
})

const SYMBOLS = ['α', 'β', 'γ', 'δ', 'ε', 'θ', 'λ', 'μ', 'π', 'σ', 'ω', '∑', '', '∫', '√', '≤', '≥', '≠', '≈', '∞', '∈', '⊂', '∀', '∃']

/** 片段形状与 snippets.js 的 localStorage 存取一致，桌面「管理片段」改的也是这份数据 */
interface Snippet {
  id: string
  name: string
  content: string
}

/** 项目搜索的磁盘面：浅层扫 .tex/.bib/.md/.txt（深度 ≤3、单文件 ≤200KB、≤120 个）。
 *  桌面 App 维护常驻 folderIndex；移动端搜索频率低，按需扫一次即可 */
const TEXT_EXT = /\.(tex|bib|md|txt)$/i
async function scanFolderTexts(dir: unknown, prefix = '', depth = 0, out: Array<{ path: string; text: string; handle: unknown }> = []) {
  if (depth > 3 || out.length >= 120) return out
  let entries: Array<{ name: string; kind: string; handle: unknown }>
  try { entries = await fs.listDir(dir as never) as never } catch { return out }
  for (const ent of entries) {
    if (out.length >= 120) break
    const path = prefix + ent.name
    if (ent.kind === 'directory') { await scanFolderTexts(ent.handle, path + '/', depth + 1, out); continue }
    if (!TEXT_EXT.test(ent.name)) continue
    try { out.push({ path, text: await fs.readFileText(ent.handle as never, 200 * 1024), handle: ent.handle }) } catch { /* 超大/二进制跳过 */ }
  }
  return out
}

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

  // 卸载后共享层不能再把这个实例当「当前编辑器」（AI 写回会落到已 detach 的空 Doc 上）
  useEffect(() => () => { ws.cmRef.current = null }, [])

  // 与桌面同一套编辑器增强（EditorPane 本就共享）：\ref/\cite 与命令/环境/文件名补全、
  // 打字机/语法检查读桌面同一份设置键——手机与电脑各自浏览器，互不干扰也互不依赖
  const texLike = tab.kind === 'tex' || tab.kind === 'draft'
  const refCompletion = useMemo(() => {
    const labels: { key: string; src: string }[] = [], bibKeys: { key: string; src: string }[] = []
    const seenL = new Set<string>(), seenB = new Set<string>()
    for (const x of ws.tabs) {
      if (!x.doc) continue
      const text = (x.doc as { getValue: () => string }).getValue()
      const src = x.id === tab.id ? '' : x.name
      for (const l of collectLabels(text)) if (!seenL.has(l.key)) { seenL.add(l.key); labels.push({ key: l.key, src }) }
      for (const k of collectBibKeys(text)) if (!seenB.has(k.key)) { seenB.add(k.key); bibKeys.push({ key: k.key, src }) }
    }
    return { labels, bibKeys }
  }, [ws.tabs, tab.id, tab.doc])
  const completionPool = useMemo(() => {
    const tex = ws.tabs.filter(x => x.kind === 'tex' || x.kind === 'draft').map(x => x.name)
    const image = ws.tabs.filter(x => x.kind === 'image').map(x => x.name)
    const bib = ws.tabs.filter(x => /\.bib$/i.test(x.name)).map(x => x.name)
    return { tex, image, bib }
  }, [ws.tabs])
  const userCommands = useMemo(
    () => collectUserCommands(ws.tabs.filter(x => x.doc).map(x => (x.doc as { getValue: () => string }).getValue())),
    [ws.tabs, tab.doc],
  )
  const [sharedSettings] = useState(() => {
    try { return JSON.parse(localStorage.getItem('paperlite.editor-settings') || '{}') } catch { return {} as Record<string, unknown> }
  })

  return (
    <div className="pl-editor" data-keyboard={keyboard > 0}>
      {/* STATE: default — 真实 Doc 挂载，语法高亮/括号匹配/撤销栈全部来自 CodeMirror
          STATE: typing — 键盘弹起，容器加高避开软键盘
          STATE: error — 诊断由工具带上方的黄条常驻，不阻断输入 */}
      <EditorPane
        doc={tab.doc as never}
        onChange={(doc: never, value: string) => ws.onDocChange(doc, value)}
        onInit={(cm: unknown) => { ws.cmRef.current = cm }}
        spellcheck={texLike || tab.kind === 'md'}
        grammarCheck={sharedSettings.grammarCheck === true && (texLike || tab.kind === 'md')}
        aiProofread={sharedSettings.aiProofread === true && (texLike || tab.kind === 'md')}
        aiChannel={(ws.channels as Array<{ id: string }> || []).filter(c => c.id === ws.activeChannelId)[0] as never}
        typewriter={sharedSettings.typewriter === true}
        refCompletion={refCompletion}
        completion={{ texLike, pool: completionPool, userCommands }}
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
  onJumpOff,
  onSelectTable,
}: {
  result: ReturnType<typeof renderLatex> & { isMd?: boolean }
  onLongPress: () => void
  onJumpOff: (offset: number) => void
  onSelectTable: (id: number) => void
}) {
  const { handlers, consumeClick } = useLongPress(onLongPress)
  const t = useT()

  return (
    <div className="pl-preview-host" {...handlers} onClick={() => { consumeClick() }}>
      {/* STATE: default — 真引擎产出的 HTML（含 KaTeX、TikZ SVG、Mermaid、图片解析）
          STATE: error — 引擎 warnings 常驻黄条；渲染抛错时 html 里是 .render-error
          长按预览区 → 就地菜单回源码（桌面是 hover 工具条，触屏拿不到） */}
      {result.warnings?.length > 0 && (
        <NoticeBar
          color="alert"
          wrap
          content={t('mb.ed.approxSkipped', { n: result.warnings.length, example: result.warnings[0]?.msg })}
        />
      )}
      <PreviewPane
        result={result}
        zoom={1}
        onZoom={() => {}}
        syncScroll={false}
        onSyncToggle={() => {}}
        onScrollRatio={() => {}}
        onJumpOff={onJumpOff}
        onSelectTable={onSelectTable}
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
  const t = useT()

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
          <span>{t('mb.ed.outlineTitle', { n: headings.length })}</span>
          <Button fill="none" size="small" onClick={onClose}>
            {t('mb.ed.outlineCollapse')}
          </Button>
        </div>
        <div className="pl-sheet-body">
          {headings.length === 0 ? (
            <div style={{ padding: 16, color: 'var(--ink-faint)', fontSize: 12 }}>{t('mb.ed.outlineEmpty')}</div>
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
   SHEET: 文献检索（与桌面 CiteDialog 同一网络层与插入策略）
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  工具带「文献」
   EXIT:   点条目 → 生成 BibTeX 追加 .bib + 光标处 \cite（共享 ws.insertCitation）
   ================================================ */
function CiteSheet({
  visible,
  onClose,
  onInsert,
}: {
  visible: boolean
  onClose: () => void
  onInsert: (entry: MobileCiteEntry) => void
}) {
  const t = useT()
  const [provider, setProvider] = useState('crossref')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState<MobileCiteEntry[]>([])
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => { if (visible) { setResults([]); setError('') } }, [visible])
  useEffect(() => () => abortRef.current?.abort(), [])

  const search = async () => {
    const q = query.trim()
    if (!q || loading) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, 15000)
    setLoading(true); setError(''); setResults([])
    try {
      const list = (await searchCitations(provider, q, ctrl.signal)) as MobileCiteEntry[]
      setResults(list)
      if (!list.length) setError(t('cite.empty'))
    } catch (err) {
      // 超时 abort 与用户取消都是 AbortError，不分流的话超时看起来像「没搜到」
      if (timedOut && abortRef.current === ctrl) setError(t('cite.timeout'))
      else if ((err as Error)?.name !== 'AbortError') setError(t('cite.error', { msg: (err as Error)?.message || String(err) }))
    } finally {
      clearTimeout(timer)
      if (abortRef.current === ctrl) setLoading(false)
    }
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
          <span>{t('cite.title')}</span>
          <Button fill="none" size="small" onClick={onClose}>
            {t('dialog.cancel')}
          </Button>
        </div>
        <div className="pl-sheet-body" style={{ padding: '8px 16px 16px' }}>
          <div style={{ fontSize: 12, color: 'var(--ink-faint)', margin: '4px 0 8px' }}>{t('cite.netNote')}</div>
          <Selector
            columns={3}
            value={[provider]}
            onChange={v => { setProvider((v[0] as string) || 'crossref'); setResults([]); setError('') }}
            options={Object.keys(PROVIDERS).map(p => ({ label: t('cite.p_' + p), value: p }))}
          />
          <div style={{ display: 'flex', gap: 8, margin: '10px 0' }}>
            <div style={{ flex: 1 }}>
              <Input value={query} onChange={setQuery} placeholder={t('cite.placeholder')} clearable enterKeyHint="search" onEnterPress={search} aria-label={t('cite.placeholder')} />
            </div>
            <Button color="primary" size="small" loading={loading} disabled={!query.trim() || loading} onClick={search}>
              {loading ? t('cite.searching') : t('cite.search')}
            </Button>
          </div>
          {error && <div style={{ fontSize: 12, color: 'var(--warn-strong)', padding: '4px 0' }}>{error}</div>}
          <List>
            {results.map((e, i) => (
              <List.Item
                key={i}
                clickable
                onClick={() => { onInsert(e); onClose() }}
                description={
                  <span style={{ fontSize: 12 }}>
                    {[
                      e.authors.length > 3 ? e.authors.slice(0, 3).join('；') + t('cite.etAl') : e.authors.join('；'),
                      e.venue,
                      e.year,
                    ].filter(Boolean).join(' · ')}
                  </span>
                }
              >
                <span style={{ fontSize: 14 }}>{e.title}</span>
                <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--ink-faint)' }}>{e.source}</span>
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
   SHEET: 项目内搜索（打开标签 + 文件夹扫描，桌面侧栏面板的移动形态）
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  工具带「搜索」
   EXIT:   点命中 → 打开所在文件并跳到该行（标签间切换用 pendingJump 兜时序）
   ================================================ */
interface GsMatch { path: string; line: number; text: string; from: number; to: number }
interface GsState {
  query: string
  regex: boolean
  matchCase: boolean
  wholeWord: boolean
  busy: boolean
  result: { ok: boolean; matches: GsMatch[]; fileCount: number; truncated: boolean } | null
}

function SearchSheet({
  visible,
  onClose,
  state,
  setState,
  onSearch,
  onOpen,
  hasFolder,
}: {
  visible: boolean
  onClose: () => void
  state: GsState
  setState: (updater: (s: GsState) => GsState) => void
  onSearch: (opts: { query: string; regex: boolean; matchCase: boolean; wholeWord: boolean }) => void
  onOpen: (path: string, line: number) => void
  hasFolder: boolean
}) {
  const t = useT()
  const run = () => onSearch({ query: state.query, regex: state.regex, matchCase: state.matchCase, wholeWord: state.wholeWord })
  const flag = (on: boolean, glyph: string, title: string, key: 'matchCase' | 'wholeWord' | 'regex') => (
    <Button
      key={key}
      size="small"
      fill={on ? 'outline' : 'none'}
      color={on ? 'primary' : 'default'}
      aria-label={title}
      aria-pressed={on}
      style={{ flex: 1, minWidth: 44 }}
      onClick={() => setState(s => ({ ...s, [key]: !s[key] }))}
    >
      {glyph}
    </Button>
  )

  const groups: Array<{ path: string; items: GsMatch[] }> = []
  for (const m of state.result?.matches || []) {
    const last = groups[groups.length - 1]
    if (last && last.path === m.path) last.items.push(m)
    else groups.push({ path: m.path, items: [m] })
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
          <span>{t('gs.title')}</span>
          <Button fill="none" size="small" onClick={onClose}>
            {t('dialog.cancel')}
          </Button>
        </div>
        <div className="pl-sheet-body" style={{ padding: '8px 16px 16px' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <Input
                value={state.query}
                placeholder={t('gs.placeholder')}
                clearable
                enterKeyHint="search"
                onChange={v => setState(s => ({ ...s, query: v }))}
                onEnterPress={run}
                aria-label={t('gs.title')}
              />
            </div>
            <Button color="primary" size="small" loading={state.busy} disabled={!state.query.trim() || state.busy} onClick={run}>
              {t('gs.go')}
            </Button>
          </div>
          <div style={{ display: 'flex', gap: 8, margin: '10px 0 2px' }}>
            {flag(state.matchCase, 'Aa', t('find.case'), 'matchCase')}
            {flag(state.wholeWord, 'ab', t('find.word'), 'wholeWord')}
            {flag(state.regex, '.*', t('find.regex'), 'regex')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-faint)', margin: '4px 0 8px' }}>
            {hasFolder ? t('gs.scope') : t('gs.noFolder')}
          </div>
          {state.result && state.result.ok === false && (
            <div style={{ fontSize: 12, color: 'var(--warn-strong)' }}>{t('find.invalid')}</div>
          )}
          {state.result?.ok && state.result.matches.length === 0 && state.query && (
            <div style={{ fontSize: 12, color: 'var(--ink-soft)', padding: '8px 0' }}>{t('gs.none')}</div>
          )}
          {state.result?.ok && state.result.matches.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
              {t('gs.count', { n: state.result.matches.length, files: state.result.fileCount })}
              {state.result.truncated ? ' · ' + t('gs.truncated') : ''}
            </div>
          )}
          <div style={{ maxHeight: '44vh', overflowY: 'auto', marginTop: 6 }}>
            {groups.map(g => (
              <div key={g.path}>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 600, padding: '8px 0 2px', wordBreak: 'break-all' }}>
                  {g.path} · {g.items.length}
                </div>
                <List>
                  {g.items.map((m, i) => (
                    <List.Item key={i} clickable onClick={() => onOpen(m.path, m.line)}>
                      <span className="pl-num" style={{ marginRight: 8, color: 'var(--ink-faint)' }}>{m.line + 1}</span>
                      <span style={{ wordBreak: 'break-all', fontSize: 13 }}>
                        {m.text.slice(Math.max(0, m.from - 40), m.from)}
                        <mark>{m.text.slice(m.from, m.to)}</mark>
                        {m.text.slice(m.to, m.to + 120)}
                      </span>
                    </List.Item>
                  ))}
                </List>
              </div>
            ))}
          </div>
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
   ENTRY:  工具带「符号 / 引用 / 表格 / 图表 / 我的片段」
   EXIT:   点片段 → 写入 CodeMirror 光标处并保持焦点
   BRANCH: 「取消」/下拉关闭 → 源码不变；「我的片段」分类内可就地增删改
   ================================================ */
function InsertSheet({
  visible,
  initialCategory,
  labels,
  snippets,
  onSnippets,
  onClose,
  onInsert,
}: {
  visible: boolean
  initialCategory: string
  labels: string[]
  snippets: Snippet[]
  /** 受控更新：Flow2 持有片段状态并负责落 localStorage（与桌面共享同一份数据） */
  onSnippets: (updater: (list: Snippet[]) => Snippet[]) => void
  onClose: () => void
  onInsert: (text: string) => void
}) {
  const [category, setCategory] = useState(initialCategory)
  const [refKey, setRefKey] = useState('')
  const [grid, setGrid] = useState({ rows: 0, cols: 0 })
  // 「我的片段」的就地编辑态：null=列表态，非空=新增/编辑表单
  const [editing, setEditing] = useState<Snippet | null>(null)
  const [editError, setEditError] = useState('')
  const t = useT()

  useEffect(() => {
    if (visible) setCategory(initialCategory)
    else { setEditing(null); setEditError('') }
  }, [visible, initialCategory])

  const saveSnippetEdit = () => {
    if (!editing) return
    const v = validateSnippetName(editing.name, snippets, editing.id || undefined)
    if (!v.ok) { setEditError(t(v.error === 'empty' ? 'sn.nameEmpty' : 'sn.nameDup')); return }
    const clean = { id: editing.id || nextSnippetId(), name: v.name, content: editing.content }
    onSnippets(list => (editing.id ? list.map(s => (s.id === editing.id ? clean : s)) : list.concat([clean])))
    setEditing(null)
    setEditError('')
  }

  const deleteSnippet = (s: Snippet) => {
    Dialog.confirm({
      title: t('dialog.alert'),
      content: t('sn.delConfirm', { name: s.name }),
      confirmText: t('sn.del'),
      cancelText: t('dialog.cancel'),
      onConfirm: () => onSnippets(list => list.filter(x => x.id !== s.id)),
    })
  }

  const insert = (text: string) => {
    onInsert(text)
    onClose()
  }

  const booktabs = [
    '\\begin{table}[htbp]',
    '  \\centering',
    '  \\begin{tabular}{lrr}',
    '    \\toprule',
    `    ${t('mb.ed.threeHead')} \\\\`,
    '    \\midrule',
    '  \\end{tabular}',
    '\\end{table}',
  ].join('\n')

  const tableSnippet = () => {
    const head = Array.from({ length: grid.cols }, (_, i) => t('sn.col', { n: i + 1 })).join(' & ')
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
          <span>{t('mb.ed.insertTitle')}</span>
          <Button fill="none" size="small" onClick={onClose}>
            {t('dialog.cancel')}
          </Button>
        </div>

        <div style={{ padding: '12px 16px 0' }}>
          <Selector
            columns={3}
            value={[category]}
            onChange={v => setCategory((v[0] as string) || 'format')}
            options={[
              { label: t('mb.ed.catFormat'), value: 'format' },
              { label: t('mb.ed.toolMath'), value: 'math' },
              { label: t('mb.ed.toolSymbols'), value: 'symbols' },
              { label: t('mb.ed.toolRef'), value: 'ref' },
              { label: t('mb.ed.toolTable'), value: 'table' },
              { label: t('mb.ed.toolFigure'), value: 'figure' },
              { label: t('m.mySnippets'), value: 'snippets' },
            ]}
          />
        </div>

        <div className="pl-sheet-body" style={{ padding: '8px 16px 16px' }}>
          {category === 'format' && (
            <List>
              {[
                { text: t('mb.ed.insSection'), value: `\\section{${t('mb.ed.snTitle')}}` },
                { text: t('mb.ed.insSubsection'), value: `\\subsection{${t('mb.ed.snTitle')}}` },
                { text: t('mb.ed.insSubsubsection'), value: `\\subsubsection{${t('mb.ed.snTitle')}}` },
                { text: t('mb.ed.insUnderline'), value: `\\underline{${t('mb.ed.snText')}}` },
                { text: t('mb.ed.insMono'), value: '\\texttt{code}' },
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
                { text: t('mb.ed.insInlineMath'), value: '$E=mc^2$' },
                { text: t('mb.ed.insEquation'), value: '\\begin{equation}\n  \n\\end{equation}' },
                { text: t('mb.ed.insAlign'), value: '\\begin{align}\n  a &= b \\\\\n  c &= d\n\\end{align}' },
                { text: t('mb.ed.insFrac'), value: '\\frac{a}{b}' },
                { text: t('mb.ed.insSqrt'), value: '\\sqrt{x}' },
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
                  aria-label={t('mb.ed.insertSymbol', { s: symbol })}
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
                <Input placeholder={t('mb.ed.refPlaceholder')} value={refKey} onChange={setRefKey} clearable enterKeyHint="done" />
              </div>
              <List>
                {labels.length ? labels.map(label => (
                  <List.Item key={label} clickable onClick={() => insert(`\\ref{${label}}`)}>
                    {t('mb.ed.existingLabel', { label })}
                  </List.Item>
                )) : (
                  <List.Item>{t('mb.ed.noLabels')}</List.Item>
                )}
              </List>
              {refKey.trim() && (
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <Button block fill="outline" size="small" onClick={() => insert(`\\label{${refKey.trim()}}`)}>
                    {t('mb.ed.insLabel')}
                  </Button>
                  <Button block color="primary" size="small" onClick={() => insert(`\\ref{${refKey.trim()}}`)}>
                    {t('mb.ed.insRef')}
                  </Button>
                </div>
              )}
            </>
          )}

          {category === 'table' && (
            <>
              <div style={{ textAlign: 'center', color: 'var(--ink-soft)', fontSize: 12, margin: '8px 0' }}>
                {grid.rows ? t('q.tableSize', { rows: grid.rows, cols: grid.cols }) : t('mb.ed.pickCells')}
              </div>
              <div className="pl-cell-grid">
                {Array.from({ length: 36 }, (_, index) => {
                  const rows = Math.floor(index / 6) + 1
                  const cols = (index % 6) + 1
                  return (
                    <button
                      key={index}
                      type="button"
                      aria-label={t('mb.ed.cellAria', { rows, cols })}
                      data-active={rows <= grid.rows && cols <= grid.cols}
                      onClick={() => setGrid({ rows, cols })}
                    />
                  )
                })}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <Button block fill="outline" disabled={!grid.rows} onClick={() => insert(tableSnippet())}>
                  {t('mb.ed.insPlainTable')}
                </Button>
                <Button block color="primary" onClick={() => insert(booktabs)}>
                  {t('mb.ed.insBooktabs')}
                </Button>
              </div>
            </>
          )}

          {category === 'figure' && (
            <List>
              {[
                { text: t('mb.ed.insFigure'), value: '\\includegraphics[width=0.9\\linewidth]{fig-arch.png}' },
                { text: t('mb.ed.insTikz'), value: `\\begin{tikzpicture}\n  \\node[block] (a) {${t('sn.start')}};\n\\end{tikzpicture}` },
                { text: t('mb.ed.insMermaid'), value: '\\begin{mermaid}\nflowchart LR; A-->B;\n\\end{mermaid}' },
                { text: t('mb.ed.insCite'), value: '\\cite{ref-key}' },
                { text: t('mb.ed.insFootnote'), value: `\\footnote{${t('mb.ed.snNote')}}` },
              ].map(item => (
                <List.Item key={item.text} clickable onClick={() => insert(item.value)}>
                  {item.text}
                </List.Item>
              ))}
            </List>
          )}

          {category === 'snippets' && (
            editing ? (
              <div style={{ display: 'grid', gap: 8, paddingTop: 4 }}>
                <Input placeholder={t('sn.name')} value={editing.name} onChange={v => setEditing(s => (s ? { ...s, name: v } : s))} aria-label={t('sn.name')} />
                <TextArea
                  placeholder={t('sn.content')}
                  value={editing.content}
                  onChange={v => setEditing(s => (s ? { ...s, content: v } : s))}
                  autoSize={{ minRows: 4, maxRows: 10 }}
                  aria-label={t('sn.content')}
                />
                {editError && <div style={{ fontSize: 12, color: 'var(--warn-strong)' }}>{editError}</div>}
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button block fill="outline" onClick={() => { setEditing(null); setEditError('') }}>{t('sn.cancel')}</Button>
                  <Button block color="primary" onClick={saveSnippetEdit}>{t('sn.save')}</Button>
                </div>
              </div>
            ) : (
              <>
                <List>
                  {snippets.length ? snippets.map(s => (
                    <List.Item
                      key={s.id}
                      clickable
                      onClick={() => insert(s.content)}
                      description={<span style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{s.content.slice(0, 90)}{s.content.length > 90 ? '…' : ''}</span>}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
                        {s.name}
                        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 12 }}>
                          <Button fill="none" size="mini" onClick={e => { e.stopPropagation(); setEditing({ ...s }); setEditError('') }}>{t('sn.edit')}</Button>
                          <Button fill="none" size="mini" color="danger" onClick={e => { e.stopPropagation(); deleteSnippet(s) }}>{t('sn.del')}</Button>
                        </span>
                      </span>
                    </List.Item>
                  )) : (
                    <List.Item>{t('sn.empty')}</List.Item>
                  )}
                </List>
                <Button block fill="outline" size="small" style={{ marginTop: 10 }} onClick={() => { setEditing({ id: '', name: '', content: '' }); setEditError('') }}>
                  {t('sn.add')}
                </Button>
              </>
            )
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
  const t = useT()

  const [view, setView] = useState<'source' | 'rich'>('source')
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [insertOpen, setInsertOpen] = useState(false)
  const [insertCategory, setInsertCategory] = useState('format')
  const [previewMenu, setPreviewMenu] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [citeOpen, setCiteOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  // 沉浸写作：隐藏导航/视图切换/工具带，只留编辑器与一个浮动退出钮（桌面用 Esc，触屏没有）
  const [zen, setZen] = useState(false)
  // 表格可视化编辑：预览里点「✎」记下表 id，TablePanel 从渲染结果按 id 取区间
  const [tableSel, setTableSel] = useState<number | null>(null)
  // 片段与桌面共享同一份 localStorage（paperlite.snippets.v1），两端增删改互见
  const [snippets, setSnippets] = useState<Snippet[]>(() => loadSnippets())
  useEffect(() => { saveSnippets(snippets as never) }, [snippets])
  const [gSearch, setGSearch] = useState<GsState>({ query: '', regex: false, matchCase: false, wholeWord: false, busy: false, result: null })
  // 最近一次搜索扫到的磁盘文件（含句柄），点开磁盘命中时用它打开标签
  const diskFilesRef = useRef<Array<{ path: string; text: string; handle: unknown }>>([])

  const tab = useMemo(
    () => ws.tabs.filter(x => String(x.id) === String(docId))[0] || ws.activeTab,
    [ws.tabs, ws.activeTab, docId],
  )

  // 深链进来时先激活该标签，保证 activeValue / 保存态指向同一篇
  useEffect(() => {
    if (tab && tab.id !== ws.activeId) ws.openTab(tab.id)
  }, [tab, ws])

  // 编译失败页「跳到该行」带过来的行号（1-based，来自 XeLaTeX 日志的 l.132）
  const location = useLocation()
  const jumpLine = useMemo(() => Number(new URLSearchParams(location.search).get('line')) || null, [location.search])
  useEffect(() => {
    if (!jumpLine) return
    setView('source')
    const raf = requestAnimationFrame(() => {
      const instance = cm()
      if (!instance) return
      const line = Math.max(0, jumpLine - 1)
      instance.setCursor({ line, ch: 0 })
      instance.scrollIntoView({ line, ch: 0 }, 120)
      instance.focus()
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpLine])

  const cm = () => ws.cmRef.current as {
    getValue: () => string
    replaceSelection: (text: string, select?: string) => void
    setCursor: (pos: { line: number; ch: number }) => void
    scrollIntoView: (range: unknown, margin?: number) => void
    posFromIndex: (offset: number) => { line: number; ch: number }
    undo: () => void
    redo: () => void
    focus: () => void
  } | null

  const value = tab?.doc ? tab.doc.getValue() : ''
  const issues = useMemo(() => (tab?.kind === 'md' ? [] : lintLaTeX(value)), [value, tab?.kind])

  // 只渲染一次：预览与大纲共用同一份 result（renderLatex 对长文不便宜）
  const result = useMemo(() => {
    try {
      if (tab?.kind === 'md') return { ...renderMarkdownFull(value), isMd: true } as never
      return renderLatex(value, {}) as never
    } catch (e) {
      // 异常消息可能回显文档内容片段，进 innerHTML 前转义
      const escHtml = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      return {
        html: '<div class="render-error">' + escHtml(tr(getLang(), 'app.renderErr') + String((e as Error).message || e)) + '</div>',
        warnings: [], headings: [], diagrams: [], stats: { words: 0 },
      } as never
    }
  }, [value, tab?.kind])

  const headings = useMemo(
    () => ((result as { headings?: Array<{ level: number; text: string; offset: number }> })?.headings || []),
    [result],
  )
  const labels = useMemo(() => Array.from(value.matchAll(/\\label\{([^}]+)\}/g)).map(m => m[1]), [value])

  // 表格写回垫片：「近似排版」视图里编辑器未挂载，TablePanel 的 replaceRange 直接落在
  // CodeMirror Doc 上（Doc 本身就是数据模型），写完手动同步共享层，脏标记与预览刷新才不缺
  const tableCm = useMemo(() => {
    const doc = tab?.doc as unknown as {
      getValue: () => string
      posFromIndex: (i: number) => unknown
      replaceRange: (text: string, from: unknown, to: unknown, origin?: string) => void
    } | null | undefined
    if (!doc) return null
    return {
      getValue: () => doc.getValue(),
      posFromIndex: (i: number) => doc.posFromIndex(i),
      replaceRange: (text: string, from: unknown, to: unknown, origin?: string) => {
        doc.replaceRange(text, from, to, origin)
        ws.onDocChange(doc, doc.getValue())
      },
      focus: () => {},
    }
  }, [tab, ws])
  const onSelectTable = useCallback((id: number) => setTableSel(id), [])

  if (!tab || !tab.doc) {
    return (
      <div className="pl-screen">
        <NavBar onBack={() => navigate('/m')}>{t('mb.ed.workspace')}</NavBar>
        <div className="pl-content" style={{ padding: 16, color: 'var(--ink-soft)' }}>
          {t('mb.ed.goneNote')}
        </div>
      </div>
    )
  }

  const saveState = ws.saveStateOf(tab)
  const state = SAVE_STATE[saveState]

  const insertAtCaret = (text: string) => {
    const instance = cm()
    if (!instance) {
      Toast.show({ content: t('mb.ed.editorNotReady'), icon: 'fail' })
      return
    }
    instance.replaceSelection(text, 'around')
    instance.focus()
  }

  // 预览/大纲点击跳转：切回源码屏时编辑器才重新挂载，先把目标存下再等实例就位——
  // 直接拿旧实例会落空（卸载时 cmRef 已置空），且 StrictMode 双挂载下 onInit 早于 swapDoc，
  // 刚挂载的实例还是空 Doc，所以以「真实内容换入」为准，轮询最多 2 秒
  const pendingJumpRef = useRef<{ offset?: number; line?: number } | null>(null)
  const applyPendingJump = (instance: NonNullable<ReturnType<typeof cm>>) => {
    const pending = pendingJumpRef.current
    if (!pending) return
    let line = pending.line
    if (line == null && typeof pending.offset === 'number') {
      try { line = instance.posFromIndex(Math.min(pending.offset, instance.getValue().length)).line } catch { line = undefined }
    }
    pendingJumpRef.current = null
    if (line == null) return
    line = Math.max(0, line)
    instance.setCursor({ line, ch: 0 })
    instance.scrollIntoView({ line, ch: 0 }, 120)
    instance.focus()
  }
  const attemptPendingJump = (tries = 0) => {
    const pending = pendingJumpRef.current
    if (!pending) return
    const instance = cm()
    const docReady = !instance ? false
      : pending.offset == null ? true
      : pending.offset === 0 || instance.getValue().length > 0
    if (instance && docReady) { applyPendingJump(instance); return }
    if (tries < 40) setTimeout(() => attemptPendingJump(tries + 1), 50)
    else pendingJumpRef.current = null
  }

  const jumpToOffset = (offset: number) => {
    pendingJumpRef.current = { offset }
    setView('source')
    setOutlineOpen(false)
    attemptPendingJump()
  }

  const runTool = (id: string) => {
    const snippets = makeSnippets(t)
    const instance = cm()
    if (id === 'undo') { instance?.undo(); return }
    if (id === 'redo') { instance?.redo(); return }
    if (id === 'outline') { setOutlineOpen(true); return }
    if (id === 'compile') { navigate(`/m/compile/${tab.id}`); return }
    if (id === 'cite') {
      // 文献检索只对 LaTeX 文档有意义，非 tex/draft 直接提示不开面板
      if (!(tab.kind === 'tex' || tab.kind === 'draft')) { Toast.show({ content: t('cite.onlyTex') }); return }
      setCiteOpen(true)
      return
    }
    if (id === 'search') { setSearchOpen(true); return }
    if (snippets[id]) { insertAtCaret(snippets[id]); return }
    setInsertCategory(id)
    setInsertOpen(true)
  }

  const jumpToLine = (lineZeroBased: number) => {
    pendingJumpRef.current = { line: lineZeroBased }
    setView('source')
    attemptPendingJump()
  }

  // ---- 项目内搜索：打开标签（实时内容）+ 文件夹按需扫描，与桌面侧栏共用 searchIndex ----
  const runGlobalSearch = async ({ query, regex, matchCase, wholeWord }: { query: string; regex: boolean; matchCase: boolean; wholeWord: boolean }) => {
    setGSearch(s => ({ ...s, busy: true }))
    const tabsList = ws.tabs.filter(x => x.doc).map(x => ({ path: x.path || x.name, name: x.name, text: x.doc!.getValue() }))
    let disk: Array<{ path: string; text: string; handle: unknown }> = []
    if (ws.rootDir) {
      try { disk = await scanFolderTexts(ws.rootDir) } catch { /* 权限/读取失败按「没有文件夹」处理 */ }
    }
    diskFilesRef.current = disk
    const result = searchInFiles(
      collectSearchFiles(tabsList as never, disk.map(d => ({ path: d.path, text: d.text })) as never),
      { query, regex, matchCase, wholeWord },
    )
    setGSearch(s => ({ ...s, busy: false, result: result as never }))
  }

  const openSearchResult = async (path: string, line: number) => {
    setSearchOpen(false)
    setView('source')
    const base = path.includes('/') ? path.split('/').pop()! : path
    const hit = ws.tabs.find(x => x.path === path) || ws.tabs.find(x => x.name === base || x.name === path)
    if (hit) {
      const cross = hit.id !== tab.id
      if (cross) navigate(`/m/workspace/${hit.id}`)
      // 跨标签要等 swapDoc 换入新 Doc 再落光标；同标签立即跳
      setTimeout(() => { pendingJumpRef.current = { line }; attemptPendingJump() }, cross ? 60 : 0)
      return
    }
    const f = diskFilesRef.current.find(x => x.path === path)
    if (f) {
      const opened = await ws.openFileTab(f.handle, f.path, ws.rootDir) as MobileTab | null
      if (opened) {
        navigate(`/m/workspace/${opened.id}`)
        setTimeout(() => { pendingJumpRef.current = { line }; attemptPendingJump() }, 60)
      }
    }
  }

  const errCount = issues.filter(i => i.severity === 'error').length
  const warnCount = issues.filter(i => i.severity === 'warn').length
  const firstIssueWithLine = issues.find(i => typeof i.line === 'number' && i.line >= 0)

  return (
    <div className="pl-screen" style={{ '--pl-keyboard': `${keyboard}px` } as CSSProperties}>
      {/* 沉浸写作：导航/视图切换/工具带整体不渲染（触屏没有 Esc，右上角浮动钮退出） */}
      {!zen && (
        <NavBar
          onBack={() => navigate('/m')}
          right={
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Button color="primary" size="mini" onClick={() => navigate(`/m/compile/${tab.id}`)}>
                {t('mb.ed.toolCompile')}
              </Button>
              {/* 桌面菜单栏在移动端整体降级为 ⋯ Action Sheet */}
              <Button fill="none" size="mini" aria-label={t('mb.ed.moreActions')} onClick={() => setMoreOpen(true)}>
                <MoreOutline />
              </Button>
            </span>
          }
        >
          <span className="pl-nav-title">
            <span className="pl-nav-name">{tab.name}</span>
            <Tag color={state.color} fill="outline">
              {t(state.textKey)}
            </Tag>
          </span>
        </NavBar>
      )}

      {!zen && (
        <Segmented
          value={view}
          onChange={v => setView(v as 'source' | 'rich')}
          options={[
            { label: t(VIEW_LABEL.source), value: 'source' },
            { label: t(VIEW_LABEL.rich), value: 'rich' },
          ]}
          style={{ margin: '8px 12px', '--segmented-background': 'var(--chrome)' } as CSSProperties}
        />
      )}

      {!zen && (errCount > 0 || warnCount > 0) && (
        <NoticeBar
          color={errCount > 0 ? 'alert' : 'info'}
          wrap
          style={{ cursor: firstIssueWithLine ? 'pointer' : undefined }}
          content={
            errCount > 0
              ? t('mb.ed.issueBar', { n: errCount, line: firstIssueWithLine ? firstIssueWithLine.line + 1 : 1 })
              : t('mb.ed.warnBar', { n: warnCount, line: firstIssueWithLine ? firstIssueWithLine.line + 1 : 1 })
          }
          onClick={() => {
            if (firstIssueWithLine && typeof firstIssueWithLine.line === 'number') {
              jumpToLine(firstIssueWithLine.line)
            }
          }}
        />
      )}

      {view === 'source'
        ? <Screen1_SourceEditor tab={tab} />
        : <Screen2_RichPreview result={result as never} onLongPress={() => setPreviewMenu(true)} onJumpOff={jumpToOffset} onSelectTable={onSelectTable} />}

      {!zen && (
        <div className="pl-toolbelt" data-keyboard={keyboard > 0}>
          <div className="pl-scroll-x">
            {TOOLS.map(tool => (
              <button key={tool.id} type="button" className="pl-tool" aria-label={t(tool.key)} onClick={() => runTool(tool.id)}>
                {tool.icon}
                <span>{t(tool.key)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {zen && (
        <button type="button" className="pl-zen-exit" aria-label={t('mb.ed.zenExit')} title={t('mb.ed.zenExit')} onClick={() => setZen(false)}>
          ✕
        </button>
      )}

      <OutlineSheet visible={outlineOpen} headings={headings} onClose={() => setOutlineOpen(false)} onJump={jumpToOffset} />

      <InsertSheet
        visible={insertOpen}
        initialCategory={insertCategory}
        labels={labels}
        snippets={snippets}
        onSnippets={updater => setSnippets(list => updater(list))}
        onClose={() => setInsertOpen(false)}
        onInsert={insertAtCaret}
      />

      <CiteSheet
        visible={citeOpen}
        onClose={() => setCiteOpen(false)}
        onInsert={entry => { void ws.insertCitation(entry) }}
      />

      <SearchSheet
        visible={searchOpen}
        onClose={() => setSearchOpen(false)}
        state={gSearch}
        setState={setGSearch}
        onSearch={runGlobalSearch}
        onOpen={openSearchResult}
        hasFolder={!!ws.rootDir}
      />

      {/* 表格可视化编辑：桌面 TablePanel 原样复用（写回走 Doc 直写垫片），
          布局由 mobile-theme.css 把右滑抽屉适配成底部弹层 */}
      {tableSel != null && (
        <TablePanel
          open
          onClose={() => setTableSel(null)}
          result={result as never}
          cm={tableCm as never}
          selection={{ did: 0, sel: { type: 'table', id: tableSel } } as never}
        />
      )}

      {/* → 长按预览区 → 就地菜单（桌面靠 hover 工具条，触屏拿不到） */}
      <ActionSheet
        visible={previewMenu}
        onClose={() => setPreviewMenu(false)}
        cancelText={t('dialog.cancel')}
        extra={
          <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--ink-soft)' }} className="pl-num">
            {t('mb.ed.lineInfo', { n: value.split('\n').length, w: formatWords(wordCount(value).total) })}
          </div>
        }
        actions={[
          {
            key: 'edit',
            text: <span><EditSOutline /> {t('mb.ed.backToSource')}</span>,
            onClick: () => { setPreviewMenu(false); setView('source') },
          },
          {
            key: 'outline',
            text: <span><UnorderedListOutline /> {t('mb.ed.viewOutlineJump')}</span>,
            onClick: () => { setPreviewMenu(false); setOutlineOpen(true) },
          },
        ]}
      />

      {/* → 顶栏 ⋯ */}
      <ActionSheet
        visible={moreOpen}
        onClose={() => setMoreOpen(false)}
        cancelText={t('dialog.cancel')}
        extra={<div style={{ textAlign: 'center' }}>{tab.name}</div>}
        actions={[
          {
            key: 'save',
            text: <span><CheckOutline /> {t('m.save')}</span>,
            onClick: () => {
              setMoreOpen(false)
              ws.saveActive()
            },
          },
          {
            key: 'history',
            text: <span><ClockCircleOutline /> {t('mb.ed.history')}</span>,
            onClick: () => {
              setMoreOpen(false)
              navigate(`/m/history/${tab.id}`)
            },
          },
          {
            key: 'ai',
            text: <span><MessageOutline /> {t('m.aiAssistant')}</span>,
            onClick: () => {
              setMoreOpen(false)
              navigate('/m/chat')
            },
          },
          // 桌面点编辑器 gutter 红点会预填修复提示词；移动端没有 gutter 点击，
          // 把同一份提示词（共享 chatContext）挂在这里，语法问题也能一键带去对话
          ...(issues.length ? [{
            key: 'aifix',
            text: <span><ExclamationTriangleOutline /> {t('mb.ed.aiFixCount', { n: issues.length })}</span>,
            onClick: () => {
              setMoreOpen(false)
              ws.sendChatInject(aiFixIssuePrompt({ issues: issues.slice(0, 20), lines: value.split('\n') }))
              navigate('/m/chat')
            },
          }] : []),
          {
            key: 'zen',
            text: <span><EyeOutline /> {t('mb.ed.zen')}</span>,
            onClick: () => {
              setMoreOpen(false)
              setView('source')
              setZen(true)
            },
          },
          {
            key: 'export',
            text: t('mb.ed.exportBackup'),
            onClick: () => {
              setMoreOpen(false)
              Dialog.confirm({
                title: t('mb.ed.exportTitle'),
                content: t('mb.ed.exportContent'),
                confirmText: t('mb.ed.export'),
                cancelText: t('dialog.cancel'),
                onConfirm: () => {
                  const blob = new Blob([value], { type: 'text/plain;charset=utf-8' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = tab.name
                  a.click()
                  // iOS Safari 对 click 后立即 revoke 的 blob 下载可能静默失败（桌面 exporter 同款延时）
                  setTimeout(() => URL.revokeObjectURL(url), 500)
                },
              })
            },
          },
        ]}
      />
    </div>
  )
}

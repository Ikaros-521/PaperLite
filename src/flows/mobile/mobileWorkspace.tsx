// =============================================
// PAPERLITE MOBILE · 工作区 Provider
// 把共享的 useWorkspace() 实例下发给各 flow：
// 移动端与桌面读同一份 tabs / 草稿 / 保存 / 历史实现，不复制第二份逻辑。
// =============================================

import { type ReactNode, type RefObject, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Button, ConfigProvider, Dialog, Input, Popup, Toast } from 'antd-mobile'
import zhCN from 'antd-mobile/es/locales/zh-CN'
import enUS from 'antd-mobile/es/locales/en-US'
import { useWorkspace } from '../../workspace/useWorkspace.js'
import { useCompile } from '../../workspace/useCompile.js'
import { buildLLMContext } from '../../workspace/chatContext.js'
import { LangContext } from '../../useI18n.js'
import { LS_LANG, detectLang, setLang as setModuleLang, tr } from '../../i18n.js'
import * as fs from '../../fs.js'
import * as llm from '../../llm.js'
import { saveStateOf } from './shared/labels'
import { SCALE_FONT, readScale, writeScale, type ScaleId } from './shared/scale'
import type { SaveState } from './shared/types'

/** CodeMirror Doc 的最小面：flow 只用到取值/取值，不依赖 CM 类型 */
export interface MobileDoc {
  getValue: () => string
  setValue: (value: string) => void
}

export interface MobileTab {
  id: number
  name: string
  kind: string
  path: string
  updatedAt: number
  doc: MobileDoc | null
  handle: unknown
  imageUrl: string | null
  uploadedFile: File | null
}

interface PromptState {
  message: string
  value: string
}

/** ChatPanel 需要的上下文构造器；除常规调用外还挂 cm()，供「替换选区/替换全文」回写编辑器 */
export type ChatContextBuilder = ((
  scope: string,
  query: string,
  channel: unknown,
) => Promise<{ text: string; note: string; tokens: number; budget: number }>) & {
  cm?: () => unknown
}

interface MobileWorkspaceValue {
  t: (key: string, params?: Record<string, unknown>) => string
  lang: string
  setLang: (lang: string) => void
  tabs: MobileTab[]
  activeTab: MobileTab | null
  rootDir: { name: string } | null
  fsSupported: boolean
  saveStateOf: (tab: MobileTab) => SaveState
  openTab: (id: number) => void
  onDocChange: (doc: unknown, value: string) => void
  addDraft: (name: string, text?: string) => MobileTab
  renameTab: (id: number, name: string) => boolean
  closeTab: (id: number) => Promise<void>
  saveActive: () => Promise<void>
  uploadFiles: () => void
  openFolder: () => Promise<void>
  cmRef: RefObject<unknown>
  treeTick: number
  // 编译链：与桌面共用 useCompile，语义一致，只有"编译完看哪里"不同
  engines: string[]
  engine: string
  setEngine: (engine: string) => void
  builtinStatus: string
  compiling: boolean
  compileResult: {
    ok: boolean
    pdfUrl?: string
    log?: string
    errors?: Array<{ line: number | null; msg: string }>
    engine: string
    source?: string
  } | null
  compile: () => Promise<string>
  cancelCompile: () => void
  pdfIsStale: boolean
  // AI 对话：与桌面共用同一个 ChatPanel 与同一份渠道存储（localStorage），不另写一套
  channels: unknown[]
  setChannels: (updater: unknown) => void
  activeChannelId: string
  setActiveChannelId: (id: string) => void
  chatMessages: unknown[]
  setChatMessages: (updater: unknown) => void
  chatInject: { text: string; n: number } | null
  sendChatInject: (text: string) => void
  buildContext: ChatContextBuilder
  beforeAiApply: () => void
  settingsOpen: boolean
  openSettings: () => void
  closeSettings: () => void
  // 字号档位（见 shared/scale.ts）：scaleFont 是 px 数值，壳注入成 --pl-font
  scale: ScaleId
  setScale: (scale: ScaleId) => void
  scaleFont: number
}

const MobileCtx = createContext<MobileWorkspaceValue | null>(null)

export function useMobileWorkspace(): MobileWorkspaceValue {
  const value = useContext(MobileCtx)
  if (!value) throw new Error('useMobileWorkspace 必须在 MobileWorkspaceProvider 内使用')
  return value
}

export function MobileWorkspaceProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState(detectLang)
  // 引擎/linter/fs 这些非 React 模块读模块级语言，必须与 lang 状态同步，否则 t() 拿错语言
  setModuleLang(lang)
  const t = useMemo(() => (key: string, params?: Record<string, unknown>) => tr(lang, key, params), [lang])

  const cmRef = useRef(null)
  const [treeTick, setTreeTick] = useState(0)

  // 桌面用 <dialog> 拿输入，移动端自己弹一个带输入的 Popup
  const [promptState, setPromptState] = useState<PromptState | null>(null)
  const resolver = useRef<((value: string | null) => void) | null>(null)
  const prompt = useCallback((message: string, defaultValue = '') => {
    setPromptState({ message, value: defaultValue })
    return new Promise<string | null>(resolve => { resolver.current = resolve })
  }, [])
  const settlePrompt = (value: string | null) => {
    setPromptState(null)
    resolver.current?.(value)
    resolver.current = null
  }

  const ws = useWorkspace({
    t,
    flash: (msg: string) => Toast.show({ content: msg }),
    alertBox: (msg: string) => { Dialog.alert({ title: t('dialog.alert'), content: msg, confirmText: t('mb.sh.gotIt') }) },
    confirm: (msg: string) => Dialog.confirm({ title: t('mb.sh.confirmTitle'), content: msg, confirmText: t('dialog.ok'), cancelText: t('dialog.cancel') }),
    prompt,
    onTreeChanged: () => setTreeTick(n => n + 1),
    onSideTab: () => {},
  })

  // 编译链与桌面同一份实现：换引擎、预热、取消、结果与 PDF Blob 生命周期
  const activeTab = (ws.tabs as MobileTab[]).filter(x => x.id === ws.activeId)[0] || null
  const isTexLike = activeTab?.kind === 'tex' || activeTab?.kind === 'draft'
  const compileLayer = useCompile(
    { t, flash: (msg: string) => Toast.show({ content: msg }), alertBox: (msg: string) => { Dialog.alert({ title: t('dialog.alert'), content: msg, confirmText: t('mb.sh.gotIt') }) } },
    { tabsRef: ws.tabsRef, activeTab, isTexLike, autoWarm: false },
  )

  // ---- AI 对话：渠道、消息、上下文构造全部复用桌面实现 ----
  const [channels, setChannels] = useState(() => llm.loadChannels())
  const [activeChannelId, setActiveChannelId] = useState(() => (llm.loadChannels()[0] || {}).id || '')
  const [chatMessages, setChatMessages] = useState([])
  const [chatInject, setChatInject] = useState<{ text: string; n: number } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  useEffect(() => { llm.saveChannels(channels) }, [channels])

  const activeValueRef = useRef(ws.activeValue)
  activeValueRef.current = ws.activeValue

  /**
   * 编辑器只在「源码」视图挂载，AI Tab 是独立路由，此时 cmRef 已随 EditorPane 卸载。
   * CodeMirror 的 Doc 本身就是数据模型（getSelection/getCursor/setValue 都在），
   * 所以脱离编辑器也能读写；回到工作区时 swapDoc 会显示新内容。
   * 代价是 Doc 的 change 事件不会传给共享层，必须手动 onDocChange，否则脏标记与草稿不落盘。
   */
  const docAsCm = (doc: MobileDoc & Record<string, any>) => ({
    getSelection: () => doc.getSelection(),
    getCursor: () => doc.getCursor(),
    lineCount: () => doc.lineCount(),
    getLine: (n: number) => doc.getLine(n),
    setValue: (text: string) => { doc.setValue(text); ws.onDocChange(doc, doc.getValue()) },
    replaceSelection: (text: string) => { doc.replaceSelection(text); ws.onDocChange(doc, doc.getValue()) },
    focus: () => {},
  })
  const chatCm = () => {
    // EditorPane 卸载时会清掉 cmRef；这里再按 DOM 是否还在兜一层——
    // 拿到已 detach 的实例会把 AI 结果写进它 swapDoc 换出来的临时空 Doc，静默丢失。
    const inst = cmRef.current as { getWrapperElement?: () => HTMLElement } | null
    const el = inst?.getWrapperElement?.()
    if (el?.isConnected) return cmRef.current
    const doc = activeTab?.doc as (MobileDoc & Record<string, any>) | null
    return doc ? docAsCm(doc) : null
  }

  const buildContext = useCallback<ChatContextBuilder>((scope: string, query: string, channel: unknown) =>
    buildLLMContext({ cm: chatCm, doc: activeValueRef.current }, scope, query, channel), [activeTab])
  buildContext.cm = chatCm

  // 整篇替换会冲掉撤销栈：先存一份版本，与桌面 hist.beforeAi 同一入口
  const beforeAiApply = useCallback(() => {
    ws.snapshot(tr(lang, 'hist.beforeAi'), 'manual', true)
  }, [ws, lang])

  const sendChatInject = useCallback((text: string) => setChatInject({ text, n: Date.now() }), [])

  useEffect(() => {
    try { localStorage.setItem(LS_LANG, lang) } catch { /* ignore */ }
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])

  const setLang = useCallback((next: string) => {
    setLangState(next)
    setModuleLang(next)
  }, [])

  // 字号档位：持久化在本地，壳把 SCALE_FONT[scale] 注入 --pl-font 供预览与编辑器共用
  const [scale, setScaleState] = useState<ScaleId>(readScale)
  const setScale = useCallback((next: ScaleId) => {
    setScaleState(next)
    writeScale(next)
  }, [])

  const value = useMemo<MobileWorkspaceValue>(() => ({
    t,
    lang,
    setLang,
    tabs: ws.tabs as MobileTab[],
    activeTab,
    rootDir: ws.rootDir,
    fsSupported: fs.supported(),
    saveStateOf: tab => saveStateOf(tab as never),
    openTab: (id: number) => ws.activateTab(id),
    onDocChange: (doc: unknown, value: string) => ws.onDocChange(doc, value),
    addDraft: (name: string, text?: string) => ws.addDraft(name, text) as MobileTab,
    renameTab: ws.renameTab,
    closeTab: ws.closeTab,
    saveActive: ws.saveActive,
    uploadFiles: ws.uploadFiles,
    openFolder: ws.openFolder,
    cmRef,
    treeTick,
    engines: compileLayer.engines,
    engine: compileLayer.engine,
    setEngine: compileLayer.setEngine,
    builtinStatus: compileLayer.builtinStatus,
    compiling: compileLayer.compiling,
    compileResult: compileLayer.compileResult as never,
    compile: compileLayer.compile,
    cancelCompile: compileLayer.cancelCompile,
    pdfIsStale: compileLayer.pdfIsStale,
    channels,
    setChannels,
    activeChannelId,
    setActiveChannelId,
    chatMessages,
    setChatMessages,
    chatInject,
    sendChatInject,
    buildContext,
    beforeAiApply,
    settingsOpen,
    openSettings: () => setSettingsOpen(true),
    closeSettings: () => setSettingsOpen(false),
    scale,
    setScale,
    scaleFont: SCALE_FONT[scale],
  }), [t, lang, setLang, ws, activeTab, treeTick, compileLayer, channels, activeChannelId, chatMessages, chatInject, buildContext, beforeAiApply, sendChatInject, settingsOpen, scale, setScale])

  return (
    // antd-mobile 自带文案（下拉刷新 / 没有更多了 / 搜索框、蒙层等 aria-label）默认是 zh-CN，
    // 只有这里换 locale，英文界面才不会漏出库内文案
    <ConfigProvider locale={lang === 'zh' ? zhCN : enUS}>
      <LangContext.Provider value={lang}>
        <MobileCtx.Provider value={value}>
          {children}

          {promptState && (
            <Popup visible position="bottom" closeOnSwipe onClose={() => settlePrompt(null)}
              bodyStyle={{ borderTopLeftRadius: 12, borderTopRightRadius: 12 }}>
              <div className="pl-sheet">
                <div className="pl-sheet-head">
                  <span>{promptState.message}</span>
                  <Button fill="none" size="small" onClick={() => settlePrompt(null)}>{t('dialog.cancel')}</Button>
                </div>
                <div style={{ padding: '12px 16px' }}>
                  <Input
                    autoFocus
                    value={promptState.value}
                    onChange={v => setPromptState(s => (s ? { ...s, value: v } : s))}
                    enterKeyHint="done"
                  />
                </div>
                <div className="pl-sheet-foot">
                  <Button block color="primary" onClick={() => settlePrompt(promptState.value)}>{t('dialog.ok')}</Button>
                </div>
              </div>
            </Popup>
          )}
        </MobileCtx.Provider>
      </LangContext.Provider>
    </ConfigProvider>
  )
}

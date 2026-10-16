// =============================================
// PAPERLITE MOBILE · 工作区 Provider
// 把共享的 useWorkspace() 实例下发给各 flow：
// 移动端与桌面读同一份 tabs / 草稿 / 保存 / 历史实现，不复制第二份逻辑。
// =============================================

import { type ReactNode, type RefObject, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Dialog, Input, Popup, Toast } from 'antd-mobile'
import { useWorkspace } from '../../workspace/useWorkspace.js'
import { useCompile } from '../../workspace/useCompile.js'
import { LangContext } from '../../useI18n.js'
import { LS_LANG, detectLang, setLang as setModuleLang, tr } from '../../i18n.js'
import * as fs from '../../fs.js'
import { saveStateOf } from './shared/labels'
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
    alertBox: (msg: string) => { Dialog.alert({ title: '提示', content: msg, confirmText: '知道了' }) },
    confirm: (msg: string) => Dialog.confirm({ title: '确认', content: msg, confirmText: '确定', cancelText: '取消' }),
    prompt,
    onTreeChanged: () => setTreeTick(n => n + 1),
    onSideTab: () => {},
  })

  // 编译链与桌面同一份实现：换引擎、预热、取消、结果与 PDF Blob 生命周期
  const activeTab = (ws.tabs as MobileTab[]).filter(x => x.id === ws.activeId)[0] || null
  const isTexLike = activeTab?.kind === 'tex' || activeTab?.kind === 'draft'
  const compileLayer = useCompile(
    { t, flash: (msg: string) => Toast.show({ content: msg }), alertBox: (msg: string) => { Dialog.alert({ title: '提示', content: msg, confirmText: '知道了' }) } },
    { tabsRef: ws.tabsRef, activeTab, isTexLike, autoWarm: false },
  )

  useEffect(() => {
    try { localStorage.setItem(LS_LANG, lang) } catch { /* ignore */ }
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])

  const setLang = useCallback((next: string) => {
    setLangState(next)
    setModuleLang(next)
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
  }), [t, lang, setLang, ws, activeTab, treeTick, compileLayer])

  return (
    <LangContext.Provider value={lang}>
      <MobileCtx.Provider value={value}>
        {children}

        {promptState && (
          <Popup visible position="bottom" closeOnSwipe onClose={() => settlePrompt(null)}
            bodyStyle={{ borderTopLeftRadius: 12, borderTopRightRadius: 12 }}>
            <div className="pl-sheet">
              <div className="pl-sheet-head">
                <span>{promptState.message}</span>
                <Button fill="none" size="small" onClick={() => settlePrompt(null)}>取消</Button>
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
                <Button block color="primary" onClick={() => settlePrompt(promptState.value)}>确定</Button>
              </div>
            </div>
          </Popup>
        )}
      </MobileCtx.Provider>
    </LangContext.Provider>
  )
}

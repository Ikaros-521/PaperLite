// =============================================
// PAPERLITE MOBILE · App Shell
// 3 Tab（文稿 / AI / 设置）+ 4 个 flow 的路由装配
// 导航模式：根层 TabBar，工作区/编译/历史走 Stack push（隐藏 TabBar）
// =============================================

import { type CSSProperties, useMemo, useState } from 'react'
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Button, Empty, List, NavBar, NoticeBar, SafeArea, Selector, TabBar, Tag, Toast } from 'antd-mobile'
import { FileOutline, MessageOutline, SetOutline } from 'antd-mobile-icons'
import './mobile-theme.css'
import { Screen1_DocumentsHome } from './flow-1-documents'
import { Flow2_Workspace } from './flow-2-editor'
import { Flow3_Compile } from './flow-3-compile'
import { Flow4_History, Screen4_RestoreBanner, Screen5_OfflineState } from './flow-4-history'
import ChatPanel from '../../components/ChatPanel.jsx'
import SettingsDialog from '../../components/SettingsDialog.jsx'
import DialogHost from '../../components/MessageDialog.jsx'
import { MobileWorkspaceProvider, useMobileWorkspace } from './mobileWorkspace'
import { ENGINE_LABEL, ENGINE_STATUS_LABEL } from './shared/labels'
import { SCALE_IDS } from './shared/scale'
import { useKeyboardInset } from './shared/hooks'
import { THEME_IDS, applyTheme, detectTheme } from '../../theme.js'
import { wordCount } from '../../fileActions.js'

/**
 * 用 HashRouter 而不是 BrowserRouter：
 * vite.config.js 是 base: './'（要支持 dist 双击打开与 Electron file://），
 * 且 server.mjs 只兜 API，没有 SPA fallback —— 真路径 /m/workspace/d1 刷新即 404。
 */
// 标签文字存键名：语言运行时可切换，模块顶层不能调用 t()
const TABS = [
  { key: '/m', titleKey: 'mb.sh.tabDocs', icon: <FileOutline /> },
  { key: '/m/chat', titleKey: 'mb.sh.tabAi', icon: <MessageOutline /> },
  { key: '/m/settings', titleKey: 'mb.sh.tabSettings', icon: <SetOutline /> },
]

/** 全屏工作区不吃 TabBar：底部再挂 50px 会把工具带顶到键盘之上 */
const IMMERSIVE = ['/m/workspace', '/m/compile', '/m/history', '/m/offline']

function DocumentsTab() {
  const ws = useMobileWorkspace()
  const navigate = useNavigate()
  const [dismissed, setDismissed] = useState(false)

  // 真实草稿：浏览器草稿就是没有磁盘句柄的标签，冷启动时已由共享层恢复
  const prompt = useMemo(() => {
    const drafts = ws.tabs.filter(tab => !tab.handle && tab.doc && tab.kind !== 'image' && tab.kind !== 'pdf')
    if (!drafts.length || dismissed) return null
    return {
      folderName: ws.rootDir?.name || null,
      pendingTabs: drafts.map(tab => ({
        id: String(tab.id),
        name: tab.name,
        words: wordCount(tab.doc ? tab.doc.getValue() : '').total,
      })),
    }
  }, [ws.tabs, ws.rootDir, dismissed])

  return (
    <Screen1_DocumentsHome
      banner={
        prompt ? (
          <Screen4_RestoreBanner
            prompt={prompt}
            onRestore={() => {
              const first = prompt.pendingTabs[prompt.pendingTabs.length - 1]
              ws.openTab(Number(first.id))
              navigate(`/m/workspace/${first.id}`)
            }}
            onDiscard={() => setDismissed(true)}
          />
        ) : undefined
      }
    />
  )
}

function ChatTab() {
  const ws = useMobileWorkspace()
  const navigate = useNavigate()
  const recent = ws.tabs.filter(tab => tab.doc)[0]
  // 对话必须贴着一份文稿：没有可编辑的 Doc 时，选区/段落/全文三种上下文都无从取
  if (!ws.activeTab?.doc) {
    return (
      <div className="pl-screen">
        <NavBar back={null}>{ws.t('chat.title')}</NavBar>
        <div className="pl-content" style={{ textAlign: 'center', padding: '32px 16px' }}>
          {/* Empty 不接受 children，CTA 放外层 div */}
          <Empty description={recent ? ws.t('mb.sh.notTextDoc') : ws.t('mb.sh.needDoc')} />
          <div style={{ marginTop: 16 }}>
            <Button
              color="primary"
              onClick={() => {
                if (!recent) {
                  const tab = ws.addDraft(ws.t('mb.sh.chatDraftName'))
                  navigate(`/m/workspace/${tab.id}`)
                  return
                }
                ws.openTab(recent.id)
                navigate(`/m/workspace/${recent.id}`)
              }}
            >
              {recent ? ws.t('mb.sh.continueRecent') : ws.t('mb.sh.newDraftFirst')}
            </Button>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="pl-screen">
      <NavBar back={null}>{ws.t('chat.title')}</NavBar>
      <div className="pl-content pl-chat-host">
        {/* 桌面同一个组件，narrow 模式填满容器：禁拖拽/改宽，上下文与 token 口径完全一致 */}
        <ChatPanel
          open
          narrow
          onClose={() => navigate('/m')}
          channels={ws.channels as never}
          activeChannelId={ws.activeChannelId}
          setActiveChannelId={ws.setActiveChannelId as never}
          onOpenSettings={ws.openSettings}
          buildContext={ws.buildContext}
          messages={ws.chatMessages as never}
          setMessages={ws.setChatMessages as never}
          inject={ws.chatInject as never}
          onBeforeApply={ws.beforeAiApply}
          agentCfg={ws.agentCfg as never}
        />
      </div>
    </div>
  )
}

function SettingsTab() {
  const ws = useMobileWorkspace()
  const navigate = useNavigate()
  const [theme, setTheme] = useState(detectTheme)
  type Channel = { id: string; name?: string; chatModel?: string }
  const list = ws.channels as Channel[]
  const activeChannel = list.filter(c => c.id === ws.activeChannelId)[0] || list[0] || null
  // labels.ts 存的是键名，渲染时才翻译
  const engineName = ws.t(ENGINE_LABEL[ws.engine as keyof typeof ENGINE_LABEL] || 'mb.sh.engineUnknown')
  const engineState = ws.t(ENGINE_STATUS_LABEL[ws.builtinStatus] || 'mb.sh.engineUnknown')
  return (
    <div className="pl-screen">
      <NavBar back={null}>{ws.t('mb.sh.tabSettings')}</NavBar>
      <div className="pl-content">
        <List header={ws.t('mb.sh.groupAppearance')}>
          <List.Item>
            <div style={{ marginBottom: 8 }}>{ws.t('m.theme')}</div>
            <Selector
              columns={2}
              value={[theme]}
              onChange={v => {
                const next = String(v[0] || theme)
                applyTheme(next)
                setTheme(next)
                Toast.show({ content: ws.t('theme.' + next), icon: 'success' })
              }}
              options={THEME_IDS.map(id => ({ label: ws.t('theme.' + id), value: id }))}
            />
          </List.Item>
          <List.Item>
            <div style={{ marginBottom: 8 }}>{ws.t('mb.sh.fontLabel')}</div>
            <Selector
              value={[ws.scale]}
              onChange={v => ws.setScale(String(v[0] || ws.scale) as typeof ws.scale)}
              options={SCALE_IDS.map(id => ({ label: ws.t('mb.sh.font' + id[0].toUpperCase() + id.slice(1)), value: id }))}
            />
          </List.Item>
          <List.Item>
            <div style={{ marginBottom: 8 }}>{ws.t('mb.sh.langLabel')}</div>
            <Selector
              value={[ws.lang]}
              onChange={v => {
                ws.setLang(String(v[0] || 'zh'))
                Toast.show({ content: ws.t('mb.sh.langSwitched'), icon: 'success' })
              }}
              options={[
                { label: '中文', value: 'zh' },
                { label: 'English', value: 'en' },
              ]}
            />
          </List.Item>
        </List>
        <List header={ws.t('mb.sh.groupUi')}>
          {/* 与桌面「手机版」对称：改 hash 后 reload，让 main.jsx 重新决定渲染哪棵树 */}
          <List.Item
            clickable
            arrowIcon
            extra={ws.t('mb.sh.toDesktopHint')}
            onClick={() => {
              window.location.hash = '#/'
              window.location.reload()
            }}
          >
            {ws.t('mb.sh.toDesktop')}
          </List.Item>
        </List>
        <List header={ws.t('mb.sh.groupCompile')}>
          <List.Item clickable arrowIcon extra={engineName} onClick={() => navigate('/m/offline')}>
            {ws.t('mb.sh.defaultEngine')}
          </List.Item>
          <List.Item extra={engineState}>{ws.t('mb.sh.engineState')}</List.Item>
          {/* 应用侧没有清理 wasm 资源的入口，只能如实说明首次编译的下载量 */}
          <List.Item extra={<Tag fill="outline">{ws.t('mb.sh.texAssetsSize')}</Tag>}>{ws.t('mb.sh.texAssets')}</List.Item>
        </List>
        <List header={ws.t('mb.sh.groupAi')}>
          <List.Item
            clickable
            arrowIcon
            extra={activeChannel ? `${activeChannel.name} · ${activeChannel.chatModel || ws.t('chat.noModel')}` : ws.t('mb.sh.notConfigured')}
            onClick={ws.openSettings}
          >
            {ws.t('mb.sh.channels')}
          </List.Item>
          <List.Item clickable arrowIcon extra={ws.activeTab?.doc ? ws.t('mb.sh.openChat') : ws.t('mb.sh.needDoc')} onClick={() => navigate('/m/chat')}>
            {ws.t('chat.title')}
          </List.Item>
        </List>
      </div>
    </div>
  )
}

function MobileShell() {
  const ws = useMobileWorkspace()
  const location = useLocation()
  const navigate = useNavigate()
  const keyboard = useKeyboardInset()

  const immersive = IMMERSIVE.some(path => location.pathname.startsWith(path))
  const activeKey = TABS.find(tab => tab.key === location.pathname)?.key ?? ''

  return (
    <div className="pl-mobile" style={{ '--pl-keyboard': `${keyboard}px`, '--pl-font': `${ws.scaleFont}px` } as CSSProperties}>
      <div className="pl-shell">
        <SafeArea position="top" />

        <div className="pl-body">
          <Routes>
            <Route path="/m" element={<DocumentsTab />} />
            <Route path="/m/chat" element={<ChatTab />} />
            <Route path="/m/settings" element={<SettingsTab />} />
            <Route path="/m/workspace/:docId" element={<Flow2_Workspace />} />
            <Route path="/m/compile/:docId" element={<Flow3_Compile />} />
            <Route path="/m/history/:docId" element={<Flow4_History />} />
            <Route path="/m/offline" element={<Screen5_OfflineState />} />
            <Route path="*" element={<Navigate to="/m" replace />} />
          </Routes>
        </div>

        {/* flex 列布局，TabBar 走文档流；禁止 position:fixed（viewport 居中 ≠ 容器居中） */}
        {!immersive && (
          <div style={{ flex: 'none', borderTop: '1px solid var(--line)' }}>
            <TabBar activeKey={activeKey} onChange={key => navigate(key)}>
              {TABS.map(tab => (
                <TabBar.Item key={tab.key} icon={tab.icon} title={ws.t(tab.titleKey)} />
              ))}
            </TabBar>
            <SafeArea position="bottom" />
          </div>
        )}

        {/* 桌面同一份渠道表单：ChatPanel 的 ⚙ 与设置页都开它，不再另写一套字段。
            必须挂在 .pl-mobile 内，窄屏重排规则（单列、44px、16px）才作用得到 */}
        <SettingsDialog
          open={ws.settingsOpen}
          onClose={ws.closeSettings}
          channels={ws.channels as never}
          setChannels={ws.setChannels as never}
          activeChannelId={ws.activeChannelId}
          setActiveChannelId={ws.setActiveChannelId as never}
          agentCfg={ws.agentCfg as never}
          setAgentCfg={ws.setAgentCfg as never}
        />
        {/* ChatPanel / SettingsDialog 里的 alert、confirm 走桌面那条 dialogs.js 队列；
            移动壳不挂 DialogHost 的话这些调用会永远不 resolve（删除渠道按不动） */}
        <DialogHost />
      </div>
    </div>
  )
}

export default function PaperLiteMobile() {
  return (
    <HashRouter>
      {/* Provider 持有一份共享工作区，四个 flow 读同一份 tabs / 草稿 / 保存实现 */}
      <MobileWorkspaceProvider>
        <MobileShell />
      </MobileWorkspaceProvider>
    </HashRouter>
  )
}

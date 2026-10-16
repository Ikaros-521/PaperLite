// =============================================
// PAPERLITE MOBILE · App Shell
// 3 Tab（文稿 / AI / 设置）+ 4 个 flow 的路由装配
// 导航模式：根层 TabBar，工作区/编译/历史走 Stack push（隐藏 TabBar）
// =============================================

import { type CSSProperties, useState } from 'react'
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Button, Empty, List, NavBar, NoticeBar, SafeArea, TabBar, Tag, Toast } from 'antd-mobile'
import { FileOutline, MessageOutline, SetOutline } from 'antd-mobile-icons'
import './mobile-theme.css'
import { Screen1_DocumentsHome } from './flow-1-documents'
import { Flow2_Workspace } from './flow-2-editor'
import { Flow3_Compile } from './flow-3-compile'
import { Flow4_History, Screen4_RestoreBanner, Screen5_OfflineState } from './flow-4-history'
import { useKeyboardInset } from './shared/hooks'
import { mockRestorePrompt } from './shared/mock-data'

/**
 * 用 HashRouter 而不是 BrowserRouter：
 * vite.config.js 是 base: './'（要支持 dist 双击打开与 Electron file://），
 * 且 server.mjs 只兜 API，没有 SPA fallback —— 真路径 /m/workspace/d1 刷新即 404。
 */
const TABS = [
  { key: '/m', title: '文稿', icon: <FileOutline /> },
  { key: '/m/chat', title: 'AI', icon: <MessageOutline /> },
  { key: '/m/settings', title: '设置', icon: <SetOutline /> },
]

/** 全屏工作区不吃 TabBar：底部再挂 50px 会把工具带顶到键盘之上 */
const IMMERSIVE = ['/m/workspace', '/m/compile', '/m/history', '/m/offline']

function DocumentsTab() {
  const [prompt, setPrompt] = useState(mockRestorePrompt)

  return (
    <Screen1_DocumentsHome
      banner={
        prompt ? (
          <Screen4_RestoreBanner
            prompt={prompt}
            onRestore={() => {
              const count = prompt.pendingTabs.length
              setPrompt(null)
              Toast.show({ content: `已恢复 ${count} 个草稿`, icon: 'success' })
            }}
            onDiscard={() => setPrompt(null)}
          />
        ) : undefined
      }
    />
  )
}

function ChatTab() {
  const navigate = useNavigate()
  return (
    <div className="pl-screen">
      <NavBar back={null}>AI 助手</NavBar>
      <div className="pl-content" style={{ textAlign: 'center', padding: '32px 16px' }}>
        {/* Empty 不接受 children，CTA 放外层 div */}
        <Empty description="AI 改写要贴着选区触发，不在独立页里聊" />
        <div style={{ marginTop: 16 }}>
          <Button color="primary" onClick={() => navigate('/m/workspace/d1')}>
            打开最近的稿子
          </Button>
        </div>
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--ink-faint)' }}>
          对话面板在工作区右上角 ⋯ 内，选中段落后就地改写。
        </div>
      </div>
    </div>
  )
}

function SettingsTab() {
  const navigate = useNavigate()
  return (
    <div className="pl-screen">
      <NavBar back={null}>设置</NavBar>
      <div className="pl-content">
        <NoticeBar color="info" content="移动端设置流本轮未设计，以下为只读摘要；改动请到桌面端。" />
        <List header="外观与语言">
          <List.Item extra="宣纸">皮肤</List.Item>
          <List.Item extra="中文">界面语言</List.Item>
          <List.Item extra="14px">编辑器字号</List.Item>
        </List>
        <List header="界面形态">
          {/* 与桌面「手机版」对称：改 hash 后 reload，让 main.jsx 重新决定渲染哪棵树 */}
          <List.Item
            clickable
            arrowIcon
            extra="回到三栏工作台"
            onClick={() => {
              window.location.hash = '#/'
              window.location.reload()
            }}
          >
            切换到桌面版
          </List.Item>
        </List>
        <List header="编译">
          <List.Item clickable arrowIcon extra="XeLaTeX（本机）" onClick={() => navigate('/m/offline')}>
            默认引擎与状态
          </List.Item>
          <List.Item extra={<Tag fill="outline">98 MB 可清理</Tag>}>内置 TeX 资源</List.Item>
        </List>
        <List header="AI">
          <List.Item extra={<Tag fill="outline">桌面端配置</Tag>}>渠道与密钥</List.Item>
          <List.Item extra="上下文压缩：自动">Token 用量</List.Item>
        </List>
      </div>
    </div>
  )
}

function MobileShell() {
  const location = useLocation()
  const navigate = useNavigate()
  const keyboard = useKeyboardInset()

  const immersive = IMMERSIVE.some(path => location.pathname.startsWith(path))
  const activeKey = TABS.find(tab => tab.key === location.pathname)?.key ?? ''

  return (
    <div className="pl-mobile" style={{ '--pl-keyboard': `${keyboard}px` } as CSSProperties}>
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
                <TabBar.Item key={tab.key} icon={tab.icon} title={tab.title} />
              ))}
            </TabBar>
            <SafeArea position="bottom" />
          </div>
        )}
      </div>
    </div>
  )
}

export default function PaperLiteMobile() {
  return (
    <HashRouter>
      <MobileShell />
    </HashRouter>
  )
}

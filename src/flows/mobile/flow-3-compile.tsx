// =============================================
// FLOW: Compile & Export PDF (4 screens)
// Scenario: Mobile Productivity（适配到 LaTeX 编译链）
//   锚点 = Canonical Flow 2「单 Sheet 内完成复杂配置，不跳子页」
//   差异 = ① 配置维度是引擎与编译对象，不是重复频率
//          ② 提交后是异步长任务，需要进度 + 取消 + 后台化
//          ③ 结果页是 PDF 查看与分享，不是列表原地更新
// Platform: H5 (Ant Design Mobile)
// 编译链 = 共享 useCompile（与桌面同一套引擎探测 / 预热 / 取消 / 结果语义）
// =============================================

import { useEffect, useRef, useState } from 'react'
import {
  Button,
  Collapse,
  Dialog,
  List,
  Mask,
  NavBar,
  NoticeBar,
  Popup,
  ProgressBar,
  Result,
  Selector,
  SpinLoading,
  Tag,
  Toast,
} from 'antd-mobile'
import {
  ClockCircleOutline,
  DownlandOutline,
  ExclamationTriangleOutline,
  LoopOutline,
  RightOutline,
  SendOutline,
  StopOutline,
} from 'antd-mobile-icons'
import { useNavigate, useParams } from 'react-router-dom'
import PdfViewer from '../../components/PdfViewer.jsx'
import { formatBytes, formatLine } from './shared/format'
import { useNetworkState } from './shared/hooks'
import { ENGINE_LABEL, ENGINE_STATUS_LABEL } from './shared/labels'
import { useMobileWorkspace } from './mobileWorkspace'

/**
 * 内置 XeLaTeX 首次编译要拉约 98 MB TeX 资源（见 src/i18n.js 的 tour.tex.body）。
 * 桌面在局域网内无所谓，手机在蜂窝网络下必须先问一次。
 */
const WARMUP_BYTES = 98 * 1024 * 1024

const STATUS_LABEL = ENGINE_STATUS_LABEL

/** 编译阶段：配置 → 进行中 → 成功 / 失败 */
type Stage = 'config' | 'running' | 'done' | 'failed'

/* ================================================
   FLOW: Compile & Export PDF
   SCREEN 1 of 4: 编译 Sheet
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  工作区顶栏「编译」或工具带「编译」
   EXIT:   「开始编译」→ Screen 2（进行中）
   BRANCH: 蜂窝网络且引擎待预热 → 先弹流量确认；返回 → 回工作区
   ================================================ */
function Screen1_CompileSheet({
  onBack,
  onStart,
  onOpenEngineStatus,
}: {
  onBack: () => void
  onStart: () => void
  onOpenEngineStatus: () => void
}) {
  const ws = useMobileWorkspace()
  const network = useNetworkState()
  const builtin = ws.engine === 'builtin'
  const siblings = ws.tabs.filter(tab => tab.id !== ws.activeTab?.id && tab.doc)
  const options = (ws.engines.length ? ws.engines : ['builtin']).map(name => ({
    label: name === ws.engine
      ? ENGINE_LABEL[name as keyof typeof ENGINE_LABEL]
      : `${ENGINE_LABEL[name as keyof typeof ENGINE_LABEL]}（未检测到）`,
    value: name,
  }))

  const start = () => {
    // 移动网络 + 首次预热 = 98 MB 流量，必须显式确认（桌面端无此风险，属移动端新增拦截）
    if (builtin && ws.builtinStatus !== 'ready' && network !== 'online') {
      Dialog.confirm({
        title: '需要下载引擎资源',
        content: `首次用内置 XeLaTeX 会拉取约 ${formatBytes(WARMUP_BYTES)} 的 TeX 资源，之后可离线使用。当前网络为${network === 'offline' ? '离线' : '弱网'}，建议连 Wi-Fi 后再试。`,
        confirmText: '仍要编译',
        cancelText: '先回编辑',
        onConfirm: onStart,
      })
      return
    }
    onStart()
  }

  return (
    <Popup
      visible
      position="bottom"
      onClose={onBack}
      closeOnSwipe
      bodyStyle={{ borderTopLeftRadius: 12, borderTopRightRadius: 12 }}
    >
      <div className="pl-sheet">
        <div className="pl-sheet-head">
          <span>编译</span>
          <Button fill="none" size="small" onClick={onBack}>
            返回
          </Button>
        </div>

        <div className="pl-sheet-body">
          <div style={{ padding: '12px 16px 0' }}>
            <div style={{ marginBottom: 8, color: 'var(--ink-soft)', fontSize: 12 }}>引擎</div>
            {/* 桌面同款探测结果：本机 TeX 排在前面，内置 wasm 始终兜底 */}
            <Selector
              columns={2}
              value={[ws.engine]}
              onChange={v => ws.setEngine(String(v[0] || 'builtin'))}
              options={options}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <Tag color={builtin && ws.builtinStatus === 'error' ? 'danger' : 'success'} fill="outline">
                {builtin ? STATUS_LABEL[ws.builtinStatus] || ws.builtinStatus : '本机服务在线'}
              </Tag>
              <span style={{ fontSize: 11, color: 'var(--ink-faint)', flex: 1 }}>
                {builtin ? '浏览器内 wasm，首次需预热资源' : '调用本机 TeX 发行版'}
              </span>
              <Button className="pl-min-touch" fill="none" size="small" style={{ color: 'var(--accent)' }} onClick={onOpenEngineStatus}>
                详情
              </Button>
            </div>
          </div>

          <List header="编译对象" style={{ marginTop: 12 }}>
            <List.Item extra={ws.activeTab?.name || '—'}>主文件</List.Item>
            <List.Item
              extra={<span className="pl-num">{siblings.length} 个</span>}
              description={siblings.length ? '同会话打开的其它文本标签会一并按 \\input 解析' : '没有其它已打开的文本标签'}
            >
              兄弟文件
            </List.Item>
          </List>

          <div style={{ padding: '12px 16px', color: 'var(--ink-faint)', fontSize: 11, lineHeight: 1.7 }}>
            编译产物是真实分页 PDF；投稿前请以它为准，网页预览只是近似排版。
          </div>
        </div>

        <div className="pl-sheet-foot">
          {/* STATE: default — 引擎可用，主按钮直达 Screen 2 */}
          {/* STATE: running — 编译中禁用，防重复提交 */}
          {/* STATE: error — 预热失败时仍可点，原因在 Screen 4 展开 */}
          <Button block color="primary" size="large" disabled={ws.compiling} onClick={start}>
            {ws.compiling ? '编译中…' : '开始编译'}
          </Button>
        </div>
      </div>
    </Popup>
  )
}

// → 「开始编译」→ SCREEN 2: 编译进行中

/* ================================================
   FLOW: Compile & Export PDF
   SCREEN 2 of 4: 编译进行中
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  Screen 1 主按钮（或失败页「重试」）
   EXIT:   成功 → Screen 3；失败 → Screen 4；取消 → 回配置并保留上次结果
   BRANCH: 「切到后台」→ 关闭遮罩继续跑，完成后 Toast 提醒
   ================================================ */
function Screen2_Compiling({
  elapsed,
  onCancel,
  onBackground,
}: {
  elapsed: number
  onCancel: () => void
  onBackground: () => void
}) {
  return (
    <Mask visible disableBodyScroll>
      <div
        style={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '0 28px',
          color: 'var(--ink)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <SpinLoading color="primary" />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>XeLaTeX 编译中</div>
            <div className="pl-num" style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
              已用 {(elapsed / 1000).toFixed(1)} 秒 · 首次编译含资源预热会更久
            </div>
          </div>
        </div>

        <ProgressBar percent={Math.min(96, Math.round((elapsed / 20_000) * 100))} style={{ marginTop: 16 }} />

        {/* 长任务在移动端一定要给「不阻塞」出口：切后台后仍可被 Toast 唤回结果 */}
        <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
          <Button block fill="outline" onClick={onBackground}>
            切到后台
          </Button>
          <Button block color="danger" fill="outline" onClick={onCancel}>
            <StopOutline /> 取消
          </Button>
        </div>
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--ink-faint)' }}>
          切到后台不会中断编译，离开本页也不停止；完成后会提示。
        </div>
      </div>
    </Mask>
  )
}

// → 编译成功 → SCREEN 3: PDF 结果页
// → 编译失败 → SCREEN 4: 逐错跳行页

/* ================================================
   FLOW: Compile & Export PDF
   SCREEN 3 of 4: PDF 结果页（真 pdfjs 渲染）
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  Screen 2 成功回调
   EXIT:   「回稿子继续改」→ 工作区；下载与分享由本屏工具条发起
   BRANCH: 源码在编译后又改过 → 下载前弹「旧版本」确认
   ================================================ */
function Screen3_PdfResult({ url, title, stale, onBack }: { url: string; title: string; stale: boolean; onBack: () => void }) {
  const ws = useMobileWorkspace()

  const download = async () => {
    try {
      const blob = await (await fetch(url)).blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = title.replace(/\.(tex|md|txt)$/i, '.pdf')
      a.click()
      URL.revokeObjectURL(objectUrl)
      Toast.show({ content: 'PDF 已下载', icon: 'success' })
    } catch {
      Toast.show({ content: '下载失败，可回桌面端重试', icon: 'fail' })
    }
  }

  const confirmDownload = () => {
    if (!stale) { download(); return }
    // 旧 PDF 直接发出去，用户会以为交上去的是最新稿
    Dialog.confirm({
      title: '这是上次编译的旧 PDF',
      content: '源码已修改，此 PDF 未反映最新改动。仍要下载吗？',
      confirmText: '仍要下载',
      cancelText: '先重新编译',
      onConfirm: download,
    })
  }

  const share = async () => {
    try {
      const blob = await (await fetch(url)).blob()
      const file = new File([blob], title.replace(/\.(tex|md|txt)$/i, '.pdf'), { type: 'application/pdf' })
      if (typeof navigator.canShare !== 'function' || !navigator.canShare({ files: [file] })) throw new Error('unsupported')
      await navigator.share({ files: [file], title: 'PaperLite 编译结果' })
      Toast.show({ content: '已调起系统分享', icon: 'success' })
    } catch {
      Toast.show({ content: '该浏览器不支持直接分享，已改为下载' })
      confirmDownload()
    }
  }

  return (
    <div className="pl-screen">
      <NavBar onBack={onBack}>
        <span className="pl-nav-name">{title.replace(/\.(tex|md|txt)$/i, '.pdf')}</span>
      </NavBar>

      {stale && <NoticeBar color="alert" content="源码在编译后又改过，此 PDF 是上次编译的旧版本。" />}

      {/* 真渲染：pdfjs-dist + 文本层 + 按滚动位置反推当前页（与桌面同一组件） */}
      <div className="pl-pdf-host">
        <PdfViewer url={url} title={title} lang={ws.lang} onDownload={confirmDownload} onClose={onBack} />
      </div>

      <div className="pl-toolbelt">
        <div className="pl-scroll-x" style={{ alignItems: 'center' }}>
          <Button size="small" fill="outline" onClick={confirmDownload}>
            <DownlandOutline /> 下载 PDF
          </Button>
          <Button size="small" fill="outline" onClick={share}>
            <SendOutline /> 分享
          </Button>
          <span style={{ flex: 1 }} />
          <Button size="small" color="primary" onClick={onBack}>
            回稿子继续改
          </Button>
        </div>
      </div>
    </div>
  )
}

// → 点「返回」→ 回工作区（Flow 2 Screen 2）

/* ================================================
   FLOW: Compile & Export PDF
   SCREEN 4 of 4: 编译失败 · 逐错跳行
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  Screen 2 失败回调（含引擎级失败，line 为 null）
   EXIT:   「跳到该行」→ 工作区源码指定行；「重试」→ 回 Screen 2
   BRANCH: 「复制日志」→ 剪贴板；「完整日志」→ 展开 Collapse
   ================================================ */
function Screen4_CompileFailed({
  result,
  onJump,
  onRetry,
  onBack,
}: {
  result: NonNullable<ReturnType<typeof useMobileWorkspace>['compileResult']>
  onJump: (line: number) => void
  onRetry: () => void
  onBack: () => void
}) {
  const errors = result.errors || []

  return (
    <div className="pl-screen">
      <NavBar onBack={onBack}>
        <span className="pl-nav-name">编译失败</span>
      </NavBar>

      <Result
        status="error"
        title={`${errors.length || 1} 个错误`}
        description={`${ENGINE_LABEL[result.engine as keyof typeof ENGINE_LABEL] || result.engine} · 未生成 PDF`}
      />

      <div className="pl-content" style={{ padding: '0 12px 12px' }}>
        {/* STATE: error — 逐错列表；line 为 null 的引擎级错误只说明不跳行 */}
        <List header="错误（点行号跳到源码）">
          {errors.length === 0 && <List.Item description={result.error || '引擎未返回具体错误'}>编译中断</List.Item>}
          {errors.map((error, index) => (
            <List.Item
              key={`${error.line ?? 'engine'}-${index}`}
              clickable={error.line !== null}
              prefix={<ExclamationTriangleOutline style={{ color: 'var(--seal)' }} />}
              extra={error.line !== null ? <RightOutline /> : undefined}
              description={<span style={{ whiteSpace: 'normal' }}>{error.msg}</span>}
              title={<span className="pl-num">{formatLine(error.line)}</span>}
              onClick={() => error.line !== null && onJump(error.line)}
            >
              <span className="pl-num">L{error.line ?? '—'}</span>
            </List.Item>
          ))}
        </List>

        <Collapse style={{ marginTop: 12 }}>
          <Collapse.Panel key="log" title="完整日志">
            <pre
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                fontSize: 11,
                lineHeight: 1.6,
                fontFamily: "Consolas, 'Courier New', monospace",
              }}
            >
              {result.log || '（无日志）'}
            </pre>
          </Collapse.Panel>
        </Collapse>

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <Button
            block
            fill="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(result.log || '')
                Toast.show({ content: '编译日志已复制到剪贴板', icon: 'success' })
              } catch {
                Toast.show({ content: '浏览器拒绝了剪贴板权限', icon: 'fail' })
              }
            }}
          >
            复制日志
          </Button>
          <Button block color="primary" onClick={onRetry}>
            <LoopOutline /> 重试
          </Button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 11, color: 'var(--ink-faint)' }}>
          <ClockCircleOutline /> 近似排版通过不代表能编译，投稿前必须以真实 PDF 为准。
        </div>
      </div>
    </div>
  )
}

/* ================================================
   FLOW: Compile & Export PDF · 容器
   ================================================ */
export function Flow3_Compile() {
  const navigate = useNavigate()
  const { docId } = useParams()
  const ws = useMobileWorkspace()

  const [stage, setStage] = useState<Stage>('config')
  const [elapsed, setElapsed] = useState(0)
  const [backgrounded, setBackgrounded] = useState(false)
  const backgroundedRef = useRef(false)

  // 进行中：推进耗时；离开或取消必须清掉定时器
  useEffect(() => {
    if (stage !== 'running') return
    const started = Date.now()
    const tick = window.setInterval(() => setElapsed(Date.now() - started), 200)
    return () => clearInterval(tick)
  }, [stage])

  const run = async () => {
    setStage('running')
    setElapsed(0)
    const status = await ws.compile()
    const wasBackgrounded = backgroundedRef.current
    if (status === 'ok') {
      setStage('done')
      if (wasBackgrounded) Toast.show({ content: '编译完成，可去查看 PDF', position: 'bottom' })
    } else if (status === 'fail') {
      setStage('failed')
      if (wasBackgrounded) Toast.show({ content: '编译失败，点开看错误', position: 'bottom' })
    } else {
      setStage('config')
    }
    backgroundedRef.current = false
    setBackgrounded(false)
  }

  const cancel = () => {
    ws.cancelCompile()
    setStage('config')
    backgroundedRef.current = false
    setBackgrounded(false)
    Toast.show({ content: '已取消，保留上一次成功结果' })
  }

  const result = ws.compileResult
  const workspacePath = `/m/workspace/${docId ?? ws.activeTab?.id ?? ''}`

  if (stage === 'done' && result?.ok && result.pdfUrl) {
    return (
      <Screen3_PdfResult
        url={result.pdfUrl}
        title={ws.activeTab?.name || 'main'}
        stale={ws.pdfIsStale}
        onBack={() => navigate(workspacePath)}
      />
    )
  }

  if (stage === 'failed' && result && !result.ok) {
    return (
      <Screen4_CompileFailed
        result={result}
        onBack={() => setStage('config')}
        onRetry={run}
        onJump={line => navigate(`${workspacePath}?line=${line}`)}
      />
    )
  }

  return (
    <div className="pl-screen">
      {/* Sheet 需要上下文：底下一个工作区残影，避免「跳到一个空白页」 */}
      <NavBar back={null}>
        <span className="pl-nav-name">{ws.activeTab?.name || '工作区'}</span>
      </NavBar>
      <div className="pl-content" style={{ padding: 12, background: 'var(--desk)' }}>
        <div className="pl-paper" style={{ margin: 0, opacity: stage === 'running' ? 0.35 : 1, pointerEvents: 'none' }}>
          <p>{(ws.activeTab?.doc?.getValue() || '').slice(0, 160) || '（空文档）'}…（工作区残影）</p>
        </div>
      </div>

      {stage === 'config' && (
        <Screen1_CompileSheet
          onBack={() => navigate(workspacePath)}
          onStart={run}
          onOpenEngineStatus={() => navigate('/m/offline')}
        />
      )}

      {stage === 'running' && !backgrounded && (
        <Screen2_Compiling
          elapsed={elapsed}
          onCancel={cancel}
          onBackground={() => {
            backgroundedRef.current = true
            setBackgrounded(true)
            Toast.show({ content: '编译在后台继续，完成后提示', position: 'bottom' })
          }}
        />
      )}

      {stage === 'running' && backgrounded && (
        <NoticeBar
          color="info"
          content="编译在后台进行中…"
          extra={
            <Button fill="none" size="mini" onClick={() => setBackgrounded(false)}>
              查看
            </Button>
          }
        />
      )}
    </div>
  )
}

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
import { useT } from '../../useI18n.js'

/**
 * 内置 XeLaTeX 首次编译要拉约 98 MB TeX 资源（见 src/i18n.js 的 tour.tex.body）。
 * 桌面在局域网内无所谓，手机在蜂窝网络下必须先问一次。
 */
const WARMUP_BYTES = 98 * 1024 * 1024

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
  const t = useT()
  const network = useNetworkState()
  const builtin = ws.engine === 'builtin'
  const siblings = ws.tabs.filter(tab => tab.id !== ws.activeTab?.id && tab.doc)
  const options = (ws.engines.length ? ws.engines : ['builtin']).map(name => ({
    label: name === ws.engine
      ? t(ENGINE_LABEL[name as keyof typeof ENGINE_LABEL] || name)
      : t('mb.cp.engineUndetected', { name: t(ENGINE_LABEL[name as keyof typeof ENGINE_LABEL] || name) }),
    value: name,
  }))

  const start = () => {
    // 移动网络 + 首次预热 = 98 MB 流量，必须显式确认（桌面端无此风险，属移动端新增拦截）
    if (builtin && ws.builtinStatus !== 'ready' && network !== 'online') {
      Dialog.confirm({
        title: t('mb.cp.warmupTitle'),
        content: t('mb.cp.warmupBody', {
          size: formatBytes(WARMUP_BYTES),
          net: network === 'offline' ? t('mb.cp.netOffline') : t('mb.cp.netWeak'),
        }),
        confirmText: t('mb.cp.confirmCompile'),
        cancelText: t('mb.cp.backToEdit'),
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
          <span>{t('prev.compile')}</span>
          <Button fill="none" size="small" onClick={onBack}>
            {t('mb.cp.back')}
          </Button>
        </div>

        <div className="pl-sheet-body">
          <div style={{ padding: '12px 16px 0' }}>
            <div style={{ marginBottom: 8, color: 'var(--ink-soft)', fontSize: 12 }}>{t('mb.cp.engine')}</div>
            {/* 桌面同款探测结果：本机 TeX 排在前面，内置 wasm 始终兜底 */}
            <Selector
              columns={2}
              value={[ws.engine]}
              onChange={v => ws.setEngine(String(v[0] || 'builtin'))}
              options={options}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <Tag color={builtin && ws.builtinStatus === 'error' ? 'danger' : 'success'} fill="outline">
                {builtin ? t(ENGINE_STATUS_LABEL[ws.builtinStatus] || ws.builtinStatus) : t('mb.cp.localOnline')}
              </Tag>
              <span style={{ fontSize: 11, color: 'var(--ink-faint)', flex: 1 }}>
                {builtin ? t('mb.cp.builtinHint') : t('mb.cp.localHint')}
              </span>
              <Button className="pl-min-touch" fill="none" size="small" style={{ color: 'var(--accent)' }} onClick={onOpenEngineStatus}>
                {t('mb.cp.details')}
              </Button>
            </div>
          </div>

          <List header={t('mb.cp.targetGroup')} style={{ marginTop: 12 }}>
            <List.Item extra={ws.activeTab?.name || '—'}>{t('mb.cp.mainFile')}</List.Item>
            <List.Item
              extra={<span className="pl-num">{t('mb.cp.siblingCount', { n: siblings.length })}</span>}
              description={siblings.length ? t('mb.cp.siblingHint') : t('mb.cp.noSiblings')}
            >
              {t('mb.cp.siblingFiles')}
            </List.Item>
          </List>

          <div style={{ padding: '12px 16px', color: 'var(--ink-faint)', fontSize: 11, lineHeight: 1.7 }}>
            {t('mb.cp.pdfNote')}
          </div>
        </div>

        <div className="pl-sheet-foot">
          {/* STATE: default — 引擎可用，主按钮直达 Screen 2 */}
          {/* STATE: running — 编译中禁用，防重复提交 */}
          {/* STATE: error — 预热失败时仍可点，原因在 Screen 4 展开 */}
          <Button block color="primary" size="large" disabled={ws.compiling} onClick={start}>
            {ws.compiling ? t('mb.cp.compiling') : t('mb.cp.start')}
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
  const t = useT()

  return (
    <Mask visible opacity="thick" disableBodyScroll className="pl-compile-mask">
      <div className="pl-compile-card">
        <div className="pl-compile-top">
          <SpinLoading color="primary" />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{t('mb.cp.runningTitle')}</div>
            <div className="pl-num" style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
              {t('mb.cp.elapsed', { sec: (elapsed / 1000).toFixed(1) })}
            </div>
          </div>
        </div>

        <ProgressBar percent={Math.min(96, Math.round((elapsed / 20_000) * 100))} style={{ marginTop: 16 }} />

        {/* 长任务在移动端一定要给「不阻塞」出口：切后台后仍可被 Toast 唤回结果 */}
        <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
          <Button block fill="outline" onClick={onBackground}>
            {t('mb.cp.toBackground')}
          </Button>
          <Button block color="danger" fill="outline" onClick={onCancel}>
            <StopOutline /> {t('prev.cancel')}
          </Button>
        </div>
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--ink-faint)' }}>
          {t('mb.cp.backgroundNote')}
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
  const t = useT()

  const download = async () => {
    try {
      const blob = await (await fetch(url)).blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = title.replace(/\.(tex|md|txt)$/i, '.pdf')
      a.click()
      // iOS Safari 对 click 后立即 revoke 的 blob 下载可能静默失败（桌面 exporter 同款延时）
      setTimeout(() => URL.revokeObjectURL(objectUrl), 500)
      Toast.show({ content: t('mb.cp.pdfDownloaded'), icon: 'success' })
    } catch {
      Toast.show({ content: t('mb.cp.downloadFailed'), icon: 'fail' })
    }
  }

  const confirmDownload = () => {
    if (!stale) { download(); return }
    // 旧 PDF 直接发出去，用户会以为交上去的是最新稿
    Dialog.confirm({
      title: t('mb.cp.staleTitle'),
      content: t('mb.cp.staleBody'),
      confirmText: t('mb.cp.downloadAnyway'),
      cancelText: t('mb.cp.recompileFirst'),
      onConfirm: download,
    })
  }

  const share = async () => {
    try {
      const blob = await (await fetch(url)).blob()
      const file = new File([blob], title.replace(/\.(tex|md|txt)$/i, '.pdf'), { type: 'application/pdf' })
      if (typeof navigator.canShare !== 'function' || !navigator.canShare({ files: [file] })) throw new Error('unsupported')
      await navigator.share({ files: [file], title: t('mb.cp.shareTitle') })
      Toast.show({ content: t('mb.cp.shareOpened'), icon: 'success' })
    } catch {
      Toast.show({ content: t('mb.cp.shareUnsupported') })
      confirmDownload()
    }
  }

  return (
    <div className="pl-screen">
      <NavBar onBack={onBack}>
        <span className="pl-nav-name">{title.replace(/\.(tex|md|txt)$/i, '.pdf')}</span>
      </NavBar>

      {stale && <NoticeBar color="alert" content={t('mb.cp.staleNotice')} />}

      {/* 真渲染：pdfjs-dist + 文本层 + 按滚动位置反推当前页（与桌面同一组件） */}
      <div className="pl-pdf-host">
        <PdfViewer url={url} title={title} lang={ws.lang} onDownload={confirmDownload} onClose={onBack} />
      </div>

      <div className="pl-toolbelt">
        <div className="pl-scroll-x" style={{ alignItems: 'center' }}>
          <Button size="small" fill="outline" onClick={confirmDownload}>
            <DownlandOutline /> {t('mb.cp.downloadPdf')}
          </Button>
          <Button size="small" fill="outline" onClick={share}>
            <SendOutline /> {t('mb.cp.share')}
          </Button>
          <span style={{ flex: 1 }} />
          <Button size="small" color="primary" onClick={onBack}>
            {t('mb.cp.backToDraft')}
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
  const t = useT()
  const errors = result.errors || []

  return (
    <div className="pl-screen">
      <NavBar onBack={onBack}>
        <span className="pl-nav-name">{t('app.compileFailed')}</span>
      </NavBar>

      <Result
        status="error"
        title={t('mb.cp.errorCount', { n: errors.length || 1 })}
        description={t('mb.cp.noPdf', { engine: t(ENGINE_LABEL[result.engine as keyof typeof ENGINE_LABEL] || result.engine) })}
      />

      <div className="pl-content" style={{ padding: '0 12px 12px' }}>
        {/* STATE: error — 逐错列表；line 为 null 的引擎级错误只说明不跳行 */}
        <List header={t('mb.cp.errorGroup')}>
          {errors.length === 0 && <List.Item description={result.error || t('mb.cp.noEngineError')}>{t('mb.cp.aborted')}</List.Item>}
          {errors.map((error, index) => (
            <List.Item
              key={`${error.line ?? 'engine'}-${index}`}
              clickable={error.line !== null}
              prefix={<ExclamationTriangleOutline style={{ color: 'var(--seal)' }} />}
              extra={error.line !== null ? <RightOutline /> : undefined}
              description={<span style={{ whiteSpace: 'normal' }}>{error.msg}</span>}
              title={<span className="pl-num">{formatLine(error.line)}</span>}
              onClick={() => error.line !== null && onJump(error.line + 1)}
            >
              <span className="pl-num">L{error.line === null ? '—' : error.line + 1}</span>
            </List.Item>
          ))}
        </List>

        <Collapse style={{ marginTop: 12 }}>
          <Collapse.Panel key="log" title={t('prev.logFull')}>
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
              {result.log || t('mb.cp.noLog')}
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
                Toast.show({ content: t('prev.logCopied'), icon: 'success' })
              } catch {
                Toast.show({ content: t('mb.cp.clipboardDenied'), icon: 'fail' })
              }
            }}
          >
            {t('prev.copyLog')}
          </Button>
          <Button block color="primary" onClick={onRetry}>
            <LoopOutline /> {t('prev.retry')}
          </Button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 11, color: 'var(--ink-faint)' }}>
          <ClockCircleOutline /> {t('mb.cp.approxWarn')}
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
  const t = useT()

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
      if (wasBackgrounded) Toast.show({ content: t('mb.cp.bgDone'), position: 'bottom' })
    } else if (status === 'fail') {
      setStage('failed')
      if (wasBackgrounded) Toast.show({ content: t('mb.cp.bgFailed'), position: 'bottom' })
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
    Toast.show({ content: t('mb.cp.cancelled') })
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
        <span className="pl-nav-name">{ws.activeTab?.name || t('mb.cp.workspace')}</span>
      </NavBar>
      <div className="pl-content" style={{ padding: 12, background: 'var(--desk)' }}>
        <div className="pl-paper" style={{ margin: 0, opacity: stage === 'running' ? 0.35 : 1, pointerEvents: 'none' }}>
          <p>{(ws.activeTab?.doc?.getValue() || '').slice(0, 160) || t('mb.cp.emptyDoc')}{t('mb.cp.ghostSuffix')}</p>
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
            Toast.show({ content: t('mb.cp.bgStarted'), position: 'bottom' })
          }}
        />
      )}

      {stage === 'running' && backgrounded && (
        <NoticeBar
          color="info"
          content={t('mb.cp.bgRunning')}
          extra={
            <Button fill="none" size="mini" onClick={() => setBackgrounded(false)}>
              {t('mb.cp.view')}
            </Button>
          }
        />
      )}
    </div>
  )
}

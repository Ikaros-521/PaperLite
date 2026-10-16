// =============================================
// FLOW: Compile & Export PDF (4 screens)
// Scenario: Mobile Productivity（适配到 LaTeX 编译链）
//   锚点 = Canonical Flow 2「单 Sheet 内完成复杂配置，不跳子页」
//   差异 = ① 配置维度是引擎/作用域/子文件，不是重复频率
//          ② 提交后是异步长任务，需要进度 + 取消 + 后台化
//          ③ 结果页是 PDF 查看与分享，不是列表原地更新
// Platform: H5 (Ant Design Mobile)
// =============================================

import { useEffect, useRef, useState } from 'react'
import {
  Button,
  CheckList,
  Collapse,
  Dialog,
  List,
  Mask,
  NavBar,
  NoticeBar,
  Picker,
  Popup,
  ProgressBar,
  Result,
  Segmented,
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
import { formatBytes, formatDuration, formatLine, wait } from './shared/format'
import { useNetworkState } from './shared/hooks'
import { ENGINE_LABEL } from './shared/labels'
import {
  mockCompileFailSingle,
  mockCompileOk,
  mockEngines,
  mockImportable,
  mockSource,
} from './shared/mock-data'
import type { CompileConfig, CompileOutcome, EngineName, NetworkState } from './shared/types'

/**
 * 内置 XeLaTeX 首次编译要拉约 98 MB TeX 资源（见 src/i18n.js 的 tour.tex.body）。
 * 桌面端不关心这个，移动端必须在点「开始编译」之前拦一次。
 */
const WARMUP_BYTES = 98 * 1024 * 1024

const PROJECT_FILES = mockImportable.filter(f => f.kind !== 'image' && f.kind !== 'pdf')

/** 编译阶段：配置 → 进行中 → 成功 / 失败 */
type Stage = 'config' | 'running' | 'done' | 'failed'

/* ================================================
   FLOW: Compile & Export PDF
   SCREEN 1 of 4: 编译 Sheet
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  工作区顶栏「编译」
   EXIT:   「开始编译」→ Screen 2（进行中）
   BRANCH: 蜂窝网络且引擎待预热 → 先弹流量确认 Dialog；返回 → 回工作区
   ================================================ */
function Screen1_CompileSheet({
  config,
  onConfigChange,
  onStart,
  onBack,
  network,
  onOpenEngineStatus,
}: {
  config: CompileConfig
  onConfigChange: (next: CompileConfig) => void
  onStart: () => void
  onBack: () => void
  network: NetworkState
  onOpenEngineStatus: () => void
}) {
  const [mainPicker, setMainPicker] = useState(false)
  const engine = mockEngines.find(e => e.name === config.engine)
  const needsWarmup = config.engine === 'builtin'

  const toggleIncluded = (names: (string | number)[]) =>
    onConfigChange({ ...config, includedFiles: names as string[] })

  const start = () => {
    if (!engine?.available) {
      Toast.show({ content: engine?.note ?? '该引擎当前不可用', icon: 'fail' })
      return
    }
    // 移动网络 + 首次预热 = 98 MB 流量，必须显式确认（桌面端无此风险，属移动端新增拦截）
    if (needsWarmup && network !== 'online') {
      Dialog.confirm({
        title: '需要下载引擎资源',
        content: `首次用内置 XeLaTeX 会拉取约 ${formatBytes(WARMUP_BYTES)} 的 TeX 资源，之后可离线使用。当前网络为${network === 'offline' ? '离线' : '弱网'}，建议连 Wi-Fi 后再试。`,
        confirmText: '仍要编译',
        cancelText: '改用近似排版',
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
            <Selector
              columns={2}
              value={[config.engine]}
              onChange={v => onConfigChange({ ...config, engine: (v[0] as EngineName) ?? 'builtin' })}
              options={mockEngines.map(item => ({
                label: item.available ? ENGINE_LABEL[item.name] : `${ENGINE_LABEL[item.name]}（不可用）`,
                value: item.name,
              }))}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <Tag color={engine?.available ? 'success' : 'danger'} fill="outline">
                {engine?.available ? '已就绪' : '不可用'}
              </Tag>
              <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>{engine?.note}</span>
              {!engine?.available && (
                <Button fill="none" size="mini" style={{ color: 'var(--accent)' }} onClick={onOpenEngineStatus}>
                  查看引擎状态
                </Button>
              )}
            </div>
          </div>

          <div style={{ padding: '16px 16px 0' }}>
            <div style={{ marginBottom: 8, color: 'var(--ink-soft)', fontSize: 12 }}>编译作用域</div>
            <Segmented
              block
              value={config.scope}
              onChange={v => onConfigChange({ ...config, scope: v === 'project' ? 'project' : 'current' })}
              options={[
                { label: '当前文档', value: 'current' },
                { label: '整个项目', value: 'project' },
              ]}
            />
          </div>

          <List header="主文件" style={{ marginTop: 8 }}>
            <List.Item clickable arrowIcon onClick={() => setMainPicker(true)}>
              {config.mainFile}
            </List.Item>
          </List>

          <List header="一并上传的子文件（\input / \include）">
            <CheckList
              multiple
              value={config.includedFiles}
              onChange={toggleIncluded}
            >
              {PROJECT_FILES.filter(f => f.name !== config.mainFile).map(file => (
                <CheckList.Item key={file.name} value={file.name}>
                  {file.name}
                </CheckList.Item>
              ))}
            </CheckList>
          </List>

          {config.scope === 'project' && (
            <div style={{ padding: '8px 16px', color: 'var(--ink-faint)', fontSize: 11 }}>
              整个项目会把文件夹内未保存的改动一并打包，等同桌面端「提交材料」的归档行为。
            </div>
          )}
        </div>

        <div className="pl-sheet-foot">
          {/* STATE: default — 引擎可用，主按钮直达 Screen 2 */}
          {/* STATE: error — 引擎不可用时点主按钮只提示原因，不进入进行中 */}
          <Button block color="primary" size="large" onClick={start}>
            开始编译
          </Button>
        </div>
      </div>

      <Picker
        visible={mainPicker}
        onClose={() => setMainPicker(false)}
        value={[config.mainFile]}
        columns={[PROJECT_FILES.map(f => ({ label: f.name, value: f.name }))]}
        onConfirm={v => onConfigChange({ ...config, mainFile: String(v[0] ?? config.mainFile) })}
      />
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
   EXIT:   成功 → Screen 3；失败 → Screen 4；取消 → 回工作区并保留上次结果
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
  const percent = Math.min(96, Math.round((elapsed / 2_005) * 100))

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <SpinLoading color="primary" />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>XeLaTeX 编译中</div>
            <div className="pl-num" style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
              已用 {(elapsed / 1000).toFixed(1)} 秒 · 上次成功耗时 {formatDuration(mockCompileOk.elapsedMs)}
            </div>
          </div>
        </div>

        <ProgressBar percent={percent} style={{ marginTop: 16 }} />

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
   SCREEN 3 of 4: PDF 结果页
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  Screen 2 成功回调
   EXIT:   「下载」保存 PDF；「分享」走系统面板；返回 → 工作区（previewMode 回到近似排版）
   BRANCH: 源码在编译后又改过 → 下载前弹「旧版本」确认
   ================================================ */
function Screen3_PdfResult({
  result,
  stale,
  onBack,
}: {
  result: CompileOutcome
  stale: boolean
  onBack: () => void
}) {
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState('fit')
  const widthByZoom: Record<string, number> = { fit: 100, wide: 150, full: 320 }
  const width = widthByZoom[zoom] ?? 100

  const download = () => {
    if (stale) {
      Dialog.confirm({
        title: '这是上次编译的旧 PDF',
        content: '源码已修改，此 PDF 未反映最新改动。仍要下载吗？',
        confirmText: '仍要下载',
        cancelText: '先重新编译',
        onConfirm: () => Toast.show({ content: '已保存 main.pdf', icon: 'success' }),
      })
      return
    }
    Toast.show({ content: '已保存 main.pdf', icon: 'success' })
  }

  const share = async () => {
    // 跨源 blob 无法直接分享，失败必须降级为下载，否则用户完全没有出口
    try {
      if (typeof navigator.share !== 'function') throw new Error('unsupported')
      await navigator.share({ title: 'PaperLite 编译结果', url: result.pdfUrl ?? undefined })
      Toast.show({ content: '已调起系统分享', icon: 'success' })
    } catch {
      Toast.show({ content: '该浏览器不支持直接分享，已改为下载' })
      download()
    }
  }

  return (
    <div className="pl-screen">
      <NavBar onBack={onBack}>
        <span className="pl-nav-name">main.pdf · {result.pageCount} 页</span>
      </NavBar>

      {stale && (
        <NoticeBar color="alert" content="源码在编译后又改过，此 PDF 是上次编译的旧版本。" />
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--chrome)' }}>
        <Segmented
          value={zoom}
          onChange={v => setZoom(String(v))}
          options={[
            { label: '适应宽度', value: 'fit' },
            { label: '150%', value: 'wide' },
            { label: '放大看细节', value: 'full' },
          ]}
        />
      </div>

      {/* 真实实现复用桌面 PdfViewer（pdfjs-dist，含文本层；当前页由滚动位置反推，见 PdfViewer.jsx:87-89） */}
      <div
        className="pl-content"
        style={{
          padding: 12,
          background: 'var(--desk)',
          // 放大时横向滚动必须挂在容器上，挂在页面上会变成页内滚动条
          overflowX: zoom === 'fit' ? 'hidden' : 'auto',
        }}
      >
        {Array.from({ length: result.pageCount }, (_, i) => i + 1).map(number => (
          <div
            key={number}
            data-page={number}
            style={{
              width: zoom === 'fit' ? '100%' : `${width}%`,
              aspectRatio: '210 / 297',
              margin: '0 auto 12px',
              background: 'var(--doc-paper)',
              border: '1px solid var(--line)',
              borderRadius: 4,
              display: 'grid',
              placeItems: 'center',
              color: 'var(--ink-faint)',
              fontSize: 12,
            }}
          >
            第 {number} 页 A4 · 可纵向滚动
          </div>
        ))}
      </div>

      <div className="pl-toolbelt">
        <div className="pl-scroll-x" style={{ alignItems: 'center' }}>
          <Button
            size="small"
            fill="outline"
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            上一页
          </Button>
          <span className="pl-num" style={{ minWidth: 64, textAlign: 'center', fontSize: 13 }}>
            {page} / {result.pageCount}
          </span>
          <Button
            size="small"
            fill="outline"
            onClick={() => setPage(p => Math.min(result.pageCount, p + 1))}
            disabled={page >= result.pageCount}
          >
            下一页
          </Button>
          <span style={{ flex: 1 }} />
          <Button size="small" color="primary" onClick={download}>
            <DownlandOutline /> 下载
          </Button>
          <Button size="small" onClick={share}>
            <SendOutline /> 分享
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
   BRANCH: 「复制日志」→ 剪贴板；「查看完整日志」→ 展开 Collapse
   ================================================ */
function Screen4_CompileFailed({
  result,
  onJump,
  onRetry,
  onBack,
}: {
  result: CompileOutcome
  onJump: (line: number) => void
  onRetry: () => void
  onBack: () => void
}) {
  return (
    <div className="pl-screen">
      <NavBar onBack={onBack}>
        <span className="pl-nav-name">编译失败</span>
      </NavBar>

      <Result
        status="error"
        title={`${result.errors.length} 个错误`}
        description={`引擎 ${ENGINE_LABEL[result.engine]} · 耗时 ${formatDuration(result.elapsedMs)} · 未生成 PDF`}
      />

      <div style={{ padding: '0 12px 12px' }}>
        {/* STATE: error — 逐错列表；line 为 null 的引擎级错误只说明不跳行 */}
        <List header="错误（点行号跳到源码）">
          {result.errors.map((error, index) => (
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
              {result.log}
            </pre>
          </Collapse.Panel>
        </Collapse>

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <Button
            block
            fill="outline"
            onClick={() => Toast.show({ content: '编译日志已复制到剪贴板', icon: 'success' })}
          >
            复制日志
          </Button>
          <Button block color="primary" onClick={onRetry}>
            <LoopOutline /> 重试
          </Button>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 12,
            fontSize: 11,
            color: 'var(--ink-faint)',
          }}
        >
          <ClockCircleOutline /> 近似排版通过不代表能编译，投稿前必须以真实 PDF 为准。
        </div>
      </div>
    </div>
  )
}

/* ================================================
   FLOW: Compile & Export PDF · 容器
   持有 stage / config / 耗时计时 / 结果，串起 Screen 1→2→3|4
   ================================================ */
export function Flow3_Compile() {
  const navigate = useNavigate()
  const { docId } = useParams()
  const network = useNetworkState()

  const [stage, setStage] = useState<Stage>('config')
  const [elapsed, setElapsed] = useState(0)
  const [backgrounded, setBackgrounded] = useState(false)
  const backgroundedRef = useRef(false)
  const [result, setResult] = useState<CompileOutcome>(mockCompileOk)
  const [config, setConfig] = useState<CompileConfig>({
    engine: 'xelatex',
    mainFile: 'main.tex',
    includedFiles: ['method.tex'],
    scope: 'current',
  })

  // 进行中：每秒推进耗时；离开或取消必须清掉定时器
  useEffect(() => {
    if (stage !== 'running') return
    const started = Date.now()
    const tick = window.setInterval(() => setElapsed(Date.now() - started), 200)
    return () => clearInterval(tick)
  }, [stage])

  const run = async () => {
    setStage('running')
    setElapsed(0)
    await wait(2_200)
    // 作用域决定结果：只编单章节文件缺导言区必失败，整项目才可能出 PDF
    const outcome = config.scope === 'project' ? mockCompileOk : mockCompileFailSingle
    setResult(outcome)
    setStage(outcome.ok ? 'done' : 'failed')
    if (backgroundedRef.current) {
      Toast.show({
        content: outcome.ok ? '编译完成，可去查看 PDF' : `编译失败：${outcome.errors.length} 个错误`,
        position: 'bottom',
      })
    }
    backgroundedRef.current = false
    setBackgrounded(false)
  }

  const cancel = () => {
    setStage('config')
    backgroundedRef.current = false
    setBackgrounded(false)
    Toast.show({ content: '已取消，保留上一次成功结果' })
  }

  if (stage === 'done') {
    return (
      <Screen3_PdfResult
        result={result}
        stale={!!result.source && result.source !== mockSource}
        onBack={() => navigate(`/m/workspace/${docId ?? 'd1'}`)}
      />
    )
  }

  if (stage === 'failed') {
    return (
      <Screen4_CompileFailed
        result={result}
        onBack={() => setStage('config')}
        onRetry={run}
        onJump={line => navigate(`/m/workspace/${docId ?? 'd1'}?line=${line}`)}
      />
    )
  }

  return (
    <div className="pl-screen">
      {/* Sheet 需要上下文：底下一个工作区残影，避免「跳到一个空白页」 */}
      <NavBar back={null}>
        <span className="pl-nav-name">第三章-方法设计.tex</span>
      </NavBar>
      <div className="pl-content" style={{ padding: 12, background: 'var(--desk)' }}>
        <div
          className="pl-paper"
          style={{ margin: 0, opacity: stage === 'running' ? 0.35 : 1, pointerEvents: 'none' }}
        >
          <p>设词序列为 X，编码后隐藏状态记为 hᵢ，注意力权重按式 (3-1) 归一化…（工作区残影）</p>
        </div>
      </div>

      {stage === 'config' && (
        <Screen1_CompileSheet
          config={config}
          network={network}
          onConfigChange={setConfig}
          onStart={run}
          onOpenEngineStatus={() => navigate('/m/offline')}
          onBack={() => navigate(`/m/workspace/${docId ?? 'd1'}`)}
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
          extra={<Button fill="none" size="mini" onClick={() => setBackgrounded(false)}>查看</Button>}
        />
      )}
    </div>
  )
}

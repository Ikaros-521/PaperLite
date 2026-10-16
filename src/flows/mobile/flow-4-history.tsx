// =============================================
// FLOW: Version History & Failure States (5 screens)
// Scenario: Mobile Productivity（适配到版本快照与丢稿防护）
//   锚点 = Canonical Flow 2/3「Action Sheet + Detail」模式
//   差异 = ① Detail 对象是版本 diff，桌面 1400px 双栏在移动端必须降级为行内
//          ② 新增冷启动恢复与配额预警（任务管理的前提是「无需草稿保存」，PaperLite 相反）
// Platform: H5 (Ant Design Mobile)
// =============================================

import { useEffect, useState } from 'react'
import {
  ActionSheet,
  Button,
  Dialog,
  List,
  NavBar,
  NoticeBar,
  Popup,
  ProgressBar,
  Segmented,
  SpinLoading,
  Tag,
  Toast,
} from 'antd-mobile'
import {
  DeleteOutline,
  EditSOutline,
  ExclamationTriangleOutline,
  GlobalOutline,
  LoopOutline,
  RightOutline,
} from 'antd-mobile-icons'
import { useNavigate, useParams } from 'react-router-dom'
import { formatBytes, formatRelative } from './shared/format'
import { useLongPress, useNetworkState } from './shared/hooks'
import { DIFF_LAYOUT_LABEL, ENGINE_LABEL, REASON_LABEL } from './shared/labels'
import { mockDiff, mockEngines, mockHistoryUsage, mockVersions } from './shared/mock-data'
import type { HistoryUsage, HistoryVersion, RestorePrompt } from './shared/types'

const DAY = 86_400_000
const ADDED = mockDiff.filter(line => line.sign === '+').length
const REMOVED = mockDiff.filter(line => line.sign === '-').length

/** 版本行：点按设为对比目标，长按出重命名 / 删除（保持当前视图，不跳页） */
function VersionRow({
  version,
  onCompare,
  onLongPress,
}: {
  version: HistoryVersion
  onCompare: (version: HistoryVersion) => void
  onLongPress: (version: HistoryVersion) => void
}) {
  const { handlers, consumeClick } = useLongPress(() => onLongPress(version))

  return (
    <div className="pl-doc-row" {...handlers} onClick={() => {
      if (consumeClick()) return
      onCompare(version)
    }}>
      <div className="pl-doc-main">
        <div className="pl-doc-name">{version.label || REASON_LABEL[version.reason]}</div>
        <div className="pl-doc-meta pl-num">
          <span>{formatRelative(version.date)}</span>
          {version.reason !== 'auto' && <Tag fill="outline">手动</Tag>}
        </div>
      </div>
      <RightOutline style={{ color: 'var(--ink-faint)' }} />
    </div>
  )
}

/* ================================================
   FLOW: Version History & Failure States
   SCREEN 1 of 5: 历史 Sheet
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  工作区顶栏 ⋯「版本历史」/ 文稿行长按「版本历史」
   EXIT:   点版本 → Screen 2（Diff 全屏页）
   BRANCH: 长按版本 → 重命名 / 删除 Action Sheet；下拉关闭 → 回工作区
   ================================================ */
function Screen1_HistorySheet({
  usage,
  onBack,
  onCompare,
  onVersionAction,
}: {
  usage: HistoryUsage
  onBack: () => void
  onCompare: (version: HistoryVersion) => void
  onVersionAction: (version: HistoryVersion) => void
}) {
  const percent = Math.round((usage.bytes / usage.maxBytes) * 100)
  const today = mockVersions.filter(v => Date.now() - v.date < DAY)
  const earlier = mockVersions.filter(v => Date.now() - v.date >= DAY)

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
          <span>版本历史 · {usage.fileVersions} 个快照</span>
          <Button fill="none" size="small" onClick={onBack}>
            返回
          </Button>
        </div>

        {/* 配额可见：单文件 20 个 / 全站 200 个 / 100 万字符，接近上限要提前说 */}
        <div style={{ padding: '12px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
            <span style={{ color: 'var(--ink-soft)' }}>本机历史占用</span>
            <span className="pl-num" style={{ color: 'var(--ink-soft)' }}>
              {formatBytes(usage.bytes)} / {formatBytes(usage.maxBytes)}
            </span>
          </div>
          <ProgressBar percent={percent} />
          {percent > 60 && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--seal-deep)' }}>
              已用 {percent}%，超出上限后较早的自动快照会被清理。重要节点建议手动命名留存。
            </div>
          )}
        </div>

        <div className="pl-sheet-body">
          {today.length > 0 && <div className="pl-group-head">今天</div>}
          {today.map(version => (
            <VersionRow
              key={version.id}
              version={version}
              onCompare={onCompare}
              onLongPress={onVersionAction}
            />
          ))}
          {earlier.length > 0 && <div className="pl-group-head">更早 · {earlier.length} 个</div>}
          {earlier.map(version => (
            <VersionRow
              key={version.id}
              version={version}
              onCompare={onCompare}
              onLongPress={onVersionAction}
            />
          ))}
        </div>
      </div>
    </Popup>
  )
}

// → 点版本 → SCREEN 2: Diff 全屏页
// → 长按版本 → 版本 Action Sheet

/* ================================================
   FLOW: Version History & Failure States
   SCREEN 2 of 5: Diff 全屏页
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  Screen 1 点某个快照
   EXIT:   「恢复此版本」→ Screen 3 确认 → 回工作区
   BRANCH: 返回 → Screen 1；段控件切换并排 / 行内
   ================================================ */
function Screen2_Diff({
  version,
  layout,
  onLayoutChange,
  onBack,
  onRestore,
}: {
  version: HistoryVersion
  layout: 'inline' | 'side'
  onLayoutChange: (value: 'inline' | 'side') => void
  onBack: () => void
  onRestore: () => void
}) {
  const oldLines = mockDiff.filter(line => line.sign !== '+')
  const newLines = mockDiff.filter(line => line.sign !== '-')
  const rowCount = Math.max(oldLines.length, newLines.length)

  return (
    <div className="pl-screen">
      <NavBar onBack={onBack}>
        <span className="pl-nav-name">对比 {formatRelative(version.date)}</span>
      </NavBar>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--chrome)' }}>
        <Segmented
          value={layout}
          onChange={v => onLayoutChange(v as 'inline' | 'side')}
          options={[
            { label: DIFF_LAYOUT_LABEL.inline, value: 'inline' },
            { label: DIFF_LAYOUT_LABEL.side, value: 'side' },
          ]}
        />
        <span className="pl-num" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--ink-soft)' }}>
          <span style={{ color: 'var(--ok)' }}>+{ADDED}</span> <span style={{ color: 'var(--seal)' }}>-{REMOVED}</span>
        </span>
      </div>

      {/* 桌面是 1400px 双栏并排；390px 下每栏只剩 170px，公式与中文都会挤断行，故默认行内 */}
      {layout === 'inline' ? (
        <div className="pl-content pl-diff">
          {mockDiff.map((line, index) => (
            <div
              key={`${line.sign}-${index}`}
              className={
                'pl-diff-line' + (line.sign === '+' ? ' pl-diff-add' : line.sign === '-' ? ' pl-diff-del' : '')
              }
            >
              <span>{line.newNo ?? line.oldNo ?? ''}</span>
              <span>{line.text || ' '}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="pl-content pl-diff">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '4px 8px' }}>
            <div style={{ color: 'var(--ink-faint)', fontSize: 11 }}>改动前</div>
            <div style={{ color: 'var(--ink-faint)', fontSize: 11 }}>改动后</div>
            {Array.from({ length: rowCount }, (_, index) => (
              <div key={index} style={{ display: 'contents' }}>
                <div
                  style={{
                    padding: '2px 4px',
                    borderLeft: '2px solid transparent',
                    borderLeftColor: oldLines[index]?.sign === '-' ? 'var(--seal)' : 'transparent',
                    color: oldLines[index]?.sign === '-' ? 'var(--seal-deep)' : 'var(--ink)',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {oldLines[index]?.text || ' '}
                </div>
                <div
                  style={{
                    padding: '2px 4px',
                    borderLeft: '2px solid transparent',
                    borderLeftColor: newLines[index]?.sign === '+' ? 'var(--ok)' : 'transparent',
                    color: newLines[index]?.sign === '+' ? 'var(--ok)' : 'var(--ink)',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {newLines[index]?.text || ' '}
                </div>
              </div>
            ))}
          </div>
          <div style={{ padding: '0 8px 8px', fontSize: 11, color: 'var(--ink-faint)' }}>
            并排视图每栏约 170px，长行会折很多截；需要精确比对时切回行内。
          </div>
        </div>
      )}

      <div className="pl-toolbelt">
        <div style={{ display: 'flex', gap: 8, padding: 12 }}>
          <Button block fill="outline" onClick={onBack}>
            取消
          </Button>
          <Button block color="primary" size="large" onClick={onRestore}>
            恢复此版本
          </Button>
        </div>
      </div>
    </div>
  )
}

// → 「恢复此版本」→ SCREEN 3: 恢复确认 Dialog

/* ================================================
   FLOW: Version History & Failure States
   SCREEN 3 of 5: 恢复确认 Dialog
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  Screen 2 主按钮
   EXIT:   「恢复」→ 当前内容先存为快照，再回工作区
   BRANCH: 「取消」→ 留在 Screen 2，不改任何东西
   ================================================ */

/* ================================================
   FLOW: Version History & Failure States
   SCREEN 4 of 5: 冷启动恢复横幅（挂在文稿根页顶部）
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  移动端冷启动，本机 localStorage 里留有草稿
   EXIT:   「恢复」→ 重建草稿标签并进入工作区；「丢弃」→ 清空草稿槽
   BRANCH: 关闭横幅 → 保持当前列表，草稿仍在下次启动再提示
   ================================================ */
export function Screen4_RestoreBanner({
  prompt,
  onRestore,
  onDiscard,
}: {
  prompt: RestorePrompt
  onRestore: () => void
  onDiscard: () => void
}) {
  return (
    <div
      style={{
        margin: '8px 12px',
        padding: 12,
        border: '1px solid var(--accent-border)',
        borderRadius: 8,
        background: 'var(--chrome)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
        <GlobalOutline />
        <span>本机还留着 {prompt.pendingTabs.length} 个未保存草稿</span>
      </div>
      <div style={{ marginTop: 6, fontSize: 12, color: 'var(--ink-soft)', lineHeight: 1.7 }}>
        它们只存在这台浏览器里，清数据或 iOS 长期未访问会被系统回收。建议恢复后「导出源码备份」。
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <Button className="pl-min-touch" size="small" fill="outline" onClick={onDiscard}>
          丢弃
        </Button>
        <Button className="pl-min-touch" size="small" color="primary" onClick={onRestore}>
          恢复草稿
        </Button>
      </div>
    </div>
  )
}

/* ================================================
   FLOW: Version History & Failure States
   SCREEN 5 of 5: 离线 / 引擎不可用态
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  编译入口检测到离线，或所有本机引擎不可用
   EXIT:   「仅编辑」→ 回工作区（近似排版仍可用）；「重新检测」→ 重新探测引擎
   BRANCH: 恢复在线 → 该屏自动让位给编译 Sheet
   ================================================ */
export function Screen5_OfflineState() {
  const navigate = useNavigate()
  const network = useNetworkState()
  const [checking, setChecking] = useState(false)

  // 重新检测是异步探测，必须有加载态并在超时后收回
  useEffect(() => {
    if (!checking) return
    const timer = window.setTimeout(() => {
      setChecking(false)
      Toast.show({ content: '仍未检测到 TeX 服务，可先用近似排版继续写', icon: 'fail' })
    }, 1500)
    return () => clearTimeout(timer)
  }, [checking])

  return (
    <div className="pl-screen">
      <NavBar back={null}>
        <span className="pl-nav-name">真实排版暂不可用</span>
      </NavBar>

      {network === 'offline' && (
        <NoticeBar color="alert" content="当前离线：可继续编辑与近似排版预览，编译与云端项目需要网络。" />
      )}

      <div className="pl-content" style={{ padding: 12 }}>
        <List header="引擎状态">
          {mockEngines.map(engine => (
            <List.Item
              key={engine.name}
              prefix={
                engine.available ? (
                  <span style={{ color: 'var(--ok)' }}>●</span>
                ) : (
                  <ExclamationTriangleOutline style={{ color: 'var(--seal)' }} />
                )
              }
              extra={<Tag fill="outline">{engine.available ? '可用' : '不可用'}</Tag>}
              title={ENGINE_LABEL[engine.name]}
              description={<span style={{ whiteSpace: 'normal' }}>{engine.note}</span>}
            />
          ))}
        </List>

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <Button block fill="outline" onClick={() => setChecking(true)} disabled={checking}>
            <LoopOutline /> 重新检测
          </Button>
          <Button block color="primary" onClick={() => navigate('/m')}>
            仅编辑，继续写
          </Button>
        </div>

        {checking && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, color: 'var(--ink-soft)' }}>
            <SpinLoading color="primary" /> 正在探测本机 TeX 服务…
          </div>
        )}
      </div>
    </div>
  )
}

/* ================================================
   FLOW: Version History & Failure States · 容器
   Screen 1→2→3；Screen 4/5 由 App Shell 分别挂到根页与编译入口
   ================================================ */
export function Flow4_History() {
  const navigate = useNavigate()
  const { docId } = useParams()
  const [stage, setStage] = useState<'list' | 'diff'>('list')
  const [version, setVersion] = useState<HistoryVersion | null>(null)
  const [layout, setLayout] = useState<'inline' | 'side'>('inline')
  const [actionVersion, setActionVersion] = useState<HistoryVersion | null>(null)

  const restore = () => {
    if (!version) return
    // 不可逆操作：先说清「当前版本会被另存一份」，再执行
    Dialog.confirm({
      title: '恢复到这个版本？',
      content: '当前内容会先存为一个新快照（标记为「恢复前快照」），再被这个版本覆盖。手机端撤销空间有限，确认后再操作。',
      confirmText: '恢复',
      cancelText: '取消',
      onConfirm: () => {
        Toast.show({ content: '已恢复，当前内容已存为快照', icon: 'success' })
        navigate(`/m/workspace/${docId ?? 'd1'}`)
      },
    })
  }

  if (stage === 'diff' && version) {
    return (
      <Screen2_Diff
        version={version}
        layout={layout}
        onLayoutChange={setLayout}
        onBack={() => setStage('list')}
        onRestore={restore}
      />
    )
  }

  return (
    <div className="pl-screen">
      <NavBar back={null}>
        <span className="pl-nav-name">第三章-方法设计.tex</span>
      </NavBar>
      <div className="pl-content" style={{ padding: 12, background: 'var(--desk)' }}>
        <div className="pl-paper" style={{ margin: 0, opacity: 0.4, pointerEvents: 'none' }}>
          <p>工作区残影 · 历史 Sheet 不离开当前文档</p>
        </div>
      </div>

      <Screen1_HistorySheet
        usage={mockHistoryUsage}
        onBack={() => navigate(`/m/workspace/${docId ?? 'd1'}`)}
        onCompare={selected => {
          setVersion(selected)
          setStage('diff')
        }}
        onVersionAction={setActionVersion}
      />

      <ActionSheet
        visible={actionVersion !== null}
        onClose={() => setActionVersion(null)}
        cancelText="取消"
        extra={
          <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--ink-soft)' }}>
            {actionVersion ? formatRelative(actionVersion.date) : ''}
          </div>
        }
        actions={[
          {
            key: 'rename',
            text: <span><EditSOutline /> 重命名版本</span>,
            onClick: () => {
              setActionVersion(null)
              Toast.show({ content: '手动命名后不会被自动清理（对齐 renameVersion）' })
            },
          },
          {
            key: 'delete',
            text: <span><DeleteOutline /> 删除此快照</span>,
            danger: true,
            onClick: () => {
              setActionVersion(null)
              Toast.show({ content: '已删除该快照' })
            },
          },
        ]}
      />
    </div>
  )
}

// =============================================
// FLOW: Version History & Failure States (5 screens)
// Scenario: Mobile Productivity（适配到版本快照与丢稿防护）
//   锚点 = Canonical Flow 2/3「Action Sheet + Detail」模式
//   差异 = ① Detail 是版本 diff，桌面 1400px 双栏在移动端默认降级为行内
//          ② 新增冷启动恢复与配额预警（任务管理的前提是「无需草稿保存」，PaperLite 相反）
//          ③ S4/S5 是横切状态屏，由 Shell 挂到根页与编译入口
// Platform: H5 (Ant Design Mobile)
// 数据源 = 共享 historyStorage（与桌面 HistoryDialog 同一份快照与 diff 计算）
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
import { useT } from '../../useI18n.js'
import { formatBytes, formatRelative } from './shared/format'
import { useLongPress, useNetworkState } from './shared/hooks'
import { DIFF_LAYOUT_LABEL, ENGINE_LABEL, ENGINE_STATUS_LABEL, reasonKey } from './shared/labels'
import { readHistory, historyUsage, recordVersion, renameVersion, deleteHistory } from '../../historyStorage.js'
import { compareVersions } from '../../historyDiff.js'
import { useMobileWorkspace, type MobileTab } from './mobileWorkspace'

const DAY = 86_400_000

/** 版本行：点按进 diff，长按出重命名 / 删除（保持当前视图，不跳页） */
function VersionRow({
  version,
  onCompare,
  onLongPress,
}: {
  version: { id: string; date: number; label: string; reason: string }
  onCompare: (id: string) => void
  onLongPress: (version: { id: string; date: number; label: string; reason: string }) => void
}) {
  const t = useT()
  const { handlers, consumeClick } = useLongPress(() => onLongPress(version))

  return (
    <div
      className="pl-doc-row"
      {...handlers}
      onClick={() => {
        if (consumeClick()) return
        onCompare(version.id)
      }}
    >
      <div className="pl-doc-main">
        <div className="pl-doc-name">{version.label || t(reasonKey(version.reason))}</div>
        <div className="pl-doc-meta pl-num">
          <span>{formatRelative(version.date)}</span>
          {version.reason !== 'auto' && <Tag fill="outline">{t('mb.hist.manual')}</Tag>}
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
  versions,
  usage,
  onBack,
  onCompare,
  onVersionAction,
}: {
  versions: Array<{ id: string; date: number; text: string; label: string; reason: string }>
  usage: ReturnType<typeof historyUsage>
  onBack: () => void
  onCompare: (id: string) => void
  onVersionAction: (version: { id: string; date: number; text: string; label: string; reason: string }) => void
}) {
  const t = useT()
  const percent = usage.maxBytes ? Math.min(100, Math.round((usage.bytes / usage.maxBytes) * 100)) : 0
  const today = versions.filter(v => Date.now() - v.date < DAY)
  const earlier = versions.filter(v => Date.now() - v.date >= DAY)

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
          <span>{t('mb.hist.sheetTitle', { n: usage.fileVersions })}</span>
          <Button fill="none" size="small" onClick={onBack}>
            {t('mb.hist.back')}
          </Button>
        </div>

        {/* 配额可见：单文件 20 个 / 全站 200 个 / 100 万字符，接近上限要提前说 */}
        <div style={{ padding: '12px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
            <span style={{ color: 'var(--ink-soft)' }}>{t('mb.hist.storageLocal')}</span>
            <span className="pl-num" style={{ color: 'var(--ink-soft)' }}>
              {formatBytes(usage.bytes)} / {formatBytes(usage.maxBytes)}
            </span>
          </div>
          <ProgressBar percent={percent} />
          {percent > 60 && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--seal-deep)' }}>
              {t('mb.hist.quotaWarn', { n: percent })}
            </div>
          )}
        </div>

        <div className="pl-sheet-body">
          {versions.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--ink-soft)', fontSize: 13 }}>
              {t('mb.hist.emptySnapshots')}
            </div>
          ) : (
            <>
              {today.length > 0 && <div className="pl-group-head">{t('mb.hist.today')}</div>}
              {today.map(version => (
                <VersionRow key={version.id} version={version} onCompare={onCompare} onLongPress={onVersionAction} />
              ))}
              {earlier.length > 0 && <div className="pl-group-head">{t('mb.hist.earlier', { n: earlier.length })}</div>}
              {earlier.map(version => (
                <VersionRow key={version.id} version={version} onCompare={onCompare} onLongPress={onVersionAction} />
              ))}
            </>
          )}
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
  current,
  layout,
  onLayoutChange,
  onBack,
  onRestore,
}: {
  version: { id: string; date: number; text: string; label: string }
  current: string
  layout: 'inline' | 'side'
  onLayoutChange: (value: 'inline' | 'side') => void
  onBack: () => void
  onRestore: () => void
}) {
  const t = useT()
  // 与桌面 HistoryDialog 同一份 diff 计算（diff 包的 diffLines + 阈值保护）
  const diff = compareVersions(version.text, current)

  return (
    <div className="pl-screen">
      <NavBar onBack={onBack}>
        <span className="pl-nav-name">{t('mb.hist.compareNav', { time: formatRelative(version.date) })}</span>
      </NavBar>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--chrome)' }}>
        <Segmented
          value={layout}
          onChange={v => onLayoutChange(v as 'inline' | 'side')}
          options={[
            { label: t(DIFF_LAYOUT_LABEL.inline), value: 'inline' },
            { label: t(DIFF_LAYOUT_LABEL.side), value: 'side' },
          ]}
        />
        <span className="pl-num" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--ink-soft)' }}>
          <span style={{ color: 'var(--ok)' }}>+{diff.added}</span>{' '}
          <span style={{ color: 'var(--seal)' }}>-{diff.removed}</span>
        </span>
      </div>

      {diff.tooLarge ? (
        <div className="pl-content" style={{ padding: 16, color: 'var(--ink-soft)', fontSize: 13 }}>
          {t('mb.hist.diffTooLarge')}
        </div>
      ) : layout === 'inline' ? (
        /* 桌面是 1400px 双栏并排；390px 下每栏只剩 170px，公式与中文都会挤断行，故默认行内 */
        <div className="pl-content pl-diff">
          {diff.rows.map((row, index) => (
            <div
              key={index}
              className={
                'pl-diff-line' + (row.right !== undefined && row.left === undefined ? ' pl-diff-add'
                  : row.left !== undefined && row.right === undefined ? ' pl-diff-del' : '')
              }
            >
              <span>{row.newLine ?? row.oldLine ?? ''}</span>
              <span>{(row.right ?? row.left ?? '').replace(/\n$/, '') || ' '}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="pl-content pl-diff">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '8px' }}>
            <div style={{ color: 'var(--ink-faint)', fontSize: 11 }}>{t('mb.hist.before')}</div>
            <div style={{ color: 'var(--ink-faint)', fontSize: 11 }}>{t('mb.hist.after')}</div>
            {diff.rows.map((row, index) => (
              <div key={index} style={{ display: 'contents' }}>
                <div
                  style={{
                    padding: '2px 4px',
                    borderLeft: '2px solid',
                    borderLeftColor: row.changed ? 'var(--seal)' : 'transparent',
                    color: row.changed ? 'var(--seal-deep)' : 'var(--ink)',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {(row.left || '').replace(/\n$/, '') || ' '}
                </div>
                <div
                  style={{
                    padding: '2px 4px',
                    borderLeft: '2px solid',
                    borderLeftColor: row.changed ? 'var(--ok)' : 'transparent',
                    color: row.changed ? 'var(--ok)' : 'var(--ink)',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {(row.right || '').replace(/\n$/, '') || ' '}
                </div>
              </div>
            ))}
          </div>
          <div style={{ padding: '0 8px 8px', fontSize: 11, color: 'var(--ink-faint)' }}>
            {t('mb.hist.sideHint')}
          </div>
        </div>
      )}

      <div className="pl-toolbelt">
        <div style={{ display: 'flex', gap: 8, padding: 12 }}>
          <Button block fill="outline" onClick={onBack}>
            {t('dialog.cancel')}
          </Button>
          <Button block color="primary" size="large" disabled={diff.added + diff.removed === 0} onClick={onRestore}>
            {t('mb.hist.restoreThis')}
          </Button>
        </div>
      </div>
    </div>
  )
}

// → 「恢复此版本」→ SCREEN 3: 恢复确认 Dialog

/* ================================================
   FLOW: Version History & Failure States
   SCREEN 4 of 5: 冷启动恢复横幅（挂在文稿根页顶部）
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  移动端冷启动，本机 localStorage 里留有浏览器草稿
   EXIT:   「打开最近一篇」→ 工作区；「知道了」→ 收起横幅
   BRANCH: 关闭横幅不影响草稿本身，下次冷启动再提示
   ================================================ */
export function Screen4_RestoreBanner({
  prompt,
  onRestore,
  onDiscard,
}: {
  prompt: { pendingTabs: Array<{ id: string; name: string; words: number }>; folderName: string | null }
  onRestore: () => void
  onDiscard: () => void
}) {
  const t = useT()
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
        <span>{t('mb.hist.draftBanner', { n: prompt.pendingTabs.length, p: prompt.pendingTabs.length > 1 ? 's' : '' })}</span>
      </div>
      <div style={{ marginTop: 6, fontSize: 12, color: 'var(--ink-soft)', lineHeight: 1.7 }}>
        {t('mb.hist.draftNote')}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <Button className="pl-min-touch" size="small" fill="outline" onClick={onDiscard}>
          {t('mb.hist.gotIt')}
        </Button>
        <Button className="pl-min-touch" size="small" color="primary" onClick={onRestore}>
          {t('mb.hist.openLatest')}
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
   注意：引擎清单来自共享 useCompile 的 /api/health 探测，非 mock
   ================================================ */
export function Screen5_OfflineState() {
  const navigate = useNavigate()
  const ws = useMobileWorkspace()
  const t = useT()
  const network = useNetworkState()
  const [checking, setChecking] = useState(false)
  const local = ws.engines.filter(name => name !== 'builtin')

  // 重新检测是异步探测，必须有加载态并在超时后收回
  useEffect(() => {
    if (!checking) return
    const timer = window.setTimeout(() => {
      setChecking(false)
      Toast.show({ content: t('mb.hist.recheckFailed'), icon: 'fail' })
    }, 1500)
    return () => clearTimeout(timer)
  }, [checking])

  return (
    <div className="pl-screen">
      <NavBar back={null}>
        <span className="pl-nav-name">{t('mb.hist.realUnavailable')}</span>
      </NavBar>

      {network === 'offline' && (
        <NoticeBar color="alert" content={t('mb.hist.offlineNotice')} />
      )}

      <div className="pl-content" style={{ padding: 12 }}>
        <List header={t('mb.hist.engineStatus')}>
          <List.Item
            prefix={<span style={{ color: ws.builtinStatus === 'error' ? 'var(--seal)' : 'var(--ok)' }}>●</span>}
            extra={<Tag fill="outline">{t(ENGINE_STATUS_LABEL[ws.builtinStatus] || ws.builtinStatus)}</Tag>}
            title={t(ENGINE_LABEL.builtin)}
            description={<span style={{ whiteSpace: 'normal' }}>{t('mb.hist.builtinDesc')}</span>}
          />
          {local.map(name => (
            <List.Item
              key={name}
              prefix={<span style={{ color: 'var(--ok)' }}>●</span>}
              extra={<Tag fill="outline">{t('mb.hist.available')}</Tag>}
              title={t(ENGINE_LABEL[name as keyof typeof ENGINE_LABEL] || name)}
              description={<span style={{ whiteSpace: 'normal' }}>{t('mb.hist.localEngineDesc')}</span>}
            />
          ))}
          {local.length === 0 && (
            <List.Item
              prefix={<ExclamationTriangleOutline style={{ color: 'var(--seal)' }} />}
              extra={<Tag fill="outline">{t('mb.hist.notDetected')}</Tag>}
              title={t('mb.hist.localXelatex')}
              description={<span style={{ whiteSpace: 'normal' }}>{t('mb.hist.localEngineHint')}</span>}
            />
          )}
        </List>

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <Button block fill="outline" onClick={() => setChecking(true)} disabled={checking}>
            <LoopOutline /> {t('mb.hist.recheck')}
          </Button>
          <Button block color="primary" onClick={() => navigate('/m')}>
            {t('mb.hist.editOnly')}
          </Button>
        </div>

        {checking && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, color: 'var(--ink-soft)' }}>
            <SpinLoading color="primary" /> {t('mb.hist.probing')}
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
  const ws = useMobileWorkspace()
  const t = useT()

  const [stage, setStage] = useState<'list' | 'diff'>('list')
  const [versionId, setVersionId] = useState<string | null>(null)
  const [layout, setLayout] = useState<'inline' | 'side'>('inline')
  const [actionVersion, setActionVersion] = useState<null | { id: string; date: number; text: string; label: string; reason: string }>(null)
  const [tick, setTick] = useState(0)

  const tab: MobileTab | undefined = ws.tabs.filter(x => String(x.id) === String(docId))[0] || ws.activeTab || undefined
  const key = tab?.historyKey
  const versions = key ? readHistory(key) : []
  const usage = key ? historyUsage(key) : { bytes: 0, maxBytes: 1, versions: 0, files: 0, fileVersions: 0 }
  const version = versions.find(v => v.id === versionId) || null
  const current = tab?.doc ? tab.doc.getValue() : ''

  // 工作区的自动快照在跑，回到列表时重新读一次
  useEffect(() => {
    if (tick) setTick(t => t)
  }, [ws.tabs.length, ws.activeId, tick])

  if (!tab) {
    return (
      <div className="pl-screen">
        <NavBar onBack={() => navigate('/m')}>
          <span className="pl-nav-name">{t('mb.hist.title')}</span>
        </NavBar>
        <div className="pl-content" style={{ padding: 16, color: 'var(--ink-soft)' }}>
          {t('mb.hist.docMissing')}
        </div>
      </div>
    )
  }

  if (stage === 'diff' && version) {
    const restore = () => {
      Dialog.confirm({
        title: t('mb.hist.restoreTitle'),
        content: t('mb.hist.restoreBody'),
        confirmText: t('mb.hist.restoreConfirm'),
        cancelText: t('dialog.cancel'),
        onConfirm: () => {
          recordVersion(tab.historyKey, current, { reason: 'beforeRestore', force: true })
          const result = recordVersion(tab.historyKey, version.text, { reason: 'restore', label: version.label, force: true })
          tab.doc?.setValue(version.text)
          setStage('list')
          setTick(t => t + 1)
          Toast.show({
            content: result.ok ? t('mb.hist.restoredOk') : t('mb.hist.restoredFail'),
            icon: result.ok ? 'success' : 'fail',
          })
        },
      })
    }

    return (
      <Screen2_Diff
        version={version}
        current={current}
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
        <span className="pl-nav-name">{tab.name}</span>
      </NavBar>
      <div className="pl-content" style={{ padding: 12, background: 'var(--desk)' }}>
        <div className="pl-paper" style={{ margin: 0, opacity: 0.4, pointerEvents: 'none' }}>
          <p>{t('mb.hist.workspaceGhost')}</p>
        </div>
      </div>

      <Screen1_HistorySheet
        versions={versions}
        usage={usage}
        onBack={() => navigate(`/m/workspace/${tab.id}`)}
        onCompare={id => {
          setVersionId(id)
          setStage('diff')
        }}
        onVersionAction={setActionVersion}
      />

      <ActionSheet
        visible={actionVersion !== null}
        onClose={() => setActionVersion(null)}
        cancelText={t('dialog.cancel')}
        extra={
          <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--ink-soft)' }}>
            {actionVersion ? formatRelative(actionVersion.date) : ''}
          </div>
        }
        actions={
          actionVersion
            ? [
                {
                  key: 'rename',
                  text: <span><EditSOutline /> {t('mb.hist.rename')}</span>,
                  onClick: () => {
                    const target = actionVersion
                    setActionVersion(null)
                    let next = target.label
                    Dialog.show({
                      title: t('mb.hist.renameDialogTitle'),
                      content: (
                        <RenameInput
                          initial={target.label}
                          placeholder={t('mb.hist.renamePlaceholder')}
                          onChange={value => { next = value }}
                        />
                      ),
                      closeOnAction: true,
                      actions: [
                        [
                          { key: 'cancel', text: t('dialog.cancel') },
                          {
                            key: 'ok',
                            text: t('m.save'),
                            bold: true,
                            onClick: () => {
                              // 手动命名后不会被自动清理（对齐 renameVersion 的 protectIds 语义）
                              renameVersion(tab.historyKey, target.id, next)
                              setTick(t => t + 1)
                              Toast.show({ content: t('mb.hist.renamed'), icon: 'success' })
                            },
                          },
                        ],
                      ],
                    })
                  },
                },
                {
                  key: 'delete',
                  text: <span><DeleteOutline /> {t('mb.hist.delete')}</span>,
                  danger: true,
                  onClick: () => {
                    const target = actionVersion
                    setActionVersion(null)
                    Dialog.confirm({
                      title: t('mb.hist.deleteTitle'),
                      content: t('mb.hist.deleteBody'),
                      confirmText: t('mb.hist.deleteConfirm'),
                      cancelText: t('dialog.cancel'),
                      onConfirm: () => {
                        deleteHistory(tab.historyKey, target.id)
                        setTick(t => t + 1)
                        Toast.show({ content: t('mb.hist.deleted') })
                      },
                    })
                  },
                },
              ]
            : []
        }
      />
    </div>
  )
}

/**
 * Dialog.show 的内容脱离父组件渲染（独立 React 根，取不到 LangContext），
 * 需自带状态再把值回传给闭包；文案由父组件翻译后经 placeholder 传入。
 */
function RenameInput({
  initial,
  placeholder,
  onChange,
}: {
  initial: string
  placeholder: string
  onChange: (value: string) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={e => {
        setValue(e.target.value)
        onChange(e.target.value)
      }}
      style={{
        width: '100%',
        padding: 10,
        border: '1px solid var(--line)',
        borderRadius: 6,
        background: 'var(--paper)',
        color: 'var(--ink)',
        font: 'inherit',
      }}
    />
  )
}

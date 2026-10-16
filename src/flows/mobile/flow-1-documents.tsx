// =============================================
// FLOW: Documents List & Quick Draft (4 screens)
// Scenario: Mobile Productivity（适配到 LaTeX 写作工具）
//   锚点 = Canonical Flow 1「快速添加任务」+ Flow 3「日视图列表主屏」
//   差异 = ① 行右侧是保存态徽标而非完成 checkbox
//          ② FAB 产物是空草稿并立即进入工作区（不留在列表）
//          ③ 新增 Screen 3「导入文件」：移动浏览器无 showDirectoryPicker（src/fs.js）
// Platform: H5 (Ant Design Mobile)
// 数据源 = 共享工作区 useWorkspace()（与桌面同一份 tabs / 草稿 / 保存实现）
// =============================================

import { type ReactNode, useCallback, useMemo, useState } from 'react'
import {
  ActionSheet,
  Button,
  Dialog,
  Empty,
  InfiniteScroll,
  Input,
  NavBar,
  NoticeBar,
  Popup,
  PullToRefresh,
  SearchBar,
  Selector,
  SwipeAction,
  Tag,
  Toast,
} from 'antd-mobile'
import {
  AddOutline,
  ClockCircleOutline,
  ContentOutline,
  DeleteOutline,
  EditSOutline,
  EyeOutline,
  FileOutline,
  FolderOutline,
  PictureOutline,
  UploadOutline,
} from 'antd-mobile-icons'
import { useNavigate } from 'react-router-dom'
import { formatRelative, formatWords, wait } from './shared/format'
import { DOC_KIND_LABEL, SAVE_STATE } from './shared/labels'
import { useLongPress } from './shared/hooks'
import { useMobileWorkspace, type MobileTab } from './mobileWorkspace'
import { useT } from '../../useI18n.js'
import { samples } from '../../engines/samples.js'
import { wordCount } from '../../fileActions.js'

const PAGE_SIZE = 6

const KIND_ICON: Record<string, ReactNode> = {
  tex: <FileOutline />,
  md: <ContentOutline />,
  draft: <EditSOutline />,
  image: <PictureOutline />,
  pdf: <EyeOutline />,
  code: <FileOutline />,
  text: <FileOutline />,
  asset: <FileOutline />,
}

/** 起始内容：直接取桌面同一份内置模板（语言是运行时切的，这里只存键名，渲染时再翻译） */
const TEMPLATES = [
  { id: 'demo', nameKey: 'mb.doc.tplDemoName', noteKey: 'mb.doc.tplDemoNote', text: samples.demo },
  { id: 'flow', nameKey: 'mb.doc.tplFlowName', noteKey: 'mb.doc.tplFlowNote', text: samples.flow },
  { id: 'blank', nameKey: 'mb.doc.tplBlankName', noteKey: 'mb.doc.tplBlankNote', text: samples.blank },
]

/**
 * 单行文稿。不用 List.Item：它只转发 onClick，长按挂不上去。
 */
function DocRow({
  tab,
  onOpen,
  onLongPress,
  onHistory,
  onDelete,
}: {
  tab: MobileTab
  onOpen: (tab: MobileTab) => void
  onLongPress: (tab: MobileTab) => void
  onHistory: (tab: MobileTab) => void
  onDelete: (tab: MobileTab) => void
}) {
  const { handlers, consumeClick } = useLongPress(() => onLongPress(tab))
  const ws = useMobileWorkspace()
  const t = useT()
  const state = ws.saveStateOf(tab)
  const meta = SAVE_STATE[state]
  const value = tab.doc?.getValue() || ''

  return (
    <SwipeAction
      closeOnAction
      rightActions={[
        { key: 'history', text: t('mb.doc.history'), color: 'primary', onClick: () => onHistory(tab) },
        { key: 'delete', text: t('mb.doc.delete'), color: 'danger', onClick: () => onDelete(tab) },
      ]}
    >
      <button
        type="button"
        className="pl-doc-row"
        aria-label={t('mb.doc.rowAria', { name: tab.name, state: t(meta.textKey) })}
        {...handlers}
        onClick={() => {
          // 长按已弹 ActionSheet，吞掉手指抬起补发的 click
          if (consumeClick()) return
          onOpen(tab)
        }}
      >
        <span className="pl-doc-icon">{KIND_ICON[tab.kind] || KIND_ICON.text}</span>
        <span className="pl-doc-main">
          <span className="pl-doc-name">{tab.name}</span>
          <span className="pl-doc-meta pl-num">
            <span>{formatRelative(tab.updatedAt || Date.now())}</span>
            <span>{tab.doc ? formatWords(wordCount(value).total) : t((DOC_KIND_LABEL as Record<string, string>)[tab.kind] || 'mb.doc.resource')}</span>
          </span>
        </span>
        <Tag color={meta.color} fill="outline">
          {t(meta.textKey)}
        </Tag>
      </button>
    </SwipeAction>
  )
}

/* ================================================
   FLOW: Documents List & Quick Draft
   SCREEN 1 of 4: 文稿根页
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  App Shell → 底部 TabBar「文稿」（根 Tab，无返回键）
   EXIT:   点行 → 工作区（Flow 2 Screen 1）；FAB → Screen 2；导航右侧「导入」→ Screen 3
   BRANCH: 长按行 → Screen 4（Action Sheet）；左滑行 → 历史 / 删除快捷操作
   SLOT:   banner 由 Shell 注入 Flow 4 Screen 4 的冷启动恢复横幅
   ================================================ */
export function Screen1_DocumentsHome({ banner }: { banner?: ReactNode }) {
  const navigate = useNavigate()
  const ws = useMobileWorkspace()
  const t = useT()
  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [sheet, setSheet] = useState<'none' | 'new' | 'import'>('none')
  const [actionTab, setActionTab] = useState<MobileTab | null>(null)
  const [undoDraft, setUndoDraft] = useState<{ name: string; text: string } | null>(null)

  const filtered = useMemo(
    () => ws.tabs.filter(tab => tab.name.toLowerCase().includes(query.trim().toLowerCase())),
    [ws.tabs, query],
  )
  const pageRows = filtered.slice(0, visibleCount)
  const hasMore = filtered.length > visibleCount

  const drafts = useMemo(() => pageRows.filter(tab => !tab.handle && tab.kind !== 'image' && tab.kind !== 'pdf'), [pageRows])
  const assets = useMemo(() => pageRows.filter(tab => tab.handle || tab.kind === 'image' || tab.kind === 'pdf' || tab.uploadedFile), [pageRows])

  const loadMore = useCallback(async () => {
    if (!hasMore) return
    await wait(300)
    setVisibleCount(count => count + PAGE_SIZE)
  }, [hasMore])

  const onRefresh = useCallback(async () => {
    await wait(500)
    Toast.show({ content: ws.rootDir ? t('mb.doc.synced', { name: ws.rootDir.name }) : t('mb.doc.draftsRead'), icon: 'success' })
  }, [ws.rootDir, t])

  const openDoc = (tab: MobileTab) => {
    ws.openTab(tab.id)
    navigate(`/m/workspace/${tab.id}`)
  }

  /** 关闭即删除：脏标签的确认由共享的 closeTab 统一处理，撤销靠重新建草稿 */
  const removeTab = async (tab: MobileTab) => {
    setActionTab(null)
    const text = tab.doc?.getValue() || ''
    await ws.closeTab(tab.id)
    if (tab.doc) setUndoDraft({ name: tab.name, text })
    Toast.show({ content: t('mb.doc.deleted', { name: tab.name }) })
  }

  const askRename = (tab: MobileTab) => {
    setActionTab(null)
    let next = tab.name
    Dialog.show({
      title: t('mb.doc.rename'),
      content: <RenameInput initial={tab.name} onChange={value => { next = value }} />,
      closeOnAction: true,
      actions: [
        [
          { key: 'cancel', text: t('dialog.cancel') },
          {
            key: 'ok',
            text: t('dialog.ok'),
            bold: true,
            onClick: () => {
              if (!ws.renameTab(tab.id, next)) {
                Toast.show({ content: t('mb.doc.nameEmpty') })
                return
              }
              Toast.show({ content: t('mb.doc.renamed'), icon: 'success' })
            },
          },
        ],
      ],
    })
  }

  return (
    <div className="pl-screen">
      {/* NavBar 无 onRightClick prop，右侧需自带可点节点 */}
      <NavBar
        back={null}
        right={
          <Button fill="none" size="small" style={{ color: 'var(--accent)' }} onClick={() => setSheet('import')}>
            <UploadOutline /> {t('mb.doc.import')}
          </Button>
        }
      >
        {t('mb.doc.title')}
      </NavBar>

      {banner}

      {undoDraft && (
        <NoticeBar
          color="info"
          content={t('mb.doc.deleted', { name: undoDraft.name })}
          extra={
            <Button
              fill="none"
              size="mini"
              onClick={() => {
                ws.addDraft(undoDraft.name, undoDraft.text)
                setUndoDraft(null)
                Toast.show({ content: t('mb.doc.restored'), icon: 'success' })
              }}
            >
              {t('mb.doc.undo')}
            </Button>
          }
        />
      )}

      <div style={{ padding: '8px 12px', background: 'var(--chrome)' }}>
        <SearchBar
          placeholder={t('mb.doc.searchPlaceholder')}
          value={query}
          onChange={setQuery}
          onSearch={setQuery}
          onClear={() => setQuery('')}
        />
      </div>

      <PullToRefresh onRefresh={onRefresh}>
        {pageRows.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '32px 16px' }}>
            <Empty description={query ? t('mb.doc.noMatch', { q: query }) : t('mb.doc.noDocs')} />
            <div style={{ marginTop: 16 }}>
              <Button color="primary" onClick={() => setSheet('new')}>
                {t('mb.doc.createFirst')}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {drafts.length > 0 && (
              <>
                <div className="pl-group-head">{t('mb.doc.groupDrafts')}</div>
                {drafts.map(tab => (
                  <DocRow
                    key={tab.id}
                    tab={tab}
                    onOpen={openDoc}
                    onLongPress={setActionTab}
                    onHistory={t => navigate(`/m/history/${t.id}`)}
                    onDelete={removeTab}
                  />
                ))}
              </>
            )}
            {assets.length > 0 && (
              <>
                <div className="pl-group-head">
                  <FolderOutline />
                  {ws.rootDir ? ws.rootDir.name : t('mb.doc.groupFiles')}
                </div>
                {assets.map(tab => (
                  <DocRow
                    key={tab.id}
                    tab={tab}
                    onOpen={openDoc}
                    onLongPress={setActionTab}
                    onHistory={t => navigate(`/m/history/${t.id}`)}
                    onDelete={removeTab}
                  />
                ))}
              </>
            )}
            <InfiniteScroll loadMore={loadMore} hasMore={hasMore} />
          </>
        )}
      </PullToRefresh>

      {/* FAB：antd-mobile 无 FloatButton，自实现；绝对定位于内容容器内 */}
      <button type="button" className="pl-fab" aria-label={t('mb.doc.newDraft')} onClick={() => setSheet('new')}>
        <AddOutline style={{ fontSize: 24 }} />
      </button>

      {/* → 点 FAB / 空状态 CTA → SCREEN 2: 新建草稿 Sheet */}
      <NewDraftSheet
        visible={sheet === 'new'}
        onClose={() => setSheet('none')}
        onCreated={tab => {
          setSheet('none')
          navigate(`/m/workspace/${tab.id}`)
        }}
      />

      {/* → 导航右侧「导入」→ SCREEN 3: 导入文件 Sheet */}
      <ImportSheet visible={sheet === 'import'} onClose={() => setSheet('none')} />

      {/* → 长按行 → SCREEN 4: 文档 Action Sheet */}
      <DocActionSheet
        tab={actionTab}
        onClose={() => setActionTab(null)}
        onRename={askRename}
        onHistory={tab => {
          setActionTab(null)
          navigate(`/m/history/${tab.id}`)
        }}
        onDelete={removeTab}
        onMove={() => Toast.show({ content: t('mb.doc.moveNote') })}
      />
    </div>
  )
}

// → 长按行 → SCREEN 4: 文档 Action Sheet
// → 点 FAB「+」/ 空状态 CTA → SCREEN 2: 新建草稿 Sheet
// → 导航右侧「导入」→ SCREEN 3: 导入文件 Sheet

/* ================================================
   FLOW: Documents List & Quick Draft
   SCREEN 2 of 4: 新建草稿 Sheet
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  Screen 1 的 FAB 或空状态 CTA
   EXIT:   「完成」→ 建草稿并 push 工作区（Flow 2 Screen 1）
   BRANCH: 下拉关闭 / 点遮罩 → 回 Screen 1，不产生空草稿
   ================================================ */
function NewDraftSheet({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean
  onClose: () => void
  onCreated: (tab: MobileTab) => void
}) {
  const ws = useMobileWorkspace()
  const t = useT()
  const [name, setName] = useState('')
  const [template, setTemplate] = useState<string>('demo')
  const trimmed = name.trim()

  const create = () => {
    const picked = TEMPLATES.find(item => item.id === template) || TEMPLATES[0]
    const fileName = /\.(tex|md|bib|txt)$/i.test(trimmed) ? trimmed : `${trimmed}.tex`
    onCreated(ws.addDraft(fileName, picked.text))
    setName('')
  }

  return (
    <Popup
      visible={visible}
      onMaskClick={onClose}
      onClose={onClose}
      position="bottom"
      closeOnSwipe
      bodyStyle={{ borderTopLeftRadius: 12, borderTopRightRadius: 12 }}
    >
      <div className="pl-sheet">
        <div className="pl-sheet-head">
          <span>{t('mb.doc.newDraft')}</span>
          <Button color="primary" size="small" disabled={!trimmed} onClick={create}>
            {t('mb.doc.done')}
          </Button>
        </div>

        <div className="pl-sheet-body" style={{ padding: '12px 16px' }}>
          {/* STATE: default — 标题为空，「完成」disabled */}
          {/* STATE: filled — 标题非空，可直接创建 */}
          {/* STATE: error — 名称为空时主按钮保持禁用，不静默改名 */}
          <Input
            placeholder={t('mb.doc.namePlaceholder')}
            value={name}
            onChange={setName}
            clearable
            autoFocus
            enterKeyHint="done"
            onEnterPress={() => {
              if (trimmed) create()
            }}
          />

          <div style={{ margin: '16px 0 8px', color: 'var(--ink-soft)', fontSize: 12 }}>{t('mb.doc.startContent')}</div>
          <Selector
            columns={1}
            value={[template]}
            onChange={v => setTemplate((v[0] as string) || 'demo')}
            options={TEMPLATES.map(item => ({ label: `${t(item.nameKey)} · ${t(item.noteKey)}`, value: item.id }))}
          />

          <div style={{ marginTop: 12, color: 'var(--ink-faint)', fontSize: 11 }}>
            {t('mb.doc.draftNote')}
          </div>
        </div>

        <div className="pl-sheet-foot">
          <Button block fill="none" onClick={onClose}>
            {t('dialog.cancel')}
          </Button>
        </div>
      </div>
    </Popup>
  )
}

/* ================================================
   FLOW: Documents List & Quick Draft
   SCREEN 3 of 4: 导入文件 Sheet
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  Screen 1 导航右侧「导入」
   EXIT:   选完文件 → 回到 Screen 1，文件出现在列表（内存标签或磁盘标签）
   BRANCH: 支持目录授权的浏览器额外给「打开文件夹」；离线不影响本地导入
   ================================================ */
function ImportSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const ws = useMobileWorkspace()
  const t = useT()
  const imported = ws.tabs.filter(tab => tab.uploadedFile).length

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
          <span>{t('mb.doc.importTitle')}</span>
          <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
            {imported ? t('mb.doc.importedCount', { n: imported }) : t('mb.doc.pickFiles')}
          </span>
        </div>

        <NoticeBar
          color="alert"
          wrap
          content={
            ws.fsSupported
              ? t('mb.doc.noticeFsOk')
              : t('mb.doc.noticeNoFs')
          }
        />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 16px' }}>
          <Button
            className="pl-min-touch"
            color="primary"
            onClick={() => {
              ws.uploadFiles()
              onClose()
            }}
          >
            <UploadOutline /> {t('mb.doc.pickFilesMulti')}
          </Button>
          <Button
            className="pl-min-touch"
            fill="outline"
            disabled={!ws.fsSupported}
            onClick={() => {
              ws.openFolder()
              onClose()
            }}
          >
            <FolderOutline /> {ws.fsSupported ? t('mb.doc.openFolder') : t('mb.doc.openFolderUnsupported')}
          </Button>
        </div>

        <div className="pl-sheet-body" style={{ padding: '0 16px 12px' }}>
          <div style={{ color: 'var(--ink-faint)', fontSize: 11, lineHeight: 1.7 }}>
            {t('mb.doc.uploadNote')}
          </div>
        </div>

        <div className="pl-sheet-foot">
          <Button block fill="none" onClick={onClose}>
            {t('mb.doc.done')}
          </Button>
        </div>
      </div>
    </Popup>
  )
}

/* ================================================
   FLOW: Documents List & Quick Draft
   SCREEN 4 of 4: 文档 Action Sheet（长按唤起）
   PLATFORM: H5 (Ant Design Mobile)
   ------------------------------------------------
   ENTRY:  Screen 1 任一文稿行长按 500ms
   EXIT:   选操作 → 收起 Sheet 并原地更新列表；「取消」/点遮罩 → 回 Screen 1
   BRANCH: 「删除」→ 共享 closeTab 的脏标签确认；「重命名」→ 键盘弹起的重命名 Dialog
   ================================================ */
function DocActionSheet({
  tab,
  onClose,
  onRename,
  onHistory,
  onDelete,
  onMove,
}: {
  tab: MobileTab | null
  onClose: () => void
  onRename: (tab: MobileTab) => void
  onHistory: (tab: MobileTab) => void
  onDelete: (tab: MobileTab) => void
  onMove: () => void
}) {
  const ws = useMobileWorkspace()
  const t = useT()
  const meta = tab ? SAVE_STATE[ws.saveStateOf(tab)] : null

  return (
    <ActionSheet
      visible={!!tab}
      onClose={onClose}
      cancelText={t('dialog.cancel')}
      extra={
        tab && meta ? (
          <div style={{ textAlign: 'center' }}>
            <div className="pl-doc-name">{tab.name}</div>
            <div className="pl-num" style={{ color: 'var(--ink-soft)', fontSize: 12 }}>
              {t(meta.textKey)} · {formatRelative(tab.updatedAt || Date.now())}
            </div>
          </div>
        ) : null
      }
      actions={
        tab
          ? [
              { key: 'rename', text: <span><EditSOutline /> {t('mb.doc.rename')}</span>, onClick: () => onRename(tab) },
              { key: 'move', text: <span><FolderOutline /> {t('mb.doc.moveToFolder')}</span>, onClick: onMove },
              { key: 'history', text: <span><ClockCircleOutline /> {t('mb.doc.versionHistory')}</span>, onClick: () => onHistory(tab) },
              { key: 'delete', text: <span><DeleteOutline /> {t('mb.doc.delete')}</span>, danger: true, onClick: () => onDelete(tab) },
            ]
          : []
      }
    />
  )
}

/** Dialog.show 的内容脱离父组件渲染，需自带状态再把值回传给闭包 */
function RenameInput({ initial, onChange }: { initial: string; onChange: (value: string) => void }) {
  const t = useT()
  const [value, setValue] = useState(initial)
  return (
    <Input
      value={value}
      onChange={v => {
        setValue(v)
        onChange(v)
      }}
      placeholder={t('mb.doc.nameShort')}
      clearable
    />
  )
}

// =============================================
// FLOW: Documents List & Quick Draft (4 screens)
// Scenario: Mobile Productivity（适配到文档工具）
//   锚点 = Canonical Flow 1「快速添加任务」+ Flow 3「日视图列表主屏」
//   差异 = ① 行右侧是保存态徽标而非完成 checkbox
//          ② FAB 产物是空草稿并立即进入工作区（不留在列表）
//          ③ 新增 Screen 3「导入文件」：移动浏览器无 showDirectoryPicker（src/fs.js:7）
// Platform: H5 (Ant Design Mobile)
// =============================================

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActionSheet,
  Button,
  CheckList,
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
import { formatBytes, formatRelative, formatWords, wait } from './shared/format'
import { useKeyboardInset, useLongPress, useNetworkState } from './shared/hooks'
import { DOC_KIND_LABEL, SAVE_STATE } from './shared/labels'
import { mockDocuments, mockFolders, mockImportable, mockTemplates } from './shared/mock-data'
import type { DocKind, DocumentMeta } from './shared/types'

const PAGE_SIZE = 4

const KIND_ICON: Record<DocKind, ReactNode> = {
  tex: <FileOutline />,
  md: <ContentOutline />,
  image: <PictureOutline />,
  pdf: <EyeOutline />,
}

/**
 * 单行文稿行。
 * 不用 List.Item：它只转发 onClick（list-item.js 不 spread rest props），
 * 长按手势挂不上去；改为自发行组件，触控高度 60px ≥ 48px 下限。
 */
function DocRow({
  doc,
  onOpen,
  onLongPress,
  onHistory,
  onDelete,
}: {
  doc: DocumentMeta
  onOpen: (doc: DocumentMeta) => void
  onLongPress: (doc: DocumentMeta) => void
  onHistory: (doc: DocumentMeta) => void
  onDelete: (doc: DocumentMeta) => void
}) {
  const { handlers, consumeClick } = useLongPress(() => onLongPress(doc))
  const state = SAVE_STATE[doc.saveState]

  return (
    <SwipeAction
      closeOnAction
      rightActions={[
        { key: 'history', text: '历史', color: 'primary', onClick: () => onHistory(doc) },
        { key: 'delete', text: '删除', color: 'danger', onClick: () => onDelete(doc) },
      ]}
    >
      <button
        type="button"
        className="pl-doc-row"
        aria-label={`${doc.name}，${state.text}`}
        {...handlers}
        onClick={() => {
          // 长按已弹 ActionSheet，吞掉手指抬起补发的 click
          if (consumeClick()) return
          onOpen(doc)
        }}
      >
        <span className="pl-doc-icon">{KIND_ICON[doc.kind]}</span>
        <span className="pl-doc-main">
          <span className="pl-doc-name">{doc.name}</span>
          <span className="pl-doc-meta pl-num">
            <span>{formatRelative(doc.updatedAt)}</span>
            <span>{doc.words ? formatWords(doc.words) : DOC_KIND_LABEL[doc.kind]}</span>
          </span>
        </span>
        <Tag color={state.color} fill="outline">
          {state.text}
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
  const [docs, setDocs] = useState<DocumentMeta[]>(mockDocuments)
  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [hasMore, setHasMore] = useState(mockDocuments.length > PAGE_SIZE)
  const [sheet, setSheet] = useState<'none' | 'new' | 'import'>('none')
  const [actionDoc, setActionDoc] = useState<DocumentMeta | null>(null)
  const [undoDoc, setUndoDoc] = useState<DocumentMeta | null>(null)

  const filtered = useMemo(
    () => docs.filter(d => d.name.toLowerCase().includes(query.trim().toLowerCase())),
    [docs, query],
  )

  // STATE: default — 分组列表（草稿 + 文件夹）
  // STATE: loading — PullToRefresh 自带上拉指示，首屏用 Skeleton 由 Shell 负责
  // STATE: empty — Empty + 外层 div 放 CTA（B2：不嵌套 children）
  // STATE: error — 保存失败态以 danger Tag 常驻行右侧，点击行仍可进工作区
  // STATE: offline — Screen 3 导入按钮禁用并提示（本机 TeX 服务不可达时编译入口同样降级）
  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
    setHasMore(filtered.length > PAGE_SIZE)
  }, [filtered.length])

  const loadMore = async () => {
    if (visibleCount >= filtered.length) {
      setHasMore(false)
      return
    }
    await wait(400)
    setVisibleCount(count => count + PAGE_SIZE)
  }

  const onRefresh = async () => {
    await wait(700)
    Toast.show({ content: '已同步到最新', icon: 'success' })
  }

  const openDoc = (doc: DocumentMeta) => navigate(`/m/workspace/${doc.id}`)

  const removeDoc = (doc: DocumentMeta) => {
    setDocs(list => list.filter(d => d.id !== doc.id))
    setUndoDoc(doc)
    setActionDoc(null)
    Toast.show({ content: `已删除「${doc.name}」` })
  }

  const confirmDelete = (doc: DocumentMeta) => {
    setActionDoc(null)
    Dialog.confirm({
      title: '删除文稿？',
      content: `「${doc.name}」${doc.folder ? `来自文件夹「${doc.folder}」，删除只影响本机的打开记录。` : '是浏览器草稿，删除后无法找回。'}`,
      confirmText: '删除',
      cancelText: '取消',
      onConfirm: () => removeDoc(doc),
    })
  }

  const askRename = (doc: DocumentMeta) => {
    setActionDoc(null)
    let next = doc.name
    Dialog.show({
      title: '重命名',
      content: <RenameInput initial={doc.name} onChange={value => { next = value }} />,
      closeOnAction: true,
      actions: [
        [
          { key: 'cancel', text: '取消' },
          {
            key: 'ok',
            text: '确定',
            bold: true,
            onClick: () => {
              const name = next.trim()
              if (!name) {
                Toast.show({ content: '名称不能为空' })
                return
              }
              setDocs(list => list.map(d => (d.id === doc.id ? { ...d, name } : d)))
              Toast.show({ content: '已重命名', icon: 'success' })
            },
          },
        ],
      ],
    })
  }

  const drafts = filtered.filter(d => d.folder === null)
  const folderGroups = mockFolders
    .map(folder => ({ folder, rows: filtered.filter(d => d.folder === folder.name) }))
    .filter(group => group.rows.length > 0)
  const pageRows = filtered.slice(0, visibleCount)

  return (
    <div className="pl-screen">
      {/* NavBar 无 onRightClick prop（nav-bar.d.ts 只有 back/left/right/onBack），右侧需自带可点节点 */}
      <NavBar
        back={null}
        right={
          <Button fill="none" size="small" style={{ color: 'var(--accent)' }} onClick={() => setSheet('import')}>
            <UploadOutline /> 导入
          </Button>
        }
      >
        文稿
      </NavBar>

      {banner}

      {undoDoc && (
        <NoticeBar
          color="info"
          content={`已删除「${undoDoc.name}」`}
          extra={
            <Button
              fill="none"
              size="mini"
              onClick={() => {
                setDocs(list => [undoDoc, ...list])
                setUndoDoc(null)
              }}
            >
              撤销
            </Button>
          }
        />
      )}

      <div style={{ padding: '8px 12px', background: 'var(--chrome)' }}>
        {/* 搜索：桌面端无查找替换 UI（audit-23），移动端先给文件名检索 */}
        <SearchBar
          placeholder="按文件名搜索"
          value={query}
          onChange={setQuery}
          onSearch={setQuery}
          onClear={() => setQuery('')}
        />
      </div>

      <PullToRefresh onRefresh={onRefresh}>
        {pageRows.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '32px 16px' }}>
            <Empty description={query ? `没有匹配「${query}」的文稿` : '还没有文稿'} />
            <div style={{ marginTop: 16 }}>
              <Button color="primary" onClick={() => setSheet('new')}>
                新建第一篇草稿
              </Button>
            </div>
          </div>
        ) : (
          <>
            {drafts.length > 0 && (
              <>
                <div className="pl-group-head">最近草稿 · 仅存本机</div>
                {drafts.map(doc => (
                  <DocRow
                    key={doc.id}
                    doc={doc}
                    onOpen={openDoc}
                    onLongPress={setActionDoc}
                    onHistory={d => navigate(`/m/history/${d.id}`)}
                    onDelete={confirmDelete}
                  />
                ))}
              </>
            )}
            {folderGroups.map(group => (
              <div key={group.folder.name}>
                <div className="pl-group-head">
                  <FolderOutline /> {group.folder.name} · {group.folder.docCount} 个文件
                  {!group.folder.writable && <Tag fill="outline">只读</Tag>}
                </div>
                {group.rows.map(doc => (
                  <DocRow
                    key={doc.id}
                    doc={doc}
                    onOpen={openDoc}
                    onLongPress={setActionDoc}
                    onHistory={d => navigate(`/m/history/${d.id}`)}
                    onDelete={confirmDelete}
                  />
                ))}
              </div>
            ))}
            <InfiniteScroll loadMore={loadMore} hasMore={hasMore} />
          </>
        )}
      </PullToRefresh>

      {/* FAB：antd-mobile 无 FloatButton，自实现；绝对定位于内容容器内，不用 position:fixed */}
      <button type="button" className="pl-fab" aria-label="新建草稿" onClick={() => setSheet('new')}>
        <AddOutline style={{ fontSize: 24 }} />
      </button>

      {/* → 点 FAB / 空状态 CTA → SCREEN 2: 新建草稿 Sheet */}
      <NewDraftSheet
        visible={sheet === 'new'}
        onClose={() => setSheet('none')}
        onCreated={doc => {
          setSheet('none')
          setDocs(list => [doc, ...list])
          navigate(`/m/workspace/${doc.id}`)
        }}
      />

      {/* → 点导航右侧「导入」→ SCREEN 3: 导入文件 Sheet */}
      <ImportSheet visible={sheet === 'import'} onClose={() => setSheet('none')} />

      {/* → 长按行 → SCREEN 4: 文档 Action Sheet */}
      <DocActionSheet
        doc={actionDoc}
        onClose={() => setActionDoc(null)}
        onRename={askRename}
        onHistory={d => {
          setActionDoc(null)
          navigate(`/m/history/${d.id}`)
        }}
        onDelete={confirmDelete}
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
  onCreated: (doc: DocumentMeta) => void
}) {
  const [name, setName] = useState('')
  const [template, setTemplate] = useState<string>(mockTemplates[0].id)
  const [folder, setFolder] = useState<string>('')
  const [more, setMore] = useState(false)
  const keyboard = useKeyboardInset()

  // 每次重新打开都回到干净状态，避免上次输入残留
  useEffect(() => {
    if (!visible) {
      setName('')
      setMore(false)
    }
  }, [visible])

  const trimmed = name.trim()

  const create = () => {
    onCreated({
      id: `d${Date.now()}`,
      name: trimmed.endsWith('.tex') || trimmed.endsWith('.md') ? trimmed : `${trimmed}.tex`,
      kind: trimmed.endsWith('.md') ? 'md' : 'tex',
      folder: folder || null,
      saveState: 'browser-pending',
      words: 0,
      updatedAt: Date.now(),
      scrollY: 0,
    })
  }

  return (
    <Popup
      visible={visible}
      onMaskClick={onClose}
      onClose={onClose}
      position="bottom"
      closeOnSwipe
      bodyStyle={{
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
        // 键盘弹起时整块 Sheet 上移，否则输入框被软键盘遮住（iOS 不会自动顶起）
        bottom: keyboard,
      }}
    >
      <div className="pl-sheet">
        <div className="pl-sheet-head">
          <span>新建草稿</span>
          <Button color="primary" size="small" disabled={!trimmed} onClick={create}>
            完成
          </Button>
        </div>

        <div className="pl-sheet-body" style={{ padding: '12px 16px' }}>
          {/* STATE: default — 标题为空，「完成」disabled */}
          {/* STATE: filled — 标题非空，可直接创建 */}
          {/* STATE: error — 同名冲突时 onCreated 前由工作区提示（此处保留输入内容） */}
          <Input
            placeholder="文稿名，例如 第三章-方法.tex"
            value={name}
            onChange={setName}
            clearable
            autoFocus
            enterKeyHint="done"
            onEnterPress={() => {
              if (trimmed) create()
            }}
          />

          <div style={{ margin: '16px 0 8px', color: 'var(--ink-soft)', fontSize: 12 }}>起始内容</div>
          <Selector
            columns={1}
            value={[template]}
            onChange={v => setTemplate((v[0] as string) ?? mockTemplates[0].id)}
            options={mockTemplates.map(t => ({ label: `${t.name} · ${t.note}`, value: t.id }))}
          />

          <Button
            fill="none"
            size="small"
            style={{ marginTop: 12, padding: 0, color: 'var(--accent)' }}
            onClick={() => setMore(m => !m)}
          >
            {more ? '收起更多选项' : '更多选项（存放位置）'}
          </Button>

          {more && (
            <div style={{ marginTop: 12 }}>
              <div style={{ marginBottom: 8, color: 'var(--ink-soft)', fontSize: 12 }}>放入</div>
              <Selector
                columns={2}
                value={[folder]}
                onChange={v => setFolder((v[0] as string) ?? '')}
                options={[
                  { label: '浏览器草稿（不落盘）', value: '' },
                  ...mockFolders.filter(f => f.writable).map(f => ({ label: f.name, value: f.name })),
                ]}
              />
              <div style={{ marginTop: 8, color: 'var(--ink-faint)', fontSize: 11 }}>
                手机端无法写入本机文件夹，选「浏览器草稿」的稿子只存在于这台设备。
              </div>
            </div>
          )}
        </div>

        <div className="pl-sheet-foot">
          <Button block fill="none" onClick={onClose}>
            取消
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
   EXIT:   「导入 N 个文件」→ 回 Screen 1，文件进入文件夹分组
   BRANCH: 离线 → 按钮禁用 + 提示；授权被拒 → 仅提示，不阻断浏览已有文稿
   ================================================ */
function ImportSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [picked, setPicked] = useState<string[]>(mockImportable.filter(f => f.picked).map(f => f.name))
  const [folderMode, setFolderMode] = useState(false)
  const network = useNetworkState()
  const plainInput = useRef<HTMLInputElement>(null)
  const dirInput = useRef<HTMLInputElement>(null)

  // webkitdirectory 不是 React 标准属性，只能在 effect 里落到真实 DOM
  useEffect(() => {
    if (dirInput.current) dirInput.current.setAttribute('webkitdirectory', '')
  }, [])

  useEffect(() => {
    if (!visible) setFolderMode(false)
  }, [visible])

  const totalBytes = mockImportable
    .filter(f => picked.includes(f.name))
    .reduce((sum, f) => sum + f.size, 0)

  const doImport = () => {
    onClose()
    Toast.show({ content: `已导入 ${picked.length} 个文件`, icon: 'success' })
  }

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
          <span>导入文稿</span>
          <span className="pl-num" style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
            已选 {picked.length} 个 · {formatBytes(totalBytes)}
          </span>
        </div>

        <NoticeBar
          color="alert"
          wrap
          content="移动浏览器不支持授权本机文件夹（没有 showDirectoryPicker），这里改为按需上传副本；改完需回到桌面端写回原文件。"
        />

        <div style={{ display: 'flex', gap: 8, padding: '12px 16px' }}>
          <Button
            className="pl-min-touch"
            fill="outline"
            size="small"
            onClick={() => {
              setFolderMode(false)
              plainInput.current?.click()
            }}
          >
            选择文件（可多选）
          </Button>
          <Button
            className="pl-min-touch"
            fill="outline"
            size="small"
            onClick={() => {
              setFolderMode(true)
              dirInput.current?.click()
            }}
          >
            选择文件夹
          </Button>
          <input ref={plainInput} type="file" multiple accept=".tex,.md,.bib,.txt,.png,.jpg,.svg,.pdf" hidden />
          <input ref={dirInput} type="file" multiple hidden />
        </div>

        <div className="pl-sheet-body">
          <CheckList multiple value={picked} onChange={v => setPicked(v as string[])}>
            {mockImportable.map(file => (
              <CheckList.Item key={file.name} value={file.name} description={formatBytes(file.size)}>
                {file.name}
              </CheckList.Item>
            ))}
          </CheckList>
        </div>

        <div className="pl-sheet-foot">
          {/* STATE: offline — 禁用主按钮并说明原因 */}
          {network === 'offline' && (
            <div style={{ flex: 1, color: 'var(--seal)', fontSize: 12 }}>当前离线，导入需联网读取云端项目</div>
          )}
          <Button color="primary" disabled={picked.length === 0 || network === 'offline'} onClick={doImport}>
            导入 {picked.length} 个文件
          </Button>
        </div>

        {folderMode && (
          <div style={{ padding: '0 16px 12px', color: 'var(--ink-faint)', fontSize: 11 }}>
            「选择文件夹」在部分安卓浏览器可用；iOS Safari 会退化成单文件选择。
          </div>
        )}
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
   BRANCH: 「删除」→ Screen 4a 确认 Dialog；「重命名」→ 键盘弹起的重命名 Dialog
   ================================================ */
function DocActionSheet({
  doc,
  onClose,
  onRename,
  onHistory,
  onDelete,
}: {
  doc: DocumentMeta | null
  onClose: () => void
  onRename: (doc: DocumentMeta) => void
  onHistory: (doc: DocumentMeta) => void
  onDelete: (doc: DocumentMeta) => void
}) {
  return (
    <ActionSheet
      visible={!!doc}
      onClose={onClose}
      cancelText="取消"
      extra={
        doc ? (
          <div style={{ textAlign: 'center' }}>
            <div className="pl-doc-name">{doc.name}</div>
            <div className="pl-num" style={{ color: 'var(--ink-soft)', fontSize: 12 }}>
              {SAVE_STATE[doc.saveState].text} · {formatRelative(doc.updatedAt)}
              {doc.words ? ` · ${formatWords(doc.words)}` : ''}
            </div>
          </div>
        ) : null
      }
      actions={
        doc
          ? [
              { key: 'rename', text: <span><EditSOutline /> 重命名</span>, onClick: () => onRename(doc) },
              {
                key: 'move',
                text: <span><FolderOutline /> 移入文件夹</span>,
                onClick: () => {
                  onClose()
                  Toast.show({ content: '跨文件夹整理请在桌面端完成' })
                },
              },
              { key: 'history', text: <span><ClockCircleOutline /> 版本历史</span>, onClick: () => onHistory(doc) },
              { key: 'delete', text: <span><DeleteOutline /> 删除</span>, danger: true, onClick: () => onDelete(doc) },
            ]
          : []
      }
    />
  )
}

/** Dialog.show 的内容是脱离父组件渲染的，需自带状态再把值回传给闭包 */
function RenameInput({ initial, onChange }: { initial: string; onChange: (value: string) => void }) {
  const [value, setValue] = useState(initial)
  return (
    <Input
      value={value}
      onChange={v => {
        setValue(v)
        onChange(v)
      }}
      placeholder="文稿名"
      clearable
    />
  )
}

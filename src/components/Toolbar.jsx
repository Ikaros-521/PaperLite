import { useEffect, useRef, useState } from 'react';

/* 顶栏重构为经典菜单栏（文件/编辑/插入/查看/TeX/AI/帮助）+ 第二行上下文工具条。
 * 菜单行为遵循桌面惯例：点击展开、再点收起、展开时悬停切换、Esc / 点击外部关闭、
 * 选中项执行后自动收起。 */

function Mi({ check, icon, label, hint, disabled, onClick, close }) {
  return (
    <button
      className="mi" role="menuitem"
      disabled={disabled}
      onClick={e => { if (disabled) return; onClick && onClick(e); close && close(); }}
    >
      <span className="mi-check">{check ? '✓' : ''}</span>
      {icon ? <span className="mi-ico">{icon}</span> : null}
      <span className="mi-label">{label}</span>
      {hint ? <span className="mi-hint">{hint}</span> : null}
    </button>
  );
}

const MSep = () => <div className="mi-sep" role="separator"></div>;

/* 悬停展开的二级子菜单（从模板新建 / 视图 / 预览缩放） */
function MiSub({ icon, label, children }) {
  return (
    <div className="mi mi-sub" role="menuitem" tabIndex={-1}>
      <span className="mi-check"></span>
      {icon ? <span className="mi-ico">{icon}</span> : null}
      <span className="mi-label">{label}</span>
      <span className="mi-hint">▸</span>
      <div className="mb-menu sub" role="menu">{children}</div>
    </div>
  );
}

function Mb({ title, open, setOpen, width = 220, disabled, children }) {
  const isOpen = open === title;
  return (
    <div
      className={'mb-item' + (isOpen ? ' open' : '') + (disabled ? ' disabled' : '')}
      onMouseEnter={() => { if (open && !disabled) setOpen(title); }}
    >
      <button
        className="mb-title"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => { if (!disabled) setOpen(isOpen ? null : title); }}
      >
        {title}
      </button>
      {isOpen && <div className="mb-menu" style={{ minWidth: width }} role="menu">{children}</div>}
    </div>
  );
}

export default function Toolbar({
  actions, viewMode, setViewMode, latexOk,
  engines, engine, setEngine, compiling, onCompile, downloadPdf,
  channelCount, onOpenChat, onOpenSettings, onAiFix,
  syncScroll, setSyncScroll, zoom, onZoom,
  onHelp
}) {
  const [open, setOpen] = useState(null);
  const rootRef = useRef(null);
  const close = () => setOpen(null);

  useEffect(() => {
    const onDoc = e => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(null); };
    const onKey = e => { if (e.key === 'Escape') setOpen(null); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, []);

  const engineOk = engines && engines.length;
  const tool = id => () => latexOk && actions.tool(id);
  const editOp = op => () => actions.editOp(op);

  // 第二行：高频格式/插入工具（非 .tex/.md 标签时整行隐藏，把纵向空间还给编辑器）
  const T = [
    ['tSec', 'H1', '插入 \\section'],
    ['tSub', 'H2', '插入 \\subsection'],
    null,
    ['tB', 'B', '加粗 Ctrl+B'],
    ['tI', 'I', '斜体 Ctrl+I'],
    ['tU', 'U', '下划线'],
    ['tTt', 'T', '等宽'],
    null,
    ['tMath', '$x$', '行内公式'],
    ['tEq', '∑', '行间公式环境'],
    null,
    ['tList', '•≡', '无序列表'],
    ['tEnum', '1≡', '有序列表'],
    ['tTable', '▦', '三线表'],
    ['tImg', '🖼', '插入本地图片（base64 内嵌）'],
    ['tFlow', '🔀 流程图', '插入 TikZ 流程图'],
    ['tMermaid', '🏝', '插入 Mermaid 图'],
    null,
    ['tBib', '[引]', '插入引用'],
    ['tFn', '†', '脚注']
  ];

  return (
    <header id="topbar" ref={rootRef}>
      <div id="menubar">
        <div className="brand compact">📄 PaperLite</div>

        <nav className="menus" role="menubar">
          <Mb title="文件" open={open} setOpen={setOpen} width={236}>
            <Mi icon="📂" label="打开文件夹…" close={close} onClick={actions.openFolder} />
            <Mi icon="🗎" label="打开文件…" close={close} onClick={actions.openFile} />
            <Mi icon="💾" label="保存" hint="Ctrl+S" close={close} onClick={actions.save} />
            <MSep />
            <MiSub icon="✨" label="从模板新建">
              <Mi icon="📄" label="中文示例论文（推荐）" close={close} onClick={() => actions.loadTemplate('demo')} />
              <Mi icon="🔀" label="TikZ 流程图速查" close={close} onClick={() => actions.loadTemplate('flow')} />
              <Mi icon="✒️" label="空白论文" close={close} onClick={() => actions.loadTemplate('blank')} />
            </MiSub>
            <MSep />
            <Mi icon="⬇" label="下载 .tex" close={close} onClick={actions.exportTex} />
            <Mi icon="🖨" label="导出 PDF…" hint="打印为矢量 PDF" close={close} onClick={actions.exportPdf} />
          </Mb>

          <Mb title="编辑" open={open} setOpen={setOpen} width={220}>
            <Mi icon="↶" label="撤销" hint="Ctrl+Z" close={close} onClick={editOp('undo')} />
            <Mi icon="↷" label="重做" hint="Ctrl+Shift+Z" close={close} onClick={editOp('redo')} />
            <MSep />
            <Mi icon="▦" label="全选" hint="Ctrl+A" close={close} onClick={editOp('selectAll')} />
            <MSep />
            <Mi icon="🛠" label="AI 修复语法…" disabled={!channelCount} close={close} onClick={onAiFix} />
          </Mb>

          <Mb title="插入" open={open} setOpen={setOpen} width={220} disabled={!latexOk}>
            <Mi icon="H1" label="分节 \\section" close={close} onClick={tool('tSec')} />
            <Mi icon="H2" label="小节 \\subsection" close={close} onClick={tool('tSub')} />
            <MSep />
            <Mi icon="B" label="加粗 \\textbf" hint="Ctrl+B" close={close} onClick={tool('tB')} />
            <Mi icon="I" label="斜体 \\emph" hint="Ctrl+I" close={close} onClick={tool('tI')} />
            <Mi icon="U" label="下划线 \\underline" close={close} onClick={tool('tU')} />
            <Mi icon="T" label="等宽 \\texttt" close={close} onClick={tool('tTt')} />
            <MSep />
            <Mi icon="∑" label="行内公式 $…$" close={close} onClick={tool('tMath')} />
            <Mi icon="∑" label="行间公式环境" close={close} onClick={tool('tEq')} />
            <MSep />
            <Mi icon="•" label="无序列表 itemize" close={close} onClick={tool('tList')} />
            <Mi icon="1." label="有序列表 enumerate" close={close} onClick={tool('tEnum')} />
            <Mi icon="▦" label="三线表 booktabs" close={close} onClick={tool('tTable')} />
            <Mi icon="🖼" label="本地图片…" close={close} onClick={tool('tImg')} />
            <MSep />
            <Mi icon="🔀" label="TikZ 流程图" close={close} onClick={tool('tFlow')} />
            <Mi icon="🏝" label="Mermaid 图" close={close} onClick={tool('tMermaid')} />
            <MSep />
            <Mi icon="[引]" label="引用 \\cite" close={close} onClick={tool('tBib')} />
            <Mi icon="†" label="脚注 \\footnote" close={close} onClick={tool('tFn')} />
          </Mb>

          <Mb title="查看" open={open} setOpen={setOpen} width={220}>
            <MiSub icon="🖥" label="视图">
              <Mi check={viewMode === 'edit'} label="仅编辑" close={close} onClick={() => setViewMode('edit')} />
              <Mi check={viewMode === 'split'} label="编辑 + 预览" close={close} onClick={() => setViewMode('split')} />
              <Mi check={viewMode === 'preview'} label="仅预览" close={close} onClick={() => setViewMode('preview')} />
            </MiSub>
            <Mi check={syncScroll} label="编辑器与预览同步滚动" close={close} onClick={() => setSyncScroll(!syncScroll)} />
            <MSep />
            <MiSub icon="🔍" label="预览缩放">
              <Mi icon="＋" label="放大" close={close} onClick={() => onZoom(0.1)} />
              <Mi icon="－" label="缩小" close={close} onClick={() => onZoom(-0.1)} />
              <Mi label={`重置（当前 ${Math.round(zoom * 100)}%）`} close={close} onClick={() => onZoom(1 - zoom)} />
            </MiSub>
          </Mb>

          <Mb title="TeX" open={open} setOpen={setOpen} width={248}>
            {engineOk ? engines.map(en => (
              <Mi key={en} check={engine === en} label={en} close={close} onClick={() => setEngine(en)} />
            )) : <div className="mi-note">未检测到本机 TeX 引擎</div>}
            <MSep />
            <Mi icon="⚙" label={compiling ? '⟳ 编译中…' : '编译当前文档'}
              disabled={!engineOk || compiling} close={close} onClick={onCompile} />
            <Mi icon="⬇" label="下载编译 PDF" disabled={!downloadPdf} close={close} onClick={downloadPdf} />
            <MSep />
            <div className="mi-note">安装 MiKTeX / TeX Live 后，经 node server.mjs 访问即可编译</div>
          </Mb>

          <Mb title={'AI' + (channelCount ? '' : ' ·')} open={open} setOpen={setOpen} width={220}>
            <Mi icon="💬" label="AI 助手" close={close} onClick={onOpenChat} />
            <Mi icon="⚙" label="AI 设置…" close={close} onClick={onOpenSettings} />
            <MSep />
            <Mi icon="🛠" label="AI 修复语法…" disabled={!channelCount} close={close} onClick={onAiFix} />
            {!channelCount && <div className="mi-note">尚未配置渠道，请先到 AI 设置添加</div>}
          </Mb>

          <Mb title="帮助" open={open} setOpen={setOpen} width={200}>
            <Mi icon="⌨" label="快捷键" close={close} onClick={() => onHelp('keys')} />
            <Mi icon="ℹ️" label="关于 PaperLite" close={close} onClick={() => onHelp('about')} />
          </Mb>
        </nav>

        <div className="mb-right">
          <div className="view-switch" title="视图切换：仅编辑 / 分栏 / 仅预览">
            {[['edit', '✎', '仅编辑'], ['split', '▤▤', '分栏'], ['preview', '👁', '仅预览']].map(([m, ic, ti]) => (
              <button key={m} className={'btn sm' + (viewMode === m ? ' on' : '')} title={ti} onClick={() => setViewMode(m)}>{ic}</button>
            ))}
          </div>
          <button className="btn sm primary" title="调起浏览器打印，选择「另存为 PDF」即得矢量 PDF" onClick={actions.exportPdf}>🖨 导出 PDF</button>
        </div>
      </div>

      <div id="toolbelt" className="tb-group edit-tools" style={{ display: latexOk ? '' : 'none' }}>
        {T.map((t, i) => t === null
          ? <span key={i} className="tsep"></span>
          : <button
              key={t[0]}
              id={t[0]}
              className={'btn sm' + (t[0] === 'tFlow' ? ' accent' : '')}
              title={t[2]}
              onClick={tool(t[0])}
            >
              {t[1] === 'B' ? <b>B</b> : t[1] === 'I' ? <i>I</i> : t[1] === 'U' ? <u>U</u> : t[1]}
            </button>
        )}
      </div>
    </header>
  );
}

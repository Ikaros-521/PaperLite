import { useEffect, useRef, useState } from 'react';
import { useT } from '../useI18n.js';

/* 顶栏重构为经典菜单栏（文件/编辑/插入/查看/TeX/AI/帮助）+ 第二行上下文工具条。
 * 菜单行为遵循桌面惯例：点击展开、再点收起、展开时悬停切换、Esc / 点击外部关闭、
 * 选中项执行后自动收起。右侧附中/英切换。 */

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

/* 中/英切换：双态分段控件，当前语言高亮 */
function LangSwitch({ lang, setLang }) {
  const t = useT();
  return (
    <div className="view-switch lang-switch" title={t('lang.tip')}>
      {[['zh', '中'], ['en', 'EN']].map(([l, ic]) => (
        <button key={l} className={'btn sm' + (lang === l ? ' on' : '')} onClick={() => setLang(l)}>{ic}</button>
      ))}
    </div>
  );
}

export default function Toolbar({
  actions, viewMode, setViewMode, latexOk,
  engines, engine, setEngine, compiling, onCompile, downloadPdf,
  channelCount, onOpenChat, onOpenSettings, onAiFix,
  syncScroll, setSyncScroll, zoom, onZoom,
  onHelp, lang, setLang
}) {
  const t = useT();
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
  // tFlow 按钮文字含中文「流程图」，英文下改用符号组合
  const flowLabel = lang === 'zh' ? '→ 流程图' : '⇥ Flow';
  const T = [
    ['tSec', 'H1', t('t.sec')],
    ['tSub', 'H2', t('t.sub')],
    null,
    ['tB', 'B', t('t.bold')],
    ['tI', 'I', t('t.italic')],
    ['tU', 'U', t('t.underline')],
    ['tTt', 'T', t('t.mono')],
    null,
    ['tMath', '$x$', t('t.inlineMath')],
    ['tEq', '∑', t('t.displayMath')],
    null,
    ['tList', '•≡', t('t.itemize')],
    ['tEnum', '1≡', t('t.enumerate')],
    ['tTable', '▦', t('t.table')],
    ['tImg', '▣', t('t.image')],
    ['tFlow', flowLabel, t('t.flow')],
    ['tMermaid', '≈', t('t.mermaid')],
    null,
    ['tBib', '[引]', t('t.cite')],
    ['tFn', '†', t('t.footnote')]
  ];

  return (
    <header id="topbar" ref={rootRef}>
      <div id="menubar">
        <div className="brand compact"><span className="brand-seal">论</span>PaperLite</div>

        <nav className="menus" role="menubar">
          <Mb title={t('menu.file')} open={open} setOpen={setOpen} width={236}>
            <Mi label={t('m.new')} hint="Ctrl+Alt+N" close={close} onClick={actions.newFile} />
            <Mi label={t('m.openFolder')} close={close} onClick={actions.openFolder} />
            <Mi label={t('m.openFile')} close={close} onClick={actions.openFile} />
            <Mi label={t('m.save')} hint="Ctrl+S" close={close} onClick={actions.save} />
            <MSep />
            <MiSub label={t('m.newFromTpl')}>
              <Mi label={t('m.tplDemo')} close={close} onClick={() => actions.loadTemplate('demo')} />
              <Mi label={t('m.tplFlow')} close={close} onClick={() => actions.loadTemplate('flow')} />
              <Mi label={t('m.tplBlank')} close={close} onClick={() => actions.loadTemplate('blank')} />
            </MiSub>
            <MSep />
            <Mi label={t('m.dlTex')} hint={t('m.dlTexHint')} close={close} onClick={actions.exportTex} />
            <Mi label={t('m.exportPdf')} hint={t('m.exportPdfHint')} close={close} onClick={actions.exportPdf} />
          </Mb>

          <Mb title={t('menu.edit')} open={open} setOpen={setOpen} width={220}>
            <Mi icon="↶" label={t('m.undo')} hint="Ctrl+Z" close={close} onClick={editOp('undo')} />
            <Mi icon="↷" label={t('m.redo')} hint="Ctrl+Shift+Z" close={close} onClick={editOp('redo')} />
            <MSep />
            <Mi icon="▦" label={t('m.selectAll')} hint="Ctrl+A" close={close} onClick={editOp('selectAll')} />
            <MSep />
            <Mi label={t('m.aiFix')} disabled={!channelCount} close={close} onClick={onAiFix} />
          </Mb>

          <Mb title={t('menu.insert')} open={open} setOpen={setOpen} width={220} disabled={!latexOk}>
            <Mi icon="H1" label={t('m.section')} close={close} onClick={tool('tSec')} />
            <Mi icon="H2" label={t('m.subsection')} close={close} onClick={tool('tSub')} />
            <MSep />
            <Mi icon="B" label={t('m.bold')} hint="Ctrl+B" close={close} onClick={tool('tB')} />
            <Mi icon="I" label={t('m.italic')} hint="Ctrl+I" close={close} onClick={tool('tI')} />
            <Mi icon="U" label={t('m.underline')} close={close} onClick={tool('tU')} />
            <Mi icon="T" label={t('m.mono')} close={close} onClick={tool('tTt')} />
            <MSep />
            <Mi icon="∑" label={t('m.inlineMath')} close={close} onClick={tool('tMath')} />
            <Mi icon="∑" label={t('m.displayMath')} close={close} onClick={tool('tEq')} />
            <MSep />
            <Mi icon="•" label={t('m.itemize')} close={close} onClick={tool('tList')} />
            <Mi icon="1." label={t('m.enumerate')} close={close} onClick={tool('tEnum')} />
            <Mi icon="▦" label={t('m.booktabs')} close={close} onClick={tool('tTable')} />
            <Mi label={t('m.localImage')} close={close} onClick={tool('tImg')} />
            <MSep />
            <Mi label={t('m.tikzFlow')} close={close} onClick={tool('tFlow')} />
            <Mi label={t('m.mermaid')} close={close} onClick={tool('tMermaid')} />
            <MSep />
            <Mi icon="[引]" label={t('m.cite')} close={close} onClick={tool('tBib')} />
            <Mi icon="†" label={t('m.footnote')} close={close} onClick={tool('tFn')} />
          </Mb>

          <Mb title={t('menu.view')} open={open} setOpen={setOpen} width={220}>
            <MiSub label={t('m.viewMode')}>
              <Mi check={viewMode === 'edit'} label={t('m.vmEdit')} close={close} onClick={() => setViewMode('edit')} />
              <Mi check={viewMode === 'split'} label={t('m.vmSplit')} close={close} onClick={() => setViewMode('split')} />
              <Mi check={viewMode === 'preview'} label={t('m.vmPreview')} close={close} onClick={() => setViewMode('preview')} />
            </MiSub>
            <Mi check={syncScroll} label={t('m.syncScroll')} close={close} onClick={() => setSyncScroll(!syncScroll)} />
            <MSep />
            <MiSub label={t('m.zoom')}>
              <Mi icon="＋" label={t('m.zoomIn')} close={close} onClick={() => onZoom(0.1)} />
              <Mi icon="－" label={t('m.zoomOut')} close={close} onClick={() => onZoom(-0.1)} />
              <Mi label={t('m.zoomReset', { n: Math.round(zoom * 100) })} close={close} onClick={() => onZoom(1 - zoom)} />
            </MiSub>
          </Mb>

          <Mb title="TeX" open={open} setOpen={setOpen} width={248}>
            {engineOk ? engines.map(en => (
              <Mi key={en} check={engine === en} label={en} close={close} onClick={() => setEngine(en)} />
            )) : <div className="mi-note">{t('m.noEngine')}</div>}
            <MSep />
            <Mi label={compiling ? t('m.compiling') : t('m.compileDoc')}
              disabled={!engineOk || compiling} close={close} onClick={onCompile} />
            <Mi label={t('m.dlCompiled')} disabled={!downloadPdf} close={close} onClick={downloadPdf} />
            <MSep />
            <div className="mi-note">{t('m.engineNote')}</div>
          </Mb>

          <Mb title={'AI' + (channelCount ? '' : ' ·')} open={open} setOpen={setOpen} width={220}>
            <Mi label={t('m.aiAssistant')} close={close} onClick={onOpenChat} />
            <Mi label={t('m.aiSettings')} close={close} onClick={onOpenSettings} />
            <MSep />
            <Mi label={t('m.aiFix')} disabled={!channelCount} close={close} onClick={onAiFix} />
            {!channelCount && <div className="mi-note">{t('m.noChannel')}</div>}
          </Mb>

          <Mb title={t('menu.help')} open={open} setOpen={setOpen} width={200}>
            <Mi label={t('m.keys')} close={close} onClick={() => onHelp('keys')} />
            <Mi label={t('m.about')} close={close} onClick={() => onHelp('about')} />
          </Mb>
        </nav>

        <div className="mb-right">
          <LangSwitch lang={lang} setLang={setLang} />
          <div className="view-switch" title={t('vm.tip')}>
            {[['edit', '✎', t('vm.edit')], ['split', '▤▤', t('vm.split')], ['preview', '▢', t('vm.preview')]].map(([m, ic, ti]) => (
              <button key={m} className={'btn sm' + (viewMode === m ? ' on' : '')} title={ti} onClick={() => setViewMode(m)}>{ic}</button>
            ))}
          </div>
          <button className="btn sm primary" title={t('tb.exportPdfTip')} onClick={actions.exportPdf}>{t('tb.exportPdf')}</button>
        </div>
      </div>

      <div id="toolbelt" className="tb-group edit-tools" style={{ display: latexOk ? '' : 'none' }}>
        {T.map((x, i) => x === null
          ? <span key={i} className="tsep"></span>
          : <button
              key={x[0]}
              id={x[0]}
              className={'btn sm' + (x[0] === 'tFlow' ? ' accent' : '')}
              title={x[2]}
              onClick={tool(x[0])}
            >
              {x[1] === 'B' ? <b>B</b> : x[1] === 'I' ? <i>I</i> : x[1] === 'U' ? <u>U</u> : x[1]}
            </button>
        )}
      </div>
    </header>
  );
}

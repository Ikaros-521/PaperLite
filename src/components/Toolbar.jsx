import { useEffect, useRef, useState } from 'react';
import { useT } from '../useI18n.js';
import { THEME_IDS } from '../theme.js';
import QuickTools from './QuickTools.jsx';

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

/* 悬停展开的二级子菜单（从模板新建 / 视图 / 预览缩放）。
 * 悬停之外补点击切换：触屏没有 hover，纯 CSS 悬停在触屏上永远打不开。 */
function MiSub({ icon, label, children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    // 点击子菜单项后收起（子项 onClick 里拿不到这里的 setOpen，统一在外层监听）
    const close = e => { if (!ref.current || ref.current.contains(e.target)) return; setOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div
      ref={ref}
      className={'mi mi-sub' + (open ? ' sub-open' : '')}
      role="menuitem" tabIndex={0} aria-haspopup="menu" aria-expanded={open}
      onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
    >
      <span className="mi-check"></span>
      {icon ? <span className="mi-ico">{icon}</span> : null}
      <span className="mi-label">{label}</span>
      <span className="mi-hint">▸</span>
      <div className="mb-menu sub" role="menu" onClick={e => e.stopPropagation()}
        onPointerDown={e => e.stopPropagation()}>{children}</div>
    </div>
  );
}

function Mb({ title, open, setOpen, width = 220, disabled, tour, children }) {
  const isOpen = open === title;
  return (
    <div
      className={'mb-item' + (isOpen ? ' open' : '') + (disabled ? ' disabled' : '')}
      data-tour={tour}
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
  actions, viewMode, setViewMode, latexOk, markdown, documentKey, labels,
  engines, engine, setEngine, compiling, onCompile, onCancelCompile, downloadPdf, builtinStatus,
  channelCount, onOpenChat, onOpenSettings, onAiFix,
  syncScroll, setSyncScroll, zoom, onZoom,
  zen, setZen, typewriter, setTypewriter, snippets, onInsertSnippet, onManageSnippets,
  onHelp, lang, setLang,
  theme, setTheme, compact, sidebarOpen, onToggleSidebar, texDocument
}) {
  const t = useT();
  const [open, setOpen] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef(null);
  const close = () => { setOpen(null); setMenuOpen(false); };

  useEffect(() => {
    const onDoc = e => { if (rootRef.current && !rootRef.current.contains(e.target)) close(); };
    const onKey = e => { if (e.key === 'Escape') { close(); document.getElementById('compactMenuToggle')?.focus(); } };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, []);

  const engineOk = engines && engines.length;
  const statusKey = { loading: 'app.engineLoading', warming: 'app.engineWarming', error: 'app.engineError' }[builtinStatus];
  const engineLabel = en => en === 'builtin' ? t('app.builtinEngine') + (statusKey ? ' · ' + t(statusKey) : '') : en;
  const tool = id => () => latexOk && actions.tool(id);
  const editOp = op => () => actions.editOp(op);

  return (
    <header id="topbar" ref={rootRef}>
      <div id="menubar">
        <div className="brand compact"><span className="brand-seal">论</span>PaperLite</div>

        <button id="sidebarToggle" className="btn sm compact-control" aria-expanded={sidebarOpen} aria-controls="sidebar" onClick={onToggleSidebar}>{t('side.workspace')}</button>
        <button id="compactMenuToggle" className="btn sm compact-control" aria-expanded={menuOpen} aria-controls="mainMenus" onClick={() => { setMenuOpen(o => !o); setOpen(null); }}>{t('menu.all')}</button>
        <nav id="mainMenus" className={'menus' + (menuOpen ? ' expanded' : '')} role="menubar" data-tour="menubar">
          <Mb title={t('menu.file')} open={open} setOpen={setOpen} width={236} tour="menu-file">
            <Mi label={t('m.new')} hint="Ctrl+Alt+N" close={close} onClick={actions.newFile} />
            <Mi label={t('m.newFolder')} close={close} onClick={actions.newFolder} />
            <Mi label={t('m.upload')} close={close} onClick={actions.upload} />
            <Mi label={t('m.copy')} disabled={!actions.canCopy} close={close} onClick={actions.copy} />
            <MSep />
            <Mi label={t('m.openFolder')} close={close} onClick={actions.openFolder} />
            <Mi label={t('m.openFile')} close={close} onClick={actions.openFile} />
            <Mi label={t('m.save')} hint="Ctrl+S" disabled={!actions.canCopy} close={close} onClick={actions.save} />
            <MSep />
            <Mi label={t('m.history')} disabled={!actions.canCopy} close={close} onClick={actions.history} />
            <Mi label={t('m.wordCount')} disabled={!actions.canCopy} close={close} onClick={actions.wordCount} />
            <MSep />
            <MiSub label={t('m.newFromTpl')}>
              <Mi label={t('m.tplDemo')} close={close} onClick={() => actions.loadTemplate('demo')} />
              <Mi label={t('m.tplFlow')} close={close} onClick={() => actions.loadTemplate('flow')} />
              <Mi label={t('m.tplBlank')} close={close} onClick={() => actions.loadTemplate('blank')} />
            </MiSub>
            <MSep />
            <Mi label={t('m.submit')} close={close} onClick={actions.submit} />
            <MSep />
            <MiSub label={t('m.download')}>
              <Mi label={t('file.sourceZip')} disabled={actions.packaging} close={close} onClick={actions.sourceZip} />
              <Mi label={t('file.currentSource')} disabled={!actions.canCopy} close={close} onClick={actions.exportSource} />
              <Mi label={t('m.exportPdf')} disabled={!actions.pdfAvailable} hint={t('m.exportPdfHint')} close={close} onClick={actions.exportPdf} />
              <Mi label={t('m.dlCompiled')} disabled={!downloadPdf} close={close} onClick={downloadPdf} />
            </MiSub>
            <MSep />
            <Mi label={t('m.settings')} close={close} onClick={actions.settings} />
          </Mb>

          <Mb title={t('menu.edit')} open={open} setOpen={setOpen} width={220}>
            <Mi icon="↶" label={t('m.undo')} hint="Ctrl+Z" close={close} onClick={editOp('undo')} />
            <Mi icon="↷" label={t('m.redo')} hint="Ctrl+Shift+Z" close={close} onClick={editOp('redo')} />
            <MSep />
            <Mi icon="▦" label={t('m.selectAll')} hint="Ctrl+A" close={close} onClick={editOp('selectAll')} />
            <Mi icon="⌕" label={t('m.find')} hint="Ctrl+F" close={close} onClick={editOp('find')} />
            <Mi icon="⇄" label={t('m.replace')} hint="Ctrl+H" close={close} onClick={editOp('replace')} />
            <Mi icon="⌕⌕" label={t('m.gSearch')} close={close} onClick={actions.gSearch} />
            <MSep />
            <Mi label={t('m.aiFix')} disabled={!channelCount} close={close} onClick={onAiFix} />
          </Mb>

          <Mb title={t('menu.insert')} open={open} setOpen={setOpen} width={220} disabled={!latexOk} tour="menu-insert">
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
            <Mi icon="⌕" label={t('m.citeSearch')} close={close} disabled={!texDocument} onClick={tool('tCiteSearch')} />
            <MiSub label={t('m.mySnippets')}>
              {(snippets || []).map(s => (
                <Mi key={s.id} label={s.name} close={close} onClick={() => onInsertSnippet(s.content)} />
              ))}
              {(snippets || []).length > 0 && <MSep />}
              <Mi icon="✎" label={t('m.manageSnippets')} close={close} onClick={onManageSnippets} />
            </MiSub>
            <Mi icon="†" label={t('m.footnote')} close={close} onClick={tool('tFn')} />
          </Mb>

          <Mb title={t('menu.view')} open={open} setOpen={setOpen} width={220}>
            <MiSub label={t('m.viewMode')}>
              <Mi check={viewMode === 'edit'} label={t('m.vmEdit')} close={close} onClick={() => setViewMode('edit')} />
              <Mi check={viewMode === 'split'} disabled={compact} label={t('m.vmSplit')} close={close} onClick={() => setViewMode('split')} />
              <Mi check={viewMode === 'preview'} label={t('m.vmPreview')} close={close} onClick={() => setViewMode('preview')} />
            </MiSub>
            <Mi check={syncScroll} label={t('m.syncScroll')} close={close} onClick={() => setSyncScroll(!syncScroll)} />
            <Mi check={typewriter} label={t('m.typewriter')} close={close} onClick={() => setTypewriter(!typewriter)} />
            <Mi check={zen} label={t('m.zen')} hint="Esc" close={close} onClick={() => setZen(!zen)} />
            <MSep />
            <MiSub label={t('m.theme')}>
              {THEME_IDS.map(id => (
                <Mi key={id} check={theme === id} label={t('theme.' + id)} hint={<span className="mini-sw" data-pick={id}></span>} close={close} onClick={() => setTheme(id)} />
              ))}
            </MiSub>
            <MSep />
            <MiSub label={t('m.zoom')}>
              <Mi icon="＋" label={t('m.zoomIn')} close={close} onClick={() => onZoom(0.1)} />
              <Mi icon="－" label={t('m.zoomOut')} close={close} onClick={() => onZoom(-0.1)} />
              <Mi label={t('m.zoomReset', { n: Math.round(zoom * 100) })} close={close} onClick={() => onZoom(1 - zoom)} />
            </MiSub>
          </Mb>

          <Mb title="TeX" open={open} setOpen={setOpen} width={248} tour="menu-tex">
            {engineOk ? engines.map(en => (
              <Mi key={en} check={engine === en} label={engineLabel(en)} close={close} onClick={() => setEngine(en)} />
            )) : <div className="mi-note">{t('m.noEngine')}</div>}
            <MSep />
            <Mi label={compiling ? t('m.compiling') : t('m.compileDoc')}
              disabled={!engineOk || compiling} close={close} onClick={onCompile} />
            <Mi label={t('m.dlCompiled')} disabled={!downloadPdf} close={close} onClick={downloadPdf} />
            <MSep />
            <div className="mi-note">{t('m.engineNote')}</div>
          </Mb>

          <Mb title={'AI' + (channelCount ? '' : ' ·')} open={open} setOpen={setOpen} width={220} tour="menu-ai">
            <Mi label={t('m.aiAssistant')} close={close} onClick={onOpenChat} />
            <Mi label={t('m.aiSettings')} close={close} onClick={onOpenSettings} />
            <MSep />
            <Mi label={t('m.aiFix')} disabled={!channelCount} close={close} onClick={onAiFix} />
            {!channelCount && <div className="mi-note">{t('m.noChannel')}</div>}
          </Mb>

          <Mb title={t('menu.help')} open={open} setOpen={setOpen} width={214} tour="menu-help">
            <Mi label={t('welcome.reopen')} close={close} onClick={() => onHelp('welcome')} />
            <Mi label={t('m.tour')} close={close} onClick={() => onHelp('tour')} />
            <Mi label={t('m.keys')} close={close} onClick={() => onHelp('keys')} />
            <Mi label={t('m.feedback')} close={close} onClick={() => onHelp('feedback')} />
            <MSep />
            <Mi label={t('m.about')} close={close} onClick={() => onHelp('about')} />
          </Mb>
        </nav>

        <div className="mb-right" data-tour="rightbar">
          <LangSwitch lang={lang} setLang={setLang} />
          {/* 切换要 reload：main.jsx 在加载时决定渲染哪棵树，且 reload 才会触发脏标签的 beforeunload 守卫 */}
          <button
            className="btn sm"
            aria-label={t('m.mobileView')}
            title={t('m.mobileViewTip')}
            onClick={() => { window.location.hash = '#/m'; window.location.reload(); }}
          >
            {t('m.mobileView')}
          </button>
          <div className="view-switch" title={t('vm.tip')}>
            {[['edit', '✎', t('vm.edit')], ['split', '▤▤', t('vm.split')], ['preview', '▢', t('vm.preview')]].map(([m, ic, ti]) => (
              <button key={m} className={'btn sm' + (viewMode === m ? ' on' : '')} aria-label={ti} aria-pressed={viewMode === m} disabled={compact && m === 'split'} title={ti} onClick={() => setViewMode(m)}>{compact ? ti : ic}</button>
            ))}
          </div>
          {texDocument && <button className="btn sm primary" disabled={!engineOk} title={compiling ? t('prev.cancelTip') : 'Ctrl+Enter'} onClick={compiling ? onCancelCompile : onCompile}>{t(compiling ? 'prev.cancel' : 'prev.compile')}</button>}
          {(downloadPdf || !texDocument) && <button className="btn sm" disabled={!downloadPdf && !actions.pdfAvailable} onClick={downloadPdf || actions.exportPdf}>{t(downloadPdf ? 'm.dlCompiled' : 'm.exportPdf')}</button>}
        </div>
      </div>

      {latexOk && <QuickTools actions={actions} onOpenChat={onOpenChat} markdown={markdown} documentKey={documentKey} labels={labels} />}
    </header>
  );
}

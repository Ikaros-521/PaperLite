import { useEffect, useRef } from 'react';
import { exportSvg, exportPng } from '../exporter.js';
import { useT } from '../useI18n.js';

let mermaidInited = false;
let mermaidSeq = 0;

/* 预览面板：HTML 注入 + Mermaid 懒加载 + 图工具条 + 节点选中联动 + 编译栏 */
export default function PreviewPane({
  result, selection, onSelectNode, onScrollRatio, zoom, onZoom,
  panelOpen, onTogglePanel, syncScroll, onSyncToggle,
  engines, engine, setEngine, compiling, onCompile, hasCompile,
  onOpenSettings, onOpenChat
}) {
  const t = useT();
  const scrollRef = useRef(null);
  const paperRef = useRef(null);

  useEffect(() => {
    const paper = paperRef.current;
    if (!paper) return;
    const blocks = paper.querySelectorAll('.mermaid-block[data-code]:not([data-done])');
    if (!blocks.length) return;
    let cancelled = false;
    import('mermaid').then(mod => {
      if (cancelled) return;
      const mermaid = mod.default;
      if (!mermaidInited) {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', htmlLabels: false, fontFamily: 'Georgia, "Noto Serif SC", serif' });
        mermaidInited = true;
      }
      blocks.forEach(b => {
        b.setAttribute('data-done', '1');
        const code = decodeURIComponent(b.getAttribute('data-code'));
        mermaid.render('mmd-' + (++mermaidSeq), code).then(r => {
          b.innerHTML = r.svg;
          const svg = b.querySelector('svg');
          if (svg) { svg.style.maxWidth = '100%'; svg.removeAttribute('height'); }
        }).catch(err => {
          b.innerHTML = '<div class="render-error">' + t('prev.mermaidErr') + ' ' + String(err && err.message || err).slice(0, 160) + '</div>';
        });
      });
    });
    return () => { cancelled = true; };
  }, [result]);

  useEffect(() => {
    const paper = paperRef.current;
    if (!paper) return;
    paper.querySelectorAll('.diagram').forEach(d => {
      if (d.querySelector('.dgrid-tools')) return;
      const bar = document.createElement('div');
      bar.className = 'dgrid-tools';
      const mk = (label, fn) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.addEventListener('click', e => {
          e.stopPropagation();
          const svg = d.querySelector('svg');
          if (svg) fn(svg, d);
        });
        return b;
      };
      bar.appendChild(mk('SVG', svg => exportSvg(svg, 'figure.svg')));
      bar.appendChild(mk('PNG', svg => exportPng(svg, 'figure.png', 2)));
      d.appendChild(bar);
    });
  }, [result]);

  useEffect(() => {
    const paper = paperRef.current;
    if (!paper) return;
    paper.querySelectorAll('.tk-node.selected, .tk-label.selected').forEach(el => el.classList.remove('selected'));
    if (!selection || !selection.sel || selection.sel.type !== 'node') return;
    paper.querySelectorAll('.tk-node[data-sidx="' + selection.sel.sidx + '"]').forEach(el => {
      el.classList.add('selected');
      const svg = el.closest && el.closest('svg');
      if (svg) svg.classList.add('has-sel');
    });
  }, [selection, result]);

  const handleClick = (e) => {
    const g = e.target && e.target.closest ? e.target.closest('.tk-node, .tk-label') : null;
    if (!g) return;
    const sidx = g.getAttribute('data-sidx');
    const host = g.closest('.diagram');
    const did = host ? +(host.getAttribute('data-did') || 0) : 0;
    if (sidx !== null) onSelectNode(did, +sidx);
  };

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    onScrollRatio(el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight), 'preview');
  };

  if (!result) return <section id="previewPane"><div id="previewScroll" /></section>;

  return (
    <section id="previewPane">
      <div id="previewBar">
        <span className="pb-title">{t('prev.title')}</span>
        {result.isMd && <span className="pb-chip">Markdown</span>}
        <label className="pb-toggle" title={t('prev.syncTip')}>
          <input type="checkbox" checked={syncScroll} onChange={e => onSyncToggle(e.target.checked)} /> {t('prev.sync')}
        </label>

        {(engines && engines.length) ? (
          <span className="pb-compile" title={t('prev.compileTip')}>
            <select value={engine} onChange={e => setEngine(e.target.value)}>
              {engines.map(en => <option key={en} value={en}>{en}</option>)}
            </select>
            <button className={'btn sm' + (compiling ? ' busy' : '')} disabled={compiling} onClick={onCompile}>
              {compiling ? t('prev.compiling') : t('prev.compile')}
            </button>
          </span>
        ) : null}

        <span className="pb-spacer"></span>
        <button className="btn sm" title={t('prev.settingsTip')} onClick={onOpenSettings}>{'⚙︎'}</button>
        <button className={'btn sm' + (onTogglePanel ? '' : '')} title={t('prev.styleTip')} onClick={onTogglePanel}>{t('prev.style')}</button>
        <button className="btn sm" title={t('prev.chatTip')} onClick={onOpenChat}>AI</button>
        <span className="pb-zoom">
          <button className="btn sm" onClick={() => onZoom(-0.1)}>−</button>
          <span>{Math.round(zoom * 100)}%</span>
          <button className="btn sm" onClick={() => onZoom(0.1)}>＋</button>
        </span>
      </div>
      <div id="previewScroll" ref={scrollRef} onScroll={handleScroll}>
        <div id="preview" onClick={handleClick}>
          <div
            id="paper"
            ref={paperRef}
            className={'paper' + (result.isMd ? ' md-view' : '') + (result.meta.twocolumn ? ' twocolumn' : '') + (result.meta.ctex ? ' ctex' : '')}
            style={{ zoom }}
            dangerouslySetInnerHTML={{ __html: result.html }}
          />
        </div>
      </div>
    </section>
  );
}

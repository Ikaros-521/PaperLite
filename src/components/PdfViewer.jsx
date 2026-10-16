import { useEffect, useRef, useState } from 'react';
import { loadPdfLibrary, pdfOptions } from '../pdf.js';

function PdfPage({ pdf, number, scale, width, height, root }) {
  const host = useRef(null), canvas = useRef(null), text = useRef(null);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      const entry = entries[0];
      setVisible(entry.isIntersecting);
    }, { root: root.current, rootMargin: '200px 0px' });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [number, root]);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false, render, textRender;
    setError('');
    pdf.getPage(number).then(async page => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const target = canvas.current;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      target.width = Math.ceil(viewport.width * ratio);
      target.height = Math.ceil(viewport.height * ratio);
      render = page.render({ canvasContext: target.getContext('2d'), viewport,
        transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
      const lib = await loadPdfLibrary();
      if (cancelled) return;
      text.current.replaceChildren();
      textRender = new lib.TextLayer({ textContentSource: page.streamTextContent(),
        container: text.current, viewport });
      await Promise.all([render.promise, textRender.render()]);
    }).catch(err => {
      if (!cancelled && err.name !== 'RenderingCancelledException') setError(err.message);
    });
    return () => { cancelled = true; render?.cancel(); textRender?.cancel(); };
  }, [pdf, number, scale, visible]);
  return <div ref={host} className="pdf-page" data-page={number}
    style={{ width: width * scale, height: height * scale, '--total-scale-factor': scale }}>
    <canvas ref={canvas} aria-label={`PDF · ${number}`} />
    <div ref={text} className="pdf-text-layer" />
    {error && <div role="alert" className="pdf-message">{error}</div>}
  </div>;
}

export default function PdfViewer({ url, title = 'PDF', lang = 'zh', onDownload, onClose,
  onCompile, compiling, stale = false }) {
  const zh = lang === 'zh';
  const scroll = useRef(null);
  const [pdf, setPdf] = useState(null), [pages, setPages] = useState([]);
  const [error, setError] = useState(''), [current, setCurrent] = useState(1);
  const [zoom, setZoom] = useState('fit'), [available, setAvailable] = useState(700);
  useEffect(() => {
    let task, cancelled = false;
    setPdf(null); setPages([]); setError(''); setCurrent(1);
    loadPdfLibrary().then(async lib => {
      if (cancelled) return;
      task = lib.getDocument(pdfOptions({ url }));
      const doc = await task.promise;
      const sizes = [];
      for (let i = 1; i <= doc.numPages; i++) {
        if (cancelled) return;
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: 1 });
        sizes.push({ width: viewport.width, height: viewport.height });
      }
      if (!cancelled) { setPages(sizes); setPdf(doc); }
    }).catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; task?.destroy(); };
  }, [url]);
  useEffect(() => {
    const observer = new ResizeObserver(entries => setAvailable(entries[0].contentRect.width));
    observer.observe(scroll.current);
    return () => observer.disconnect();
  }, []);
  const scale = zoom === 'fit' ? Math.max(0.1, (available - 48) / (pages[0]?.width || 612)) : zoom;
  const jump = number => {
    const next = Math.max(1, Math.min(pages.length, Number(number) || 1));
    setCurrent(next);
    scroll.current?.querySelector(`[data-page="${next}"]`)?.scrollIntoView({ block: 'start' });
  };
  const trackScroll = () => {
    const container = scroll.current;
    const top = container.getBoundingClientRect().top;
    const nodes = [...container.querySelectorAll('[data-page]')];
    const page = nodes.find(node => node.getBoundingClientRect().bottom > top + 30);
    if (page) setCurrent(Number(page.dataset.page));
  };
  return <section id="previewPane" className="pdf-viewer">
    <div id="previewBar" className="pdf-toolbar">
      <span className="pb-title" title={title}>{title}</span>
      {stale && <span className="pdf-stale">{zh ? '源码已修改' : 'Source changed'}</span>}
      <span className="pb-spacer" />
      {onCompile && <button className="btn sm" disabled={compiling} onClick={onCompile}>
        {compiling ? (zh ? '编译中…' : 'Compiling…') : (zh ? '重新编译' : 'Recompile')}</button>}
      <button className="btn sm" onClick={onDownload}>{zh ? '下载' : 'Download'}</button>
      <button className="btn sm" onClick={() => window.open(url, '_blank', 'noopener')}>{zh ? '新窗口' : 'Open'}</button>
      {onClose && <button className="btn sm" onClick={onClose}>{zh ? '返回源码预览' : 'Source preview'}</button>}
    </div>
    <div className="pdf-controls">
      <button className="btn sm" aria-label={zh ? '上一页' : 'Previous page'} disabled={!pdf || current <= 1} onClick={() => jump(current - 1)}>‹</button>
      <input aria-label={zh ? '页码' : 'Page'} type="number" min="1" max={pages.length || 1} value={current}
        disabled={!pdf} onChange={e => jump(e.target.value)} />
      <span>/ {pages.length || '—'}</span>
      <button className="btn sm" aria-label={zh ? '下一页' : 'Next page'} disabled={!pdf || current >= pages.length} onClick={() => jump(current + 1)}>›</button>
      <span className="pb-spacer" />
      <button className="btn sm" disabled={!pdf} aria-label={zh ? '缩小' : 'Zoom out'} onClick={() => setZoom(Math.max(0.25, scale - 0.15))}>−</button>
      <span>{Math.round(scale * 100)}%</span>
      <button className="btn sm" disabled={!pdf} aria-label={zh ? '放大' : 'Zoom in'} onClick={() => setZoom(Math.min(4, scale + 0.15))}>＋</button>
      <button className={'btn sm' + (zoom === 'fit' ? ' on' : '')} onClick={() => setZoom('fit')}>{zh ? '适合宽度' : 'Fit width'}</button>
    </div>
    <div className="pdf-scroll" ref={scroll} onScroll={trackScroll} tabIndex={0}>
      {error ? <div role="alert" className="pdf-message">{zh ? 'PDF 加载失败：' : 'PDF failed to load: '}{error}</div>
        : !pdf ? <div role="status" className="pdf-message">{zh ? '正在加载 PDF…' : 'Loading PDF…'}</div>
        : pages.map((size, i) => <PdfPage key={url + i} pdf={pdf} number={i + 1} scale={scale}
          {...size} root={scroll} />)}
    </div>
  </section>;
}

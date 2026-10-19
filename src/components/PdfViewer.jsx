import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { loadPdfLibrary, pdfOptions } from '../pdf.js';
import { buildPageIndex, findTextInDoc } from '../pdfSync.js';

function PdfPage({ pdf, number, scale, width, height, root, flash, onBackSync }) {
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
    if (!visible) {
      // 离视口即释放位图：A4 页在 2x ratio 下约 6-8MB/页，长文档滚 50 页
      // 就是数百 MB，移动端直接 OOM。宽度归零即可释放，滚回来再重渲
      const target = canvas.current;
      if (target) { target.width = 0; target.height = 0; }
      return;
    }
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
    <div ref={text} className="pdf-text-layer"
      onDoubleClick={e => {
        if (!onBackSync) return;
        const span = e.target && e.target.closest ? e.target.closest('span') : null;
        const str = span && span.textContent;
        if (str && str.trim()) onBackSync(str);
      }} />
    {flash && <div className="pdf-sync-flash" aria-hidden="true"
      style={{ left: flash.x * scale, top: (height - flash.y) * scale }} />}
    {error && <div role="alert" className="pdf-message">{error}</div>}
  </div>;
}

/* Ctrl+点击编辑器（正向）与双击 PDF 文本（反向）的正反向跳转是「文本匹配近似定位」：
 * 引擎 wasm 不产 synctex，这里靠 pdf.js 抽取的页文本索引做归一化子串匹配（pdfSync.js）。 */
const PdfViewer = forwardRef(function PdfViewer({ url, title = 'PDF', lang = 'zh', onDownload, onClose,
  onCompile, compiling, stale = false, onBackSync }, ref) {
  const zh = lang === 'zh';
  const scroll = useRef(null);
  const [pdf, setPdf] = useState(null), [pages, setPages] = useState([]);
  const [error, setError] = useState(''), [current, setCurrent] = useState(1);
  const [zoom, setZoom] = useState('fit'), [available, setAvailable] = useState(700);
  const [spread, setSpread] = useState(false);
  // 每页文本索引（pdf.js getTextContent，PDF 坐标）+ 正向跳转的闪烁标记
  const indexesRef = useRef([]);
  const [flash, setFlash] = useState(null);
  useEffect(() => {
    let task, cancelled = false;
    setPdf(null); setPages([]); setError(''); setCurrent(1);
    indexesRef.current = []; setFlash(null);
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
      // 文本索引不阻塞首屏：后台逐页抽取，供正反向跳转匹配（超长文档只索引前 300 页）
      (async () => {
        const list = [];
        const max = Math.min(doc.numPages, 300);
        for (let i = 1; i <= max; i++) {
          if (cancelled) return;
          try {
            const page = await doc.getPage(i);
            const tc = await page.getTextContent();
            const items = (tc.items || [])
              .filter(it => it && typeof it.str === 'string' && it.transform)
              .map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0, h: it.height || 10 }));
            list.push(buildPageIndex(items, i));
          } catch (e) { /* 单页抽取失败跳过 */ }
        }
        if (!cancelled) indexesRef.current = list;
      })();
    }).catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; task?.destroy(); };
  }, [url]);
  useEffect(() => {
    const observer = new ResizeObserver(entries => setAvailable(entries[0].contentRect.width));
    observer.observe(scroll.current);
    return () => observer.disconnect();
  }, []);
  // Ctrl+滚轮缩放：wheel 在 React 里是被动监听，preventDefault 必须走原生非被动监听
  const scaleRef = useRef(1);
  useEffect(() => {
    const el = scroll.current;
    if (!el) return undefined;
    const onWheel = e => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(z => {
        const base = z === 'fit' ? scaleRef.current : z;
        return Math.min(4, Math.max(0.25, Math.round(base * (e.deltaY < 0 ? 1.1 : 1 / 1.1) * 100) / 100));
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  // 双页视图按两页宽算适配缩放（+16px 列间距）
  const fitWidth = spread ? (pages[0]?.width || 612) * 2 + 16 : (pages[0]?.width || 612);
  const scale = zoom === 'fit' ? Math.max(0.1, (available - 48) / fitWidth) : zoom;
  scaleRef.current = scale;
  const jump = number => {
    const next = Math.max(1, Math.min(pages.length, Number(number) || 1));
    setCurrent(next);
    scroll.current?.querySelector(`[data-page="${next}"]`)?.scrollIntoView({ block: 'start' });
  };
  // 滚动同步页码：rAF 节流 + 页元素缓存 + 二分定位。逐 scroll 事件全量
  // querySelectorAll 且线性扫每页 getBoundingClientRect（强制 layout），长文档
  // 上可感知；页按序垂直排列、bottom 单调，二分只要 O(log n) 次测量
  const pageNodesRef = useRef([]);
  const trackPending = useRef(0);
  const trackScroll = () => {
    if (trackPending.current) return;
    trackPending.current = requestAnimationFrame(() => {
      trackPending.current = 0;
      const container = scroll.current;
      if (!container) return;
      const top = container.getBoundingClientRect().top;
      let nodes = pageNodesRef.current;
      if (!nodes.length || nodes.length !== pages.length || !nodes[0]?.isConnected) {
        nodes = pageNodesRef.current = [...container.querySelectorAll('[data-page]')];
      }
      let lo = 0, hi = nodes.length - 1, page = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (nodes[mid].getBoundingClientRect().bottom > top + 30) { page = nodes[mid]; hi = mid - 1; }
        else lo = mid + 1;
      }
      if (page) setCurrent(Number(page.dataset.page));
    });
  };
  // 正向跳转入口：文本匹配命中 → 翻页 + 定位闪烁；找不到返回 false 交给调用方提示
  useImperativeHandle(ref, () => ({
    jumpToText(query) {
      const hit = findTextInDoc(indexesRef.current, query, current);
      if (!hit) return false;
      jump(hit.page);
      setFlash({ page: hit.page, x: hit.x, y: hit.y });
      return true;
    },
  }), [current]);
  useEffect(() => {
    if (!flash) return undefined;
    const timer = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(timer);
  }, [flash]);
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
        disabled={!pdf}
        // 失焦/回车才提交：逐键 onChange 输 "12" 会先跳第 1 页（空串被 ||1 吃掉）
        onChange={e => { if (e.target.value !== '') jump(e.target.value); }}
        onBlur={e => jump(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); jump(e.target.value); e.target.blur(); } }} />
      <span>/ {pages.length || '—'}</span>
      <button className="btn sm" aria-label={zh ? '下一页' : 'Next page'} disabled={!pdf || current >= pages.length} onClick={() => jump(current + 1)}>›</button>
      <span className="pb-spacer" />
      <button className="btn sm" disabled={!pdf} aria-label={zh ? '缩小' : 'Zoom out'} onClick={() => setZoom(Math.max(0.25, scale - 0.15))}>−</button>
      <span>{Math.round(scale * 100)}%</span>
      <button className="btn sm" disabled={!pdf} aria-label={zh ? '放大' : 'Zoom in'} onClick={() => setZoom(Math.min(4, scale + 0.15))}>＋</button>
      <button className={'btn sm' + (zoom === 'fit' ? ' on' : '')} onClick={() => setZoom('fit')}>{zh ? '适合宽度' : 'Fit width'}</button>
      <button className={'btn sm' + (spread ? ' on' : '')} disabled={!pdf || pages.length < 2}
        title={zh ? '双页对开（Ctrl+滚轮缩放）' : 'Two-page spread (Ctrl+scroll to zoom)'}
        aria-pressed={spread} onClick={() => setSpread(s => !s)}>{zh ? '双页' : '2-up'}</button>
    </div>
    <div className="pdf-scroll" ref={scroll} onScroll={trackScroll} tabIndex={0}>
      {error ? <div role="alert" className="pdf-message">{zh ? 'PDF 加载失败：' : 'PDF failed to load: '}{error}</div>
        : !pdf ? <div role="status" className="pdf-message">{zh ? '正在加载 PDF…' : 'Loading PDF…'}</div>
        : spread
          ? Array.from({ length: Math.ceil(pages.length / 2) }, (_, r) => (
            <div className="pdf-spread-row" key={url + 'row' + r}>
              <PdfPage key={url + (r * 2)} pdf={pdf} number={r * 2 + 1} scale={scale} {...pages[r * 2]} root={scroll}
                flash={flash && flash.page === r * 2 + 1 ? flash : null} onBackSync={onBackSync} />
              {pages[r * 2 + 1] && <PdfPage key={url + (r * 2 + 1)} pdf={pdf} number={r * 2 + 2} scale={scale} {...pages[r * 2 + 1]} root={scroll}
                flash={flash && flash.page === r * 2 + 2 ? flash : null} onBackSync={onBackSync} />}
            </div>
          ))
          : pages.map((size, i) => <PdfPage key={url + i} pdf={pdf} number={i + 1} scale={scale}
            {...size} root={scroll} flash={flash && flash.page === i + 1 ? flash : null} onBackSync={onBackSync} />)}
    </div>
  </section>;
});

export default PdfViewer;

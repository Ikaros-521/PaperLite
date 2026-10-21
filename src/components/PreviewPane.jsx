import { useEffect, useRef, useState } from 'react';
import { exportSvg, exportPng } from '../exporter.js';
import { useT } from '../useI18n.js';
import { readMermaidGeoms } from '../mermaidMutations.js';
import { loadPdfLibrary, pdfOptions } from '../pdf.js';

let mermaidInited = false;
let mermaidSeq = 0;
// mermaid 产物缓存的上限。两张闸都要：条数管住「一堆小图」，字节管住「几张巨图」——
// 一张复杂流程图能到几百 KB。超上限时按插入顺序淘汰最老的（不是整张清空：
// 实测 60 张图的文档一旦清空重来，每个打字节拍都要把超出条数的那些重新排版，
// 等于把这次优化原地抹平）。淘汰后最老的那些图会重排一次，代价可控。
const MAX_MMD_CACHE = 256;
const MAX_MMD_BYTES = 12 * 1024 * 1024;

// 错误消息要进 innerHTML，先转义（mermaid 报错常引用出错的图源码行）
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* 预览面板：HTML 注入 + Mermaid 懒加载 + 图工具条 + 节点选中联动 + 编译栏 */
export default function PreviewPane({
  result, selection, onSelectNode, onSelMermaid, onSelectTable, onJumpOff, onScrollRatio, zoom, onZoom,
  panelOpen, onTogglePanel, syncScroll, onSyncToggle,
  engines, engine, setEngine, compiling, onCompile, onCancelCompile, hasCompile, builtinStatus,
  onOpenSettings, onOpenChat, assetDir, assetTabs = []
}) {
  const t = useT();
  const scrollRef = useRef(null);
  const paperRef = useRef(null);
  const [mmdTick, setMmdTick] = useState(0); // Mermaid 异步渲染完成后自增，驱动选中态重放
  const [noteOpen, setNoteOpen] = useState(false);

  // 图片解析结果缓存：键为「图片路径列表 + 资产文件签名」。打字会让 result 每拍
  // 重渲（innerHTML 换掉全部 <img>），不缓存的话每键都重读磁盘重造 blob——
  // 签名不变时复用上次的 URL；资产真的变了（重传/换目录）才重新解析
  const imgCacheRef = useRef(null);
  // Mermaid 的 SVG 按「块序号 + 图源码」缓存（同一份源码在不同块里要各拿一个元素 id，
  // 所以键里必须带序号），命中就跳过 dagre 排版
  const mmdCacheRef = useRef({ map: new Map(), bytes: 0 });
  useEffect(() => {
    let cancelled = false;
    const images = paperRef.current?.querySelectorAll('img.includegraphics') || [];
    const original_ = img => {
      const o = img.getAttribute('data-graphics-source') || img.getAttribute('src') || '';
      return /^(?:[a-z]+:|\/\/)/i.test(o) ? null : o;
    };
    const sig = JSON.stringify([
      [...images].map(original_),
      assetTabs.map(t => [t.name, t.uploadedFile ? String(t.uploadedFile.lastModified) + ':' + t.uploadedFile.size : '']),
    ]);
    const cache = imgCacheRef.current;
    if (cache && cache.sig === sig && cache.done) {
      // 复用：innerHTML 换新了 <img> 节点，src 还得重新指到仍有效的 URL 上；
      // 路径标记也要补，否则下一轮 effect 会把 blob: 当外部 scheme 跳过
      for (const img of images) {
        const o = original_(img); const u = o && cache.urls.get(o);
        if (u) { img.setAttribute('data-graphics-source', o); img.src = u; }
      }
      return undefined;
    }
    // 换一批资产：先释放上一轮的 blob 与 pdf 文档
    if (cache) { cache.urls.forEach(u => { if (u.startsWith('blob:')) URL.revokeObjectURL(u); }); cache.tasks.forEach(task => task.destroy()); }
    const urls = new Map(), tasks = [], pending = [], byName = new Map();
    imgCacheRef.current = { sig, urls, tasks, done: false };
    const resolve = async name => {
      const parts = name.replace(/\\/g, '/').replace(/^\.\//, '').split('/');
      if (parts.some(p => !p || p === '..')) return null;
      if (assetDir) {
        let dir = assetDir;
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
        return (await dir.getFileHandle(parts.at(-1))).getFile();
      }
      return assetTabs.find(tab => tab.name === name)?.uploadedFile || null;
    };
    // 一个「唯一文件名」一趟解析：旧写法按 <img> 逐个起活，N 个相同的
    // \includegraphics{a.pdf} 就是 N 趟 pdf.js 解析 + N 次 toDataURL，
    // 而它们要的本来就是同一张图
    const build = original => (async () => {
      let file;
      const names = /\.[a-z\d]+$/i.test(original) ? [original]
        : [original, ...['pdf', 'png', 'jpg', 'jpeg'].map(ext => original + '.' + ext)];
      for (const name of names) {
        try { file = await resolve(name); } catch { /* Try next graphics extension. */ }
        if (file) break;
      }
      if (!file) return null;
      if (/\.pdf$/i.test(file.name)) {
        const lib = await loadPdfLibrary();
        if (cancelled) return null;
        const task = lib.getDocument(pdfOptions({ data: new Uint8Array(await file.arrayBuffer()) }));
        // 本轮已被下一轮取代：这一份既不进 tasks（下一轮只会回收它自己那份），也没有
        // 人再替它 destroy —— 就地拆掉，否则每键都漏一个 pdf.js worker
        if (cancelled) { task.destroy(); return null; }
        tasks.push(task);
        const doc = await task.promise, page = await doc.getPage(1);
        if (cancelled) return null;
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(2, 1400 / base.width) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        return canvas.toDataURL('image/png');
      }
      const url = URL.createObjectURL(file);
      // 同上：本轮已作废，urls 归属的缓存对象刚被下一轮回收过，再记进去就没人再 revoke
      if (cancelled) { URL.revokeObjectURL(url); return null; }
      return url;
    })().then(u => { if (u && !cancelled) urls.set(original, u); return u; });
    for (const img of images) {
      const original = original_(img);
      if (!original) continue;
      img.setAttribute('data-graphics-source', original);
      let job = byName.get(original);
      if (!job) { job = build(original); byName.set(original, job); }
      // 失败信息仍按 <img> 挂：同名图片各留各的悬浮提示
      job.then(u => { if (u && !cancelled) img.src = u; })
        .catch(error => { if (!cancelled) img.title = original + ': ' + error.message; });
    }
    byName.forEach(job => pending.push(job.catch(() => null)));
    // done 只看「本轮解析是否全部落定」，不受 cancelled 影响：打字重渲会先 cleanup
    // 旧轮（cancelled=true），若据此不置 done，下一轮同签名仍会重读磁盘——缓存失效。
    // 以 sig 匹配防止被更早一轮的迟到回执误标。
    Promise.all(pending).then(() => { const c = imgCacheRef.current; if (c && c.sig === sig) c.done = true; });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, assetDir, assetTabs]);

  // 卸载兜底：缓存里的 blob URL 与 pdf 文档此时不再有人持有
  useEffect(() => () => {
    const cache = imgCacheRef.current;
    if (!cache) return;
    cache.urls.forEach(u => { if (u.startsWith('blob:')) URL.revokeObjectURL(u); });
    cache.tasks.forEach(task => task.destroy());
  }, []);

  // 整图排版（dagre）是预览里最贵的一步。原来每次 result 变化——也就是每个打字节拍——
  // 都把文档里所有 mermaid 块重排一遍；而且每张图 resolve 各自 setMmdTick 一次，
  // 那两个依赖 [result, mmdTick] 的全量重放效应就成了 O(块数²)。
  // 现在按「块序号 + 源码」缓存 SVG：源码没变的块直接把上次那串贴回去，只有变过的块进
  // dagre；mmdTick 等这一批全部落定后只推一次。全命中时不必推——那两个效应本来就随
  // result 重跑（依赖数组里加 t 会每次渲染都重跑这个效应，别动它）。
  useEffect(() => {
    const paper = paperRef.current;
    if (!paper) return;
    const blocks = Array.from(paper.querySelectorAll('.mermaid-block[data-code]'));
    if (!blocks.length) return;
    const store = mmdCacheRef.current;
    const putSvg = (key, svg) => {
      store.map.set(key, svg);
      store.bytes += svg.length;
      // Map 保持插入顺序，从头淘汰就是「最先进来的先出去」
      while ((store.map.size > MAX_MMD_CACHE || store.bytes > MAX_MMD_BYTES) && store.map.size) {
        const oldest = store.map.keys().next().value;
        store.bytes -= store.map.get(oldest).length;
        store.map.delete(oldest);
      }
    };
    const errHtml = (msg) => '<div class="render-error">' + t('prev.mermaidErr') + ' ' + escHtml(String(msg || '').slice(0, 160)) + '</div>';
    const paint = (b, svg) => {
      b.innerHTML = svg;
      const el = b.querySelector('svg');
      if (el) { el.style.maxWidth = '100%'; el.removeAttribute('height'); }
    };
    const todo = [];
    blocks.forEach((b, i) => {
      b.setAttribute('data-done', '1');
      let code;
      // 畸形百分号只是这一块的问题：抛出去会连带整批（包括已经贴好的）一起停摆
      try { code = decodeURIComponent(b.getAttribute('data-code') || ''); }
      catch (e) { b.innerHTML = errHtml('data-code'); return; }
      const key = i + '\n' + code;
      const hit = store.map.get(key);
      if (hit !== undefined) paint(b, hit);
      else todo.push({ b, code, key });
    });
    if (!todo.length) return;
    let cancelled = false;
    import('mermaid').then(mod => {
      if (cancelled) return;
      const mermaid = mod.default;
      if (!mermaidInited) {
        // strict：SVG 输出经 DOMPurify 清洗，图源码里的 click/href 指令不再原样放行。
        // secure 还得自己补：mermaid 10 默认只护 secure/securityLevel/startOnLoad/
        // maxTextSize/maxEdges，而文档自带的 %%{init}%% 指令能改 dompurifyConfig 与
        // htmlLabels——等于让被渲染的那份文稿自己配置消毒器，而 SVG 是 innerHTML 进页面的。
        mermaid.initialize({
          startOnLoad: false, securityLevel: 'strict', htmlLabels: false,
          fontFamily: 'Georgia, "Noto Serif SC", serif',
          secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'dompurifyConfig', 'htmlLabels'],
        });
        mermaidInited = true;
      }
      let pending = todo.length;
      const settle = () => {
        pending--;
        // 一批只推一次：选中高亮与自定义布局要在 innerHTML 换掉后重放，但重放是整篇扫的，
        // 每张图各推一次就是把 O(N) 的扫描做成 O(N²)
        if (!cancelled && pending === 0) setMmdTick(x => x + 1);
      };
      todo.forEach(({ b, code, key }) => {
        mermaid.render('mmd-' + (++mermaidSeq), code).then(r => {
          if (cancelled) return;
          putSvg(key, r.svg);
          paint(b, r.svg);
          settle();
        }).catch(err => {
          if (cancelled) return;
          b.innerHTML = errHtml(err && err.message || err);
          settle();
        });
      });
    }).catch(err => {
      // mermaid 是个几百 KB 的动态 chunk，网络断了或磁盘上那份没了的时候不能让预览
      // 只剩一堆「还在转圈」的空块，也不能留一条没人接的 rejection
      if (cancelled) return;
      blocks.forEach(b => { if (!b.querySelector('svg')) b.innerHTML = errHtml(err && err.message || err); });
      setMmdTick(x => x + 1);
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
    // 表格的可视化编辑入口：悬浮在表格上方出现「✎」，点开 TablePanel（不占用表格点击——
    // 单元格点击仍走 data-off 回跳源码行）
    paper.querySelectorAll('table.tabular[data-tid]').forEach(tbl => {
      if (tbl.nextElementSibling && tbl.nextElementSibling.classList.contains('tbl-tools')) return;
      const bar = document.createElement('div');
      bar.className = 'tbl-tools';
      const b = document.createElement('button');
      b.textContent = '✎';
      b.title = t('tb.openTip');
      b.addEventListener('click', e => {
        e.stopPropagation();
        if (onSelectTable) onSelectTable(+tbl.getAttribute('data-tid'));
      });
      bar.appendChild(b);
      tbl.insertAdjacentElement('afterend', bar);
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

  // Mermaid 选中高亮（sel: {type:'mermaid', block, id}）；mmdTick：异步渲染完成后重放
  useEffect(() => {
    const paper = paperRef.current;
    if (!paper) return;
    paper.querySelectorAll('.mermaid-block g.node.selected').forEach(el => el.classList.remove('selected'));
    if (!selection || !selection.sel || selection.sel.type !== 'mermaid' || !selection.sel.id) return;
    const block = paper.querySelectorAll('.mermaid-block')[selection.sel.block];
    // id 来自 SVG 的 data-id，可能带引号：不 CSS.escape 就是选择器抛错、整块选中失效
    const gn = block && block.querySelector('g.node[data-id="' + CSS.escape(String(selection.sel.id)) + '"]');
    if (gn) gn.classList.add('selected');
  }, [selection, result, mmdTick]);

  // Mermaid 自定义布局重放：源码 %% pl <id> … %% 注释 → SVG transform / rect 尺寸。
  // 每次重新渲染（dagre 重算布局）后都要执行一遍。
  useEffect(() => {
    const paper = paperRef.current;
    if (!paper) return;
    paper.querySelectorAll('.mermaid-block[data-code]').forEach(b => {
      let code = '';
      try { code = decodeURIComponent(b.getAttribute('data-code') || ''); } catch (e) { return; }
      applyMermaidGeomToSvg(b, code);
    });
  }, [result, mmdTick]);

  function rgbToHex(v) {
    const m = String(v).match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (!m) return null;
    const q = x => { const s = (+x).toString(16); return s.length < 2 ? '0' + s : s; };
    return '#' + q(m[1]) + q(m[2]) + q(m[3]);
  }
  function applyMermaidGeomToSvg(block, code) {
    let geoms;
    try { geoms = readMermaidGeoms(code); } catch (e) { return; }
    const ids = Object.keys(geoms);
    if (!ids.length) return;
    const svg = block.querySelector('svg');
    if (!svg) return;
    ids.forEach(id => {
      const gEl = svg.querySelector('g.node[data-id="' + id + '"]');
      if (!gEl) return;
      const gg = geoms[id];
      if (gg.x != null || gg.y != null || gg.s != null) {
        const curT = gEl.getAttribute('transform') || '';
        const mt = curT.match(/translate\(\s*([-\d.]+)[,\s]+([-\d.]+)\s*\)/);
        const ms = curT.match(/scale\(\s*([-\d.]+)\s*\)/);
        const x = gg.x != null ? gg.x : (mt ? +mt[1] : 0);
        const y = gg.y != null ? gg.y : (mt ? +mt[2] : 0);
        const s = gg.s != null ? gg.s : (ms ? +ms[1] : 1);
        gEl.setAttribute('transform', 'translate(' + x + ',' + y + ')' + (s !== 1 ? ' scale(' + s + ')' : ''));
      }
      if (gg.w != null || gg.h != null) {
        const shape = gEl.querySelector('rect');
        if (shape) {
          const w = gg.w != null ? gg.w : +shape.getAttribute('width');
          const h = gg.h != null ? gg.h : +shape.getAttribute('height');
          shape.setAttribute('width', w); shape.setAttribute('height', h);
          shape.setAttribute('x', -w / 2); shape.setAttribute('y', -h / 2);
        }
      }
    });
  }
  function mermaidNodeGeom(g) {
    const t = g.getAttribute('transform') || '';
    const mt = t.match(/translate\(\s*([-\d.]+)[,\s]+([-\d.]+)\s*\)/);
    const ms = t.match(/scale\(\s*([-\d.]+)\s*\)/);
    const shape = g.querySelector('rect');
    const w = shape ? +shape.getAttribute('width') : 0;
    const h = shape ? +shape.getAttribute('height') : 0;
    return {
      x: mt ? Math.round(+mt[1] * 10) / 10 : null,
      y: mt ? Math.round(+mt[2] * 10) / 10 : null,
      s: ms ? +ms[1] : 1,
      // 菱形等形状的 label 容器 rect 可能是 0 尺寸，视为无有效宽高
      w: w > 0 ? Math.round(w) : null,
      h: h > 0 ? Math.round(h) : null
    };
  }
  function mermaidNodeColors(g) {
    const shape = g.querySelector('rect, polygon, circle, ellipse');
    let fill = null, stroke = null, color = null;
    if (shape) {
      const cs = getComputedStyle(shape);
      fill = rgbToHex(cs.fill); stroke = rgbToHex(cs.stroke);
    }
    const label = g.querySelector('span, p, text');
    if (label) { const cs = getComputedStyle(label); color = rgbToHex(cs.color || cs.fill); }
    return { fill, stroke, color };
  }
  function mermaidBlockColors(block) {
    const shape = block.querySelector('g.node rect, g.node polygon');
    let fill = null, stroke = null;
    if (shape) { const cs = getComputedStyle(shape); fill = rgbToHex(cs.fill); stroke = rgbToHex(cs.stroke); }
    const label = block.querySelector('g.node span, g.node p, g.node text');
    const color = label ? rgbToHex(getComputedStyle(label).color || getComputedStyle(label).fill) : null;
    const edge = block.querySelector('path.flowchart-link');
    const line = edge ? rgbToHex(getComputedStyle(edge).stroke) : null;
    return { primary: fill, border: stroke, text: color, line };
  }
  function mermaidBlockIndex(block) {
    const paper = paperRef.current;
    if (!paper) return 0;
    return [...paper.querySelectorAll('.mermaid-block')].indexOf(block);
  }

  const handleClick = (e) => {
    const mmNode = e.target && e.target.closest ? e.target.closest('.mermaid-block svg g.node') : null;
    if (mmNode) {
      const block = mmNode.closest('.mermaid-block');
      if (onSelMermaid) onSelMermaid(mermaidBlockIndex(block), mmNode.getAttribute('data-id'),
        { ...mermaidNodeColors(mmNode), ...mermaidNodeGeom(mmNode) });
      return;
    }
    const mmBlock = e.target && e.target.closest ? e.target.closest('.mermaid-block') : null;
    if (mmBlock && e.target.closest('svg')) {
      if (onSelMermaid) onSelMermaid(mermaidBlockIndex(mmBlock), null, mermaidBlockColors(mmBlock));
      return;
    }
    const g = e.target && e.target.closest ? e.target.closest('.tk-node, .tk-label') : null;
    if (g) {
      const sidx = g.getAttribute('data-sidx');
      const host = g.closest('.diagram');
      const did = host ? +(host.getAttribute('data-did') || 0) : 0;
      // 与 onJumpOff/onSelMermaid 一样要先判存在：移动端复用这个组件时没有样式面板，
      // 直调未传的回调就是点一下图节点整片白屏（全仓没有 ErrorBoundary）
      if (sidx !== null && onSelectNode) onSelectNode(did, +sidx);
      return;
    }
    // 普通内容：就近找带 data-off 的块级元素，回跳编辑器对应源码行。
    // 图节点选中优先（上面已 return）；划选文本时不动（用户在复制）
    if (!onJumpOff) return;
    if (e.target.closest && e.target.closest('a, button, select, input, textarea')) return;
    const sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const offEl = e.target.closest ? e.target.closest('[data-off]') : null;
    if (offEl) onJumpOff(+offEl.getAttribute('data-off'));
  };

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    onScrollRatio(el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight), 'preview');
  };

  if (!result) return <section id="previewPane"><div id="previewScroll" /></section>;

  const statusKey = { loading: 'app.engineLoading', warming: 'app.engineWarming', error: 'app.engineError' }[builtinStatus];
  const builtinLabel = t('app.builtinEngine') + (statusKey ? ' · ' + t(statusKey) : '');
  // 排版语法解析结果（\documentclass[options]{class}）：类名 + 模式 + 栏数
  const layout = result.meta.layout || {};
  const layoutChip = layout.cls
    ? layout.cls + (layout.mode ? ' · ' + layout.mode : '') + ' · ' + t(layout.columns === 2 ? 'prev.cols2' : 'prev.cols1')
    : '';
  // 网页预览是子集近似：不点明，用户会拿它当最终排版（差异只写在 README 里没人看）

  return (
    <section id="previewPane">
      <div id="previewBar">
        <span className="pb-title">{t('prev.title')}</span>
        {result.isMd && <span className="pb-chip">Markdown</span>}
        {layoutChip && <span className="pb-chip" title={t('prev.layoutTip')}>{layoutChip}</span>}
        <label className="pb-toggle" title={t('prev.syncTip')}>
          <input type="checkbox" checked={syncScroll} onChange={e => onSyncToggle(e.target.checked)} /> {t('prev.sync')}
        </label>

        {(!result.isMd && engines && engines.length) ? (
          <span className="pb-compile" title={t('prev.compileTip')}>
            <select value={engine} onChange={e => setEngine(e.target.value)}>
              {engines.map(en => <option key={en} value={en}>{en === 'builtin' ? builtinLabel : en}</option>)}
            </select>
          </span>
        ) : null}

        <button className={'btn sm pb-note' + (noteOpen ? ' on' : '')} title={t('prev.approxTip')}
          aria-expanded={noteOpen} onClick={() => setNoteOpen(o => !o)}>{t('prev.approx')}</button>

        <span className="pb-spacer"></span>
        <button className={'btn sm' + (onTogglePanel ? '' : '')} title={t('prev.styleTip')} onClick={onTogglePanel}>{t('prev.style')}</button>
        <span className="pb-zoom">
          <button className="btn sm" onClick={() => onZoom(-0.1)}>−</button>
          <span>{Math.round(zoom * 100)}%</span>
          <button className="btn sm" onClick={() => onZoom(0.1)}>＋</button>
        </span>
      </div>
      {noteOpen && <div className="preview-note" role="note">
        <span>{t('prev.approxNote')}</span>
        <button className="btn sm" aria-label={t('prev.approxClose')} onClick={() => setNoteOpen(false)}>✕</button>
      </div>}
      <div id="previewScroll" ref={scrollRef} onScroll={handleScroll}>
        <div id="preview" onClick={handleClick}>
          <div
            id="paper"
            ref={paperRef}
            className={'paper' + (result.isMd ? ' md-view' : '') + (layout.classes ? ' ' + layout.classes : (result.meta.twocolumn ? ' twocolumn' : '') + (result.meta.ctex ? ' ctex' : ''))}
            style={{ zoom, ...layout.vars }}
            dangerouslySetInnerHTML={{ __html: result.html }}
          />
        </div>
      </div>
    </section>
  );
}

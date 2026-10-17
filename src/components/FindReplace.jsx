import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../useI18n.js';
import {
  buildPattern, collectMatches, lineStarts, toPositions, offsetFromPos,
  pickIndex, stepIndex, replacementText
} from '../findModel.js';

/* markText 每处都要建 DOM，比计数贵得多：高亮先到上限，计数仍然准确（VSCode 同思路）。 */
const MAX_MARKS = 1500;

function Flag({ on, glyph, title, onClick }) {
  return (
    <button type="button" className={'pl-find-flag' + (on ? ' on' : '')} aria-pressed={on}
      title={title} aria-label={title}
      onMouseDown={e => e.preventDefault()}
      onClick={onClick}>{glyph}</button>
  );
}

/* 编辑器内的查找/替换面板，对齐 VSCode 的布局与按键习惯：
 * Enter/F3 下一个、Shift+Enter/Shift+F3 上一个、Alt+Enter 全部替换、Esc 关闭，
 * 三个查找开关（区分大小写 / 全字匹配 / 正则）加替换侧的保留大小写。 */
export default function FindReplace({ cm, doc, open, request, onClose }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [repl, setRepl] = useState('');
  const [flags, setFlags] = useState({ matchCase: false, wholeWord: false, regex: false, preserveCase: false });
  const [showReplace, setShowReplace] = useState(false);
  const [matches, setMatches] = useState([]);
  const [index, setIndex] = useState(-1);
  const [invalid, setInvalid] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [notice, setNotice] = useState('');

  const findRef = useRef(null);
  const replRef = useRef(null);
  const marksRef = useRef([]);
  const anchorRef = useRef(null);   // 重算后从哪个 offset 起跳，边打字边搜时才不会乱跳
  const bulkRef = useRef(false);     // 一次替换多处时压掉逐次 change 重扫
  const wasOpenRef = useRef(false);
  const liveRef = useRef({});
  liveRef.current = { matches, index, query, repl, flags, doc, cm };

  const clearMarks = useCallback(() => {
    marksRef.current.forEach(m => { try { m.clear(); } catch (e) { /* 文档已回收 */ } });
    marksRef.current = [];
  }, []);

  /* 把编辑器带到某一处。只在用户主动跳转/改查询时调用——
   * 文档改动引发的重算若也移动光标，就会在用户打字时把插入点抢走。 */
  const revealMatch = useCallback((m) => {
    const e = liveRef.current.cm;
    e.scrollIntoView({ from: m.from, to: m.to }, 60);
    e.setCursor(m.to);
  }, []);

  const rescan = useCallback((anchor, reveal) => {
    const { query: q, flags: f, doc: d } = liveRef.current;
    const prev = anchorRef.current;      // 上一个匹配的位置，边打字边搜时用来原地续算
    anchorRef.current = null;
    const { pattern, error } = buildPattern(q, f);
    setInvalid(!!error);
    if (error || !pattern) { clearMarks(); setMatches([]); setIndex(-1); setTruncated(false); anchorRef.current = prev; return; }
    const text = d.getValue();
    const starts = lineStarts(text);
    const from = anchor != null ? anchor
      : prev != null ? prev
        : offsetFromPos(starts, d.getCursor('to'));
    const found = collectMatches(text, pattern);
    const withPos = toPositions(starts, found.matches);
    const i = pickIndex(withPos, from);
    // 没搜到时也要留住原位：把全词开关再关回去，应当回到原来那一处
    anchorRef.current = i >= 0 ? withPos[i].start : prev;
    setMatches(withPos); setIndex(i); setTruncated(found.truncated);
    if (reveal && i >= 0) revealMatch(withPos[i]);
  }, [clearMarks, revealMatch]);

  const applyEdits = useCallback((mutate, anchor) => {
    const e = liveRef.current.cm;
    bulkRef.current = true;
    try { e.operation(mutate); } finally { bulkRef.current = false; }
    rescan(anchor, true);
  }, [rescan]);

  // 重新打开或换文档：从编辑器光标处重新找（声明在重算之前，同一次提交里先清锚点）
  useEffect(() => { anchorRef.current = null; }, [open, doc]);

  // 查询、开关、文档切换：重算并把视图带到命中处。
  // 首次打开要先在这里把选区取走——reveal 会把光标落到命中处，之后再读就没有选区了。
  useEffect(() => {
    if (!open) return undefined;
    const fresh = !wasOpenRef.current;
    wasOpenRef.current = true;
    if (fresh) {
      const sel = doc.getSelection();
      if (request?.mode !== 'replace' && sel && !sel.includes('\n')) {
        anchorRef.current = null;
        setQuery(sel);
        return undefined;   // query 变化会再跑一次本 effect
      }
    }
    rescan(null, true);
    return undefined;
  }, [open, doc, query, flags, request, rescan]);

  // 面板开着时文档被编辑：只重算不动光标（批量替换自己会带一次 reveal）
  useEffect(() => {
    if (!open) return undefined;
    const onChange = () => { if (!bulkRef.current) rescan(); };
    doc.on('change', onChange);
    return () => { doc.off('change', onChange); };
  }, [open, doc, rescan]);

  // 高亮全部匹配：当前那一处用另一层颜色，便于看清跳到哪了；关闭或卸载时清干净
  useEffect(() => {
    if (!open) return undefined;
    const shown = Math.min(matches.length, MAX_MARKS);
    for (let i = 0; i < shown; i++) {
      try {
        marksRef.current.push(doc.markText(matches[i].from, matches[i].to,
          { className: i === index ? 'pl-find-cur' : 'pl-find-match' }));
      } catch (e) { /* 文档已切换 */ }
    }
    return clearMarks;
  }, [open, matches, index, doc, clearMarks]);

  const jump = useCallback((delta) => {
    const ms = liveRef.current.matches;
    if (!ms.length) return;
    const next = stepIndex(liveRef.current.index, delta, ms.length);
    anchorRef.current = ms[next].start;
    setIndex(next);
    revealMatch(ms[next]);
  }, []);

  const replaceCurrent = useCallback(() => {
    const { matches: ms, index: i, repl: r, flags: f, doc: d } = liveRef.current;
    const cur = ms[i];
    if (!cur) return;
    const text = d.getValue();
    const out = replacementText(r, cur, { preserveCase: f.preserveCase, before: text.slice(0, cur.start), after: text.slice(cur.end) });
    applyEdits(() => d.replaceRange(out, cur.from, cur.to), cur.start + out.length);
  }, [applyEdits]);

  const replaceAll = useCallback(() => {
    const { matches: ms, repl: r, flags: f, doc: d } = liveRef.current;
    if (!ms.length) return;
    const text = d.getValue();
    const out = ms.map(m => ({ m, rep: replacementText(r, m, { preserveCase: f.preserveCase, before: text.slice(0, m.start), after: text.slice(m.end) }) }));
    // 从后往前改写：靠后的位置先动，前面每个匹配的行列仍然有效
    applyEdits(() => { for (let k = out.length - 1; k >= 0; k--) d.replaceRange(out[k].rep, out[k].m.from, out[k].m.to); }, 0);
    setNotice(t('find.replaced', { n: out.length }));
  }, [applyEdits, t]);

  // Esc 与 F3 在捕获阶段处理，先于 CodeMirror 的 keymap
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
      else if (e.key === 'F3') { e.preventDefault(); jump(e.shiftKey ? -1 : 1); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, jump, onClose]);

  // 唤起时聚焦：Ctrl+Shift+F 顺带展开替换行，重复 Ctrl+F 全选输入框便于直接改词
  useEffect(() => {
    if (!open) { wasOpenRef.current = false; return undefined; }
    if (request?.mode === 'replace') setShowReplace(true);
    const raf = requestAnimationFrame(() => {
      const el = (request?.mode === 'replace' ? replRef.current : null) || findRef.current;
      if (el) { el.focus(); el.select(); }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, request]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), 2200);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!open) return null;

  const count = matches.length;
  const countText = invalid ? '!' : count ? (index + 1) + '/' + count + (truncated ? '+' : '') : (query ? '0/0' : '');
  const countTitle = invalid ? t('find.invalid')
    : notice ? notice
      : count ? t('find.count', { i: index + 1, n: count }) + (truncated ? ' ' + t('find.many', { n: MAX_MARKS }) : '')
        : (query ? t('find.none') : '');

  const onFindKey = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.altKey) { if (showReplace) replaceAll(); }
    else jump(e.shiftKey ? -1 : 1);
  };
  const onReplKey = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.altKey) replaceAll(); else replaceCurrent();
  };

  return (
    <div className="pl-find" role="search" aria-label={t('find.aria')}>
      <div className="pl-find-row">
        <button type="button" className="pl-find-caret" aria-expanded={showReplace}
          title={showReplace ? t('find.collapse') : t('find.expand')}
          onMouseDown={e => e.preventDefault()}
          onClick={() => setShowReplace(s => !s)}>{showReplace ? '▾' : '▸'}</button>
        <Flag on={flags.matchCase} glyph="Aa" title={t('find.case')} onClick={() => setFlags(f => ({ ...f, matchCase: !f.matchCase }))} />
        <Flag on={flags.wholeWord} glyph="ab" title={t('find.word')} onClick={() => setFlags(f => ({ ...f, wholeWord: !f.wholeWord }))} />
        <Flag on={flags.regex} glyph=".*" title={t('find.regex')} onClick={() => setFlags(f => ({ ...f, regex: !f.regex }))} />
        <input ref={findRef} type="text" spellCheck="false" autoComplete="off"
          className={'pl-find-input' + (invalid ? ' bad' : '')} value={query}
          placeholder={t('find.placeholder')} aria-label={t('find.placeholder')}
          onChange={e => setQuery(e.target.value)} onKeyDown={onFindKey} />
        <span className={'pl-find-count' + (invalid ? ' bad' : '') + (!count && query ? ' none' : '')} title={countTitle || undefined}>{countText}</span>
        <button type="button" className="pl-find-btn" disabled={!count} title={t('find.prev')} aria-label={t('find.prev')}
          onMouseDown={e => e.preventDefault()} onClick={() => jump(-1)}>↑</button>
        <button type="button" className="pl-find-btn" disabled={!count} title={t('find.next')} aria-label={t('find.next')}
          onMouseDown={e => e.preventDefault()} onClick={() => jump(1)}>↓</button>
        <button type="button" className="pl-find-btn close" title={t('find.close')} aria-label={t('find.close')}
          onMouseDown={e => e.preventDefault()} onClick={onClose}>×</button>
      </div>
      {showReplace && (
        <div className="pl-find-row">
          <span className="pl-find-pad" />
          <input ref={replRef} type="text" spellCheck="false" autoComplete="off" className="pl-find-input"
            value={repl} placeholder={t('find.replaceWith')} aria-label={t('find.replaceWith')}
            onChange={e => setRepl(e.target.value)} onKeyDown={onReplKey} />
          <Flag on={flags.preserveCase} glyph="Aa↔" title={t('find.preserve')} onClick={() => setFlags(f => ({ ...f, preserveCase: !f.preserveCase }))} />
          <button type="button" className="pl-find-btn" disabled={!count} title={t('find.replaceOne')} aria-label={t('find.replaceOne')}
            onMouseDown={e => e.preventDefault()} onClick={replaceCurrent}>⇄</button>
          <button type="button" className="pl-find-btn" disabled={!count} title={t('find.replaceAll')} aria-label={t('find.replaceAll')}
            onMouseDown={e => e.preventDefault()} onClick={replaceAll}>⇉</button>
        </div>
      )}
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../useI18n.js';

const SYMBOLS = [['α', '\\alpha'], ['β', '\\beta'], ['γ', '\\gamma'], ['δ', '\\delta'], ['θ', '\\theta'], ['λ', '\\lambda'], ['μ', '\\mu'], ['π', '\\pi'], ['σ', '\\sigma'], ['φ', '\\phi'], ['ω', '\\omega'], ['Ω', '\\Omega'], ['∞', '\\infty'], ['±', '\\pm'], ['×', '\\times'], ['≤', '\\leq'], ['≥', '\\geq'], ['≠', '\\neq'], ['∈', '\\in'], ['∑', '\\sum'], ['∫', '\\int'], ['→', '\\rightarrow'], ['∀', '\\forall'], ['∂', '\\partial']];

const PATHS = {
  tAi: 'M8 4h8v3M12 2v2M5 7h14v13H5zM2 11v5m20-5v5M8 11h1m6 0h1m-7 5h6',
  tUndo: 'M8 5 3 10l5 5M3 10h11a6 6 0 0 1 0 12',
  tRedo: 'm16 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12',
  tMathMenu: 'M4 3h16v18H4zM7 7h4m-2-2v4m5-2h3M7 13l4 4m0-4-4 4m7-3h3m-3 3h3',
  tLinkMenu: 'm9 15 6-6M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
  tComment: 'M3 4h18v13H9l-6 4zM7 8h10M7 12h7',
  tLabelMenu: 'M3 3h8l10 10-8 8L3 11zM7 7h.01',
  tRefMenu: 'M5 3h14v18H5zM8 3v18m3-12h5m-5 4h5',
  tImg: 'M3 4h18v16H3zM3 16l6-6 5 5 3-3 4 4M16 8h.01',
  tTableMenu: 'M3 4h18v16H3zM3 9h18M9 9v11m6-11v11',
  tListMenu: 'M4 6h.01M4 12h.01M4 18h.01M9 6h12M9 12h12M9 18h12'
};
function Icon({ id, fallback }) {
  return PATHS[id] ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={PATHS[id]} /></svg> : fallback;
}
function Popover({ label, children }) {
  const ref = useRef(null);
  const [position, setPosition] = useState({});
  useLayoutEffect(() => {
    const place = () => {
      const rect = ref.current.parentElement.getBoundingClientRect();
      const width = Math.min(260, window.innerWidth - 24);
      const top = rect.bottom + 7;
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top, maxHeight: Math.max(100, window.innerHeight - top - 12) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, []);
  return <div ref={ref} className="quick-popover" style={position} role="dialog" aria-label={label}><div className="quick-title">{label}</div>{children}</div>;
}

export default function QuickTools({ actions, onOpenChat, markdown, documentKey, labels = [] }) {
  const t = useT();
  const [open, setOpen] = useState(null);
  const [value, setValue] = useState('');
  const [size, setSize] = useState({ rows: 2, cols: 3 });
  const root = useRef(null);
  const trigger = useRef(null);
  const close = () => setOpen(null);
  useEffect(() => {
    const outside = e => { if (!root.current?.contains(e.target)) close(); };
    const escape = e => { if (e.key === 'Escape') { close(); trigger.current?.focus(); } };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape); };
  }, []);
  useEffect(close, [documentKey, markdown]);
  const run = (id, data) => { close(); actions.tool(id, data); };
  const button = (id, icon, label, action, disabled = false) => <button key={id} type="button" id={id} className="btn sm quick-button" title={label} aria-label={label} disabled={disabled} onMouseDown={e => e.preventDefault()} onClick={action || (() => run(id))}><Icon id={id} fallback={icon} /></button>;
  const menu = (id, icon, label, content) => <div className="quick-menu" key={id}>
    <button type="button" id={id} className={'btn sm quick-button' + (open === id ? ' on' : '')} title={label} aria-label={label} aria-haspopup="dialog" aria-expanded={open === id} onMouseDown={e => e.preventDefault()} onClick={e => { trigger.current = e.currentTarget; setValue(''); setOpen(open === id ? null : id); }}><Icon id={id} fallback={icon} /><span className="quick-caret">⌄</span></button>
    {open === id && <Popover label={label}>{content}</Popover>}
  </div>;
  const item = (id, label, hint) => <button type="button" className="quick-item" key={id} onClick={() => run(id)}><span>{label}</span>{hint && <code>{hint}</code>}</button>;
  const form = id => <form onSubmit={e => { e.preventDefault(); if (value.trim()) run(id, value.trim()); }}>
    <label className="quick-field">{t(id === 'tLink' ? 'q.url' : 'q.key')}<input autoFocus required type={id === 'tLink' ? 'url' : 'text'} value={value} pattern={id === 'tLink' ? undefined : '[A-Za-z0-9:._-]+'} placeholder={id === 'tLink' ? 'https://example.com' : 'sec:introduction'} onChange={e => setValue(e.target.value)} /></label>
    <button className="btn sm primary" type="submit" disabled={!value.trim()}>{t('q.insert')}</button>
  </form>;
  return <div id="toolbelt" className="edit-tools" ref={root} role="group" aria-label={t('q.toolbar')}>
    {button('tAi', '♧', t('m.aiAssistant'), onOpenChat)}<span className="tsep" />
    {button('tUndo', '↶', t('m.undo') + ' (Ctrl+Z)', () => actions.editOp('undo'))}
    {button('tRedo', '↷', t('m.redo') + ' (Ctrl+Shift+Z)', () => actions.editOp('redo'))}<span className="tsep" />
    {menu('tFormat', 'Tᴛ', t('q.format'), <>{item('tSec', t('t.sec'), 'H1')}{item('tSub', t('t.sub'), 'H2')}{item('tSubSub', t('q.subsub'), 'H3')}<div className="mi-sep" />{item('tU', t('t.underline'))}{item('tTt', t('t.mono'))}</>)}
    {button('tB', <b>B</b>, t('t.bold'))}
    {button('tI', <i>I</i>, t('t.italic'))}<span className="tsep" />
    {menu('tMathMenu', '▦', t('q.math'), <>{item('tMath', t('t.inlineMath'), '$…$')}{item('tEq', t('t.displayMath'), 'equation')}{item('tAlign', t('q.align'), 'align')}{item('tFrac', t('q.fraction'), 'a/b')}{item('tSqrt', t('q.sqrt'), '√x')}</>)}
    {menu('tSymbols', 'Ω', t('q.symbols'), <div className="quick-symbols">{SYMBOLS.map(([symbol, command]) => <button type="button" key={command} title={command} aria-label={command} onClick={() => run('tSymbol', command)}>{symbol}</button>)}</div>)}<span className="tsep" />
    {menu('tLinkMenu', '↗', t('q.link'), form('tLink'))}
    {button('tComment', '▤', t('q.comment'), undefined, markdown)}
    {!markdown && menu('tLabelMenu', '◆', t('q.label'), form('tLabel'))}
    {!markdown && menu('tRefMenu', '▣', t('q.reference'), <>{form('tRef')}{labels.length ? <div className="quick-labels">{labels.map(label => <button type="button" className="quick-item" key={label} onClick={() => run('tRef', label)}>{label}</button>)}</div> : <p className="quick-note">{t('q.noLabels')}</p>}</>)}
    {button('tImg', '▧', t('t.image'))}
    {menu('tTableMenu', '▥', t('q.table'), <><div className="quick-table-size">{size.cols} × {size.rows}</div><div className="quick-table-grid" onMouseLeave={() => setSize({ rows: 2, cols: 3 })}>{Array.from({ length: 36 }, (_, i) => { const rows = Math.floor(i / 6) + 1, cols = i % 6 + 1; return <button type="button" key={i} className={rows <= size.rows && cols <= size.cols ? 'active' : ''} aria-label={t('q.tableSize', { rows, cols })} title={t('q.tableSize', { rows, cols })} onFocus={() => setSize({ rows, cols })} onMouseEnter={() => setSize({ rows, cols })} onClick={() => run('tGridTable', { rows, cols })} />; })}</div>{!markdown && item('tTable', t('m.booktabs'))}</>)}<span className="tsep" />
    {menu('tListMenu', '☷', t('q.lists'), <>{item('tList', t('t.itemize'))}{item('tEnum', t('t.enumerate'))}</>)}
    {menu('tMore', '···', t('q.more'), <>{item('tFlow', t('t.flow'))}{item('tMermaid', t('t.mermaid'))}{item('tBib', t('t.cite'))}{item('tFn', t('t.footnote'))}</>)}
  </div>;
}

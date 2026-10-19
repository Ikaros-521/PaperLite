import { useEffect, useRef, useState } from 'react';
import { useT } from '../useI18n.js';
import { PROVIDERS } from '../citation.js';
import { searchCitations } from '../citationSearch.js';

/* 文献检索对话框：浏览器直连 Crossref / OpenAlex / DBLP 公共 API（无后端中转），
 * 选中条目后由 App 的 insertCitation 生成 BibTeX 追加到 .bib 并插入 \cite。
 * 网络层在 citationSearch.js 与移动端共用；这里只管超时/取消与界面降级。 */
export default function CiteDialog({ onClose, onInsert }) {
  const t = useT();
  const ref = useRef(null);
  const [provider, setProvider] = useState('crossref');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState([]);
  const abortRef = useRef(null);

  useEffect(() => { ref.current.showModal(); }, []);
  useEffect(() => () => abortRef.current?.abort(), []);

  const search = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    const q = query.trim();
    if (!q || loading) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, 15000);
    setLoading(true); setError(''); setResults([]);
    try {
      const list = await searchCitations(provider, q, ctrl.signal);
      setResults(list);
      if (!list.length) setError(t('cite.empty'));
    } catch (err) {
      // 超时 abort 与用户取消都是 AbortError，不分流的话超时看起来像「没搜到」
      if (timedOut && abortRef.current === ctrl) setError(t('cite.timeout'));
      else if (err && err.name !== 'AbortError') setError(t('cite.error', { msg: (err && err.message) || String(err) }));
    } finally {
      clearTimeout(timer);
      if (abortRef.current === ctrl) setLoading(false);
    }
  };

  return <dialog ref={ref} className="modal cite-dialog" aria-labelledby="cite-dialog-title" onCancel={onClose}
    onClick={e => { if (e.target === e.currentTarget) { const r = ref.current.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }}>
    <div className="modal-h"><span id="cite-dialog-title">{t('cite.title')}</span><button className="btn sm" aria-label={t('file.close')} onClick={onClose}>✕</button></div>
    <div className="modal-body">
      <p className="hint">{t('cite.netNote')}</p>
      <form className="cite-form" onSubmit={search}>
        <select value={provider} onChange={e => { setProvider(e.target.value); setResults([]); setError(''); }} aria-label={t('cite.provider')}>
          {Object.keys(PROVIDERS).map(p => <option key={p} value={p}>{t('cite.p_' + p)}</option>)}
        </select>
        <input autoFocus value={query} placeholder={t('cite.placeholder')} onChange={e => setQuery(e.target.value)} aria-label={t('cite.placeholder')} />
        <button className="btn sm primary" type="submit" disabled={!query.trim() || loading}>{loading ? t('cite.searching') : t('cite.search')}</button>
      </form>
      {error && <p className="cite-status">{error}</p>}
      <div className="cite-results">
        {results.map((e, i) => (
          <button key={i} type="button" className="cite-item" onClick={() => onInsert(e)} title={t('cite.insert')}>
            <span className="cite-title">{e.title}</span>
            <span className="cite-meta">
              {[
                e.authors.length > 3 ? e.authors.slice(0, 3).join('；') + t('cite.etAl') : e.authors.join('；'),
                e.venue,
                e.year,
              ].filter(Boolean).join(' · ')}
            </span>
            <span className="cite-src">{e.source}</span>
          </button>
        ))}
      </div>
    </div>
  </dialog>;
}

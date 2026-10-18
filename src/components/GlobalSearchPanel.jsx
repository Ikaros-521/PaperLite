import { useEffect, useRef } from 'react';
import { useT } from '../useI18n.js';

/* 侧栏「项目搜索」面板：跨打开标签 + 文件夹扫描 grep。
 * 受控组件——状态由 App 持有，切侧栏页签不丢结果；点击结果由 App 打开文件并跳行。 */
export default function GlobalSearchPanel({ state, setState, onSearch, onOpen, hasFolder }) {
  const t = useT();
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const { query = '', regex = false, matchCase = false, wholeWord = false, result, busy } = state;
  const flag = (on, glyph, title, key) => (
    <button type="button" className={'btn sm gs-flag' + (on ? ' on' : '')} title={title} aria-label={title} aria-pressed={on}
      onClick={() => setState(s => ({ ...s, [key]: !s[key] }))}>{glyph}</button>
  );
  const run = () => onSearch({ query, regex, matchCase, wholeWord });
  const error = result && result.ok === false;

  // 分组：同一文件的命中聚在一起
  const groups = [];
  for (const m of (result && result.matches) || []) {
    const last = groups[groups.length - 1];
    if (last && last.path === m.path) last.items.push(m);
    else groups.push({ path: m.path, items: [m] });
  }

  return <div className="gs-panel">
    <form className="gs-form" onSubmit={e => { e.preventDefault(); run(); }}>
      <input ref={inputRef} value={query} placeholder={t('gs.placeholder')} aria-label={t('gs.title')}
        onChange={e => setState(s => ({ ...s, query: e.target.value }))} />
      <button className="btn sm primary" type="submit" disabled={!query.trim() || busy}>{t('gs.go')}</button>
    </form>
    <div className="gs-flags">
      {flag(matchCase, 'Aa', t('find.case'), 'matchCase')}
      {flag(wholeWord, 'ab', t('find.word'), 'wholeWord')}
      {flag(regex, '.*', t('find.regex'), 'regex')}
      <span className="hint">{hasFolder ? t('gs.scope') : t('gs.noFolder')}</span>
    </div>
    {error && <p className="gs-status bad">{t('find.invalid')}</p>}
    {result && result.ok && result.matches.length === 0 && query && (
      <p className="gs-status">{t('gs.none')}</p>
    )}
    {result && result.ok && result.matches.length > 0 && (
      <p className="gs-status">{t('gs.count', { n: result.matches.length, files: result.fileCount })}{result.truncated ? ' · ' + t('gs.truncated') : ''}</p>
    )}
    <div className="gs-results">
      {groups.map(g => (
        <div key={g.path} className="gs-group">
          <div className="gs-file" title={g.path}>{g.path}<em>{g.items.length}</em></div>
          {g.items.map((m, i) => (
            <button key={i} type="button" className="gs-hit" onClick={() => onOpen(m.path, m.line)}>
              <span className="gs-lineno">{m.line + 1}</span>
              <span className="gs-line">
                {m.text.slice(Math.max(0, m.from - 40), m.from)}
                <mark>{m.text.slice(m.from, m.to)}</mark>
                {m.text.slice(m.to, m.to + 120)}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  </div>;
}

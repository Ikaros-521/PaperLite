import { useState } from 'react';
import { useLang, useT } from '../useI18n.js';
import { testConnection, fetchModels, newChannel, PLATFORM_PRESETS, PROTOCOLS, matchPreset, protocolOf } from '../llm.js';
import { resolveWindow, inputBudget, formatTokens } from '../context.js';

/* AI 设置弹窗：多渠道管理（内置平台预设 / OpenAI 兼容与 Anthropic 协议 /
 * 模型列表拉取 + 搜索下拉 / 测试连接 / 上下文窗口（默认按模型自动推断） */

// 模型输入框：可手输；点「获取模型」拉取渠道列表，输入即时过滤，点选填入
function ModelInput({ value, onChange, channel, suggestions, placeholder }) {
  const t = useT();
  const [models, setModels] = useState(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const list = models || suggestions || [];
  const kw = String(value || '').trim().toLowerCase();
  const filtered = kw ? list.filter(m => m.toLowerCase().includes(kw)) : list;

  const load = async () => {
    setLoading(true); setErr('');
    try {
      const ids = await fetchModels(channel);
      setModels(ids);
      setOpen(true);
      if (!ids.length) setErr(t('set.emptyList'));
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <span className="mi-wrap">
      <input
        value={value}
        placeholder={placeholder}
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}
      />
      <button
        type="button"
        className="mi-fetch"
        disabled={loading}
        onMouseDown={e => e.preventDefault()}
        onClick={load}
        title={t('set.fetchTip')}
      >
        {loading ? t('set.fetching') : models ? t('set.refreshN', { n: models.length }) : t('set.fetch')}
      </button>
      {open && (
        <div className="mi-drop">
          {filtered.length
            ? filtered.slice(0, 80).map(m => (
              <div key={m} className="mi-opt" onMouseDown={e => { e.preventDefault(); onChange(m); setOpen(false); }}>{m}</div>
            ))
            : <div className="mi-empty">{list.length ? t('set.noMatch') : t('set.fetchHint')}</div>}
        </div>
      )}
      {err && <span className="mi-err" title={err}>⚠ {err}</span>}
    </span>
  );
}

export default function SettingsDialog({ open, onClose, channels, setChannels, activeChannelId, setActiveChannelId }) {
  const t = useT();
  const lang = useLang();
  const [editId, setEditId] = useState(null);
  const [testing, setTesting] = useState(null); // {id, result}
  const [reveal, setReveal] = useState({});     // 各渠道 API Key 是否明文显示

  if (!open) return null;

  const patch = (id, field, value) => {
    setChannels(list => list.map(c => c.id === id ? { ...c, [field]: value } : c));
  };

  const doTest = async (ch) => {
    setTesting({ id: ch.id, result: null });
    const importMod = await import('../llm.js');
    const r = await importMod.testConnection(ch);
    setTesting({ id: ch.id, result: r });
  };

  // 选预设：自动填协议 / Base URL / 默认模型（名称与已填模型不覆盖）
  const applyPreset = (ch, presetId) => {
    const p = PLATFORM_PRESETS.filter(x => x.id === presetId)[0];
    if (!p) return;
    setChannels(list => list.map(c => {
      if (c.id !== ch.id) return c;
      const displayName = (lang === 'en' && p.nameEn) ? p.nameEn : p.name;
      const fillModel = !c.chatModel || c.chatModel === 'paperlite-mock';
      return {
        ...c,
        name: (!c.name || c.name === t('llm.newChannel')) ? displayName : c.name,
        protocol: p.protocol,
        baseUrl: p.baseUrl,
        chatModel: fillModel && p.models.length ? p.models[0] : c.chatModel
      };
    }));
  };

  const addChannel = () => {
    const c = newChannel();
    setChannels(list => list.concat([c]));
    setEditId(c.id);
    setActiveChannelId(c.id);
  };

  return (
    <div className="modal-mask" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-h">
          {t('set.title')}
          <button className="btn sm" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <p className="hint">{t('set.intro')}</p>

          <div className="ch-list">
            {channels.map(ch => {
              const proto = protocolOf(ch);
              const preset = matchPreset(ch);
              const win = resolveWindow(ch);
              const srcKey = { model: 'set.ctxFromModel', custom: 'set.ctxFromCustom', fallback: 'set.ctxFromFallback' }[win.source];
              return (
                <div key={ch.id} className={'ch-item' + (ch.id === activeChannelId ? ' on' : '')}>
                  <div className="ch-line" onClick={() => setActiveChannelId(ch.id)}>
                    <span className={'ch-dot' + (ch.id === activeChannelId ? ' on' : '')} title={t('set.activeTip')}></span>
                    <b>{ch.name}</b>
                    <span className={'ch-proto' + (proto === 'anthropic' ? ' anth' : '')}>{proto === 'anthropic' ? 'Claude' : 'OpenAI'}</span>
                    <span className="dim">{ch.chatModel || t('set.noModel')}{ch.embedModel ? ' · ' + t('set.retrieval') + ':' + ch.embedModel : ''}{ch.cot ? ' · 🧠' : ''}</span>
                    <span className="ch-acts">
                      <button onClick={e => { e.stopPropagation(); setEditId(editId === ch.id ? null : ch.id); }}>{editId === ch.id ? t('set.collapse') : t('set.edit')}</button>
                      <button disabled={testing && testing.id === ch.id && !testing.result} onClick={e => { e.stopPropagation(); doTest(ch); }}>
                        {testing && testing.id === ch.id && !testing.result ? t('set.testing') : t('set.test')}
                      </button>
                      <button onClick={e => { e.stopPropagation(); if (window.confirm(t('set.delConfirm', { name: ch.name }))) setChannels(list => list.filter(c => c.id !== ch.id)); }}>{t('set.del')}</button>
                    </span>
                  </div>
                  {testing && testing.id === ch.id && testing.result && (
                    <div className={'ch-test ' + (testing.result.ok ? 'ok' : 'bad')}>{testing.result.ok ? '✓ ' : '✗ '}{testing.result.msg}</div>
                  )}
                  {editId === ch.id && (
                    <div className="ch-edit">
                      <div className="ch-row">
                        <label>{t('set.preset')}
                          <select value={preset ? preset.id : 'custom'} onChange={e => applyPreset(ch, e.target.value)}>
                            <option value="custom">{t('set.custom')}</option>
                            {PLATFORM_PRESETS.map(p => <option key={p.id} value={p.id}>{(lang === 'en' && p.nameEn) ? p.nameEn : p.name}</option>)}
                          </select>
                        </label>
                        <label>{t('set.protocol')}
                          <select value={proto} onChange={e => patch(ch.id, 'protocol', e.target.value)}>
                            {PROTOCOLS.map(p => <option key={p.id} value={p.id}>{(lang === 'en' && p.labelEn) ? p.labelEn : p.label}</option>)}
                          </select>
                        </label>
                      </div>
                      <label>{t('set.name')}<input value={ch.name} onChange={e => patch(ch.id, 'name', e.target.value)} /></label>
                      <label>Base URL<input value={ch.baseUrl} onChange={e => patch(ch.id, 'baseUrl', e.target.value)} placeholder={proto === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.deepseek.com/v1'} /></label>
                      <label>API Key
                        <span className="kv-wrap">
                          <input type={reveal[ch.id] ? 'text' : 'password'} value={ch.apiKey}
                            autoComplete="off" spellCheck="false"
                            onChange={e => patch(ch.id, 'apiKey', e.target.value)} />
                          <button type="button" className="kv-eye"
                            title={t(reveal[ch.id] ? 'set.keyHide' : 'set.keyShow')}
                            aria-label={t(reveal[ch.id] ? 'set.keyHide' : 'set.keyShow')}
                            aria-pressed={!!reveal[ch.id]}
                            onClick={() => setReveal(r => ({ ...r, [ch.id]: !r[ch.id] }))}>
                            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M2.2 12S6 5.8 12 5.8 21.8 12 21.8 12 18 18.2 12 18.2 2.2 12 2.2 12z" />
                              <circle cx="12" cy="12" r="2.7" />
                              {!reveal[ch.id] && <path d="M4.5 4l15 15" />}
                            </svg>
                          </button>
                        </span>
                      </label>
                      <label>{t('set.chatModel')}
                        <ModelInput
                          value={ch.chatModel}
                          onChange={v => patch(ch.id, 'chatModel', v)}
                          channel={{ protocol: ch.protocol, baseUrl: ch.baseUrl, apiKey: ch.apiKey }}
                          suggestions={preset ? preset.models : []}
                          placeholder={proto === 'anthropic' ? 'claude-sonnet-4-5 …' : 'deepseek-chat / glm-4 / gpt-4o …'}
                        />
                      </label>
                      <label>{t('set.embedModel')}
                        <ModelInput
                          value={ch.embedModel}
                          onChange={v => patch(ch.id, 'embedModel', v)}
                          channel={{ protocol: ch.protocol, baseUrl: ch.baseUrl, apiKey: ch.apiKey }}
                          suggestions={preset ? preset.models : []}
                          placeholder={proto === 'anthropic' ? t('set.embedPhAnthropic') : t('set.embedPhOpenai')}
                        />
                      </label>
                      <label className="inline">
                        <input type="checkbox" checked={!!ch.cot} onChange={e => patch(ch.id, 'cot', e.target.checked)} />
                        {t('set.cot')}
                      </label>
                      <div className="ch-ctxwin">
                        <label>{t('set.ctxWindow')}
                          <select value={ch.ctxWindow ? 'custom' : 'auto'}
                            onChange={e => patch(ch.id, 'ctxWindow', e.target.value === 'custom' ? win.tokens : 0)}>
                            <option value="auto">{t('set.ctxAuto')}</option>
                            <option value="custom">{t('set.ctxCustom')}</option>
                          </select>
                        </label>
                        {!!ch.ctxWindow && (
                          <label>{t('set.ctxTokens')}
                            <input type="number" min="1000" step="1000" value={ch.ctxWindow}
                              onChange={e => patch(ch.id, 'ctxWindow', Math.max(1000, +e.target.value || 1000))} />
                          </label>
                        )}
                        <span className="hint ch-ctx-hint">
                          {t('set.ctxResolved', { v: formatTokens(win.tokens) }) + ' · ' + t(srcKey, { m: ch.chatModel || t('set.noModel') })}
                          <br />{t('set.ctxBudgetHint', { i: formatTokens(inputBudget(ch)), o: formatTokens(win.tokens - inputBudget(ch)) })}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {!channels.length && <div className="hint">{t('set.empty')}</div>}
          </div>

          <button className="btn" onClick={addChannel}>{t('set.add')}</button>
          <p className="hint">{t('set.tip')}</p>
        </div>

        <div className="modal-f">
          <button className="btn primary" onClick={onClose}>{t('set.done')}</button>
        </div>
      </div>
    </div>
  );
}

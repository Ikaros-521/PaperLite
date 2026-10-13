import { useState } from 'react';
import { testConnection, fetchModels, newChannel, PLATFORM_PRESETS, PROTOCOLS, matchPreset, protocolOf } from '../llm.js';

/* AI 设置弹窗：多渠道管理（内置平台预设 / OpenAI 兼容与 Anthropic 协议 /
 * 模型列表拉取 + 搜索下拉 / 测试连接） */

// 模型输入框：可手输；点「获取模型」拉取渠道列表，输入即时过滤，点选填入
function ModelInput({ value, onChange, channel, suggestions, placeholder }) {
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
      if (!ids.length) setErr('渠道返回了空列表');
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
        title="从该渠道拉取可用模型列表"
      >
        {loading ? '拉取中…' : models ? '刷新 ' + models.length : '获取模型'}
      </button>
      {open && (
        <div className="mi-drop">
          {filtered.length
            ? filtered.slice(0, 80).map(m => (
              <div key={m} className="mi-opt" onMouseDown={e => { e.preventDefault(); onChange(m); setOpen(false); }}>{m}</div>
            ))
            : <div className="mi-empty">{list.length ? '无匹配模型，可直接手输' : '点「获取模型」拉取可用列表，或直接手输'}</div>}
        </div>
      )}
      {err && <span className="mi-err" title={err}>⚠ {err}</span>}
    </span>
  );
}

export default function SettingsDialog({ open, onClose, channels, setChannels, activeChannelId, setActiveChannelId }) {
  const [editId, setEditId] = useState(null);
  const [testing, setTesting] = useState(null); // {id, result}

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
      const fillModel = !c.chatModel || c.chatModel === 'paperlite-mock';
      return {
        ...c,
        name: (!c.name || c.name === '新渠道') ? p.name : c.name,
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
          ⚙ AI 渠道设置
          <button className="btn sm" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <p className="hint">
            支持 OpenAI 兼容与 Anthropic (Claude) 两种主流协议；内置常用平台预设，选中即自动配好 Base URL，
            对话/检索模型可点「获取模型」拉取下拉选择。API Key 仅保存在本机浏览器 localStorage。
          </p>

          <div className="ch-list">
            {channels.map(ch => {
              const proto = protocolOf(ch);
              const preset = matchPreset(ch);
              return (
                <div key={ch.id} className={'ch-item' + (ch.id === activeChannelId ? ' on' : '')}>
                  <div className="ch-line" onClick={() => setActiveChannelId(ch.id)}>
                    <span className={'ch-dot' + (ch.id === activeChannelId ? ' on' : '')} title="设为当前渠道"></span>
                    <b>{ch.name}</b>
                    <span className={'ch-proto' + (proto === 'anthropic' ? ' anth' : '')}>{proto === 'anthropic' ? 'Claude' : 'OpenAI'}</span>
                    <span className="dim">{ch.chatModel || '未设模型'}{ch.embedModel ? ' · 检索:' + ch.embedModel : ''}{ch.cot ? ' · 🧠' : ''}</span>
                    <span className="ch-acts">
                      <button onClick={e => { e.stopPropagation(); setEditId(editId === ch.id ? null : ch.id); }}>{editId === ch.id ? '收起' : '编辑'}</button>
                      <button disabled={testing && testing.id === ch.id && !testing.result} onClick={e => { e.stopPropagation(); doTest(ch); }}>
                        {testing && testing.id === ch.id && !testing.result ? '测试中…' : '测试连接'}
                      </button>
                      <button onClick={e => { e.stopPropagation(); if (window.confirm('删除渠道「' + ch.name + '」？')) setChannels(list => list.filter(c => c.id !== ch.id)); }}>删除</button>
                    </span>
                  </div>
                  {testing && testing.id === ch.id && testing.result && (
                    <div className={'ch-test ' + (testing.result.ok ? 'ok' : 'bad')}>{testing.result.ok ? '✓ ' : '✗ '}{testing.result.msg}</div>
                  )}
                  {editId === ch.id && (
                    <div className="ch-edit">
                      <div className="ch-row">
                        <label>平台预设
                          <select value={preset ? preset.id : 'custom'} onChange={e => applyPreset(ch, e.target.value)}>
                            <option value="custom">（自定义）</option>
                            {PLATFORM_PRESETS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        </label>
                        <label>接口协议
                          <select value={proto} onChange={e => patch(ch.id, 'protocol', e.target.value)}>
                            {PROTOCOLS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                          </select>
                        </label>
                      </div>
                      <label>名称<input value={ch.name} onChange={e => patch(ch.id, 'name', e.target.value)} /></label>
                      <label>Base URL<input value={ch.baseUrl} onChange={e => patch(ch.id, 'baseUrl', e.target.value)} placeholder={proto === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.deepseek.com/v1'} /></label>
                      <label>API Key<input type="password" value={ch.apiKey} onChange={e => patch(ch.id, 'apiKey', e.target.value)} /></label>
                      <label>对话模型
                        <ModelInput
                          value={ch.chatModel}
                          onChange={v => patch(ch.id, 'chatModel', v)}
                          channel={{ protocol: ch.protocol, baseUrl: ch.baseUrl, apiKey: ch.apiKey }}
                          suggestions={preset ? preset.models : []}
                          placeholder={proto === 'anthropic' ? 'claude-sonnet-4-5 …' : 'deepseek-chat / glm-4 / gpt-4o …'}
                        />
                      </label>
                      <label>检索模型（可选，用于文档检索增强）
                        <ModelInput
                          value={ch.embedModel}
                          onChange={v => patch(ch.id, 'embedModel', v)}
                          channel={{ protocol: ch.protocol, baseUrl: ch.baseUrl, apiKey: ch.apiKey }}
                          suggestions={preset ? preset.models : []}
                          placeholder={proto === 'anthropic' ? 'Claude 协议无嵌入接口，留空即可' : 'text-embedding-…（留空则检索退化为全文截断）'}
                        />
                      </label>
                      <label className="inline">
                        <input type="checkbox" checked={!!ch.cot} onChange={e => patch(ch.id, 'cot', e.target.checked)} />
                        启用思维链（模型返回的 reasoning/thinking 内容将在对话中可折叠查看）
                      </label>
                      <label>上下文上限（字符）<input type="number" min="2000" step="1000" value={ch.contextLimit} onChange={e => patch(ch.id, 'contextLimit', +e.target.value || 24000)} /></label>
                    </div>
                  )}
                </div>
              );
            })}
            {!channels.length && <div className="hint">还没有渠道，点下方添加。</div>}
          </div>

          <button className="btn" onClick={addChannel}>＋ 添加渠道</button>
          <p className="hint">提示：默认预填本机 Mock（需 node server.mjs 启动）用于体验；正式使用请在「平台预设」选择你的平台（自动配好），或手动填写。</p>
        </div>

        <div className="modal-f">
          <button className="btn primary" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { testConnection } from '../llm.js';

/* AI 设置弹窗：多渠道管理（Base URL / Key / 对话模型 / 检索模型 / 思维链 / 上下文上限 / 测试连接） */
export default function SettingsDialog({ open, onClose, channels, setChannels, activeChannelId, setActiveChannelId }) {
  const [editId, setEditId] = useState(null);
  const [testing, setTesting] = useState(null); // {id, result}

  if (!open) return null;

  const edit = channels.filter(c => c.id === editId)[0] || null;

  const patch = (id, field, value) => {
    setChannels(list => list.map(c => c.id === id ? { ...c, [field]: value } : c));
  };

  const doTest = async (ch) => {
    setTesting({ id: ch.id, result: null });
    const importMod = await import('../llm.js');
    const r = await importMod.testConnection(ch);
    setTesting({ id: ch.id, result: r });
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
            兼容 OpenAI 协议（OpenAI / DeepSeek / GLM / 通义 / Kimi / 本地 Ollama 等）。API Key 仅保存在本机浏览器 localStorage。
          </p>

          <div className="ch-list">
            {channels.map(ch => (
              <div key={ch.id} className={'ch-item' + (ch.id === activeChannelId ? ' on' : '')}>
                <div className="ch-line" onClick={() => setActiveChannelId(ch.id)}>
                  <span className={'ch-dot' + (ch.id === activeChannelId ? ' on' : '')} title="设为当前渠道"></span>
                  <b>{ch.name}</b>
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
                    <label>名称<input value={ch.name} onChange={e => patch(ch.id, 'name', e.target.value)} /></label>
                    <label>Base URL<input value={ch.baseUrl} onChange={e => patch(ch.id, 'baseUrl', e.target.value)} placeholder="https://api.deepseek.com/v1" /></label>
                    <label>API Key<input type="password" value={ch.apiKey} onChange={e => patch(ch.id, 'apiKey', e.target.value)} /></label>
                    <label>对话模型<input value={ch.chatModel} onChange={e => patch(ch.id, 'chatModel', e.target.value)} placeholder="deepseek-chat / glm-4 / gpt-4o …" /></label>
                    <label>检索模型（可选，用于文档检索增强）<input value={ch.embedModel} onChange={e => patch(ch.id, 'embedModel', e.target.value)} placeholder="text-embedding-…（留空则检索退化为全文截断）" /></label>
                    <label className="inline">
                      <input type="checkbox" checked={!!ch.cot} onChange={e => patch(ch.id, 'cot', e.target.checked)} />
                      启用思维链（发送推理提示；若模型返回 reasoning_content 将在对话中可折叠查看）
                    </label>
                    <label>上下文上限（字符）<input type="number" min="2000" step="1000" value={ch.contextLimit} onChange={e => patch(ch.id, 'contextLimit', +e.target.value || 24000)} /></label>
                  </div>
                )}
              </div>
            ))}
            {!channels.length && <div className="hint">还没有渠道，点下方添加。</div>}
          </div>

          <button className="btn" onClick={() => setChannels(list => list.concat([{ id: 'ch-' + Date.now().toString(36), name: '新渠道', baseUrl: 'http://localhost:8788/v1', apiKey: '', chatModel: 'paperlite-mock', embedModel: '', cot: false, contextLimit: 24000 }]))}>
            ＋ 添加渠道
          </button>
          <p className="hint">提示：默认预填本机 Mock（需 node server.mjs 启动）用于体验；正式使用请改为你的真实渠道。</p>
        </div>

        <div className="modal-f">
          <button className="btn primary" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}

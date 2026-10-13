import { useEffect, useMemo, useRef, useState } from 'react';

/* AI 对话面板：多渠道选择、上下文范围（选区/段落/全文/检索增强）、流式输出（含思维链）、
 * 代码块操作（复制 / 替换选区 / 插入光标 / 替换全文）、外部提示词注入（诊断点一键修复） */
export default function ChatPanel({ open, onClose, channels, activeChannelId, setActiveChannelId, onOpenSettings, buildContext, messages, setMessages, inject }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState('selection');
  const [showReasoning, setShowReasoning] = useState({});
  const abortRef = useRef(null);
  const listRef = useRef(null);
  const taRef = useRef(null);

  const channel = useMemo(
    () => channels.filter(c => c.id === activeChannelId)[0] || channels[0] || null,
    [channels, activeChannelId]
  );

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages]);

  // 外部注入提示词（如点击诊断红点）：预填输入框并聚焦，光标到末尾等待补充修复方向
  useEffect(() => {
    if (inject && inject.n) {
      setInput(inject.text);
      setTimeout(() => {
        const ta = taRef.current;
        if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      }, 60);
    }
  }, [inject && inject.n]);

  if (!open) return null;

  const send = async () => {
    const q = input.trim();
    if (!q || busy) return;
    if (!channel) { alert('请先在「AI 设置」中添加渠道'); onOpenSettings(); return; }
    setInput('');
    const ctx = await buildContext(scope, q, channel);
    const userMsg = { role: 'user', content: q, ctxNote: ctx.note };
    const history = [...messages, userMsg];
    setMessages([...history, { role: 'assistant', content: '', reasoning: '' }]);
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const sys = {
        role: 'system',
        content: '你是论文写作与 LaTeX/Markdown 排版助手。回答简洁、结构化，使用 Markdown。' +
          '当用户要求改写/修复时，把完整结果放在 ```latex 或 ```markdown 代码块中，便于一键应用。'
      };
      const payload = [sys];
      if (ctx.text) payload.push({ role: 'system', content: '当前文档上下文（供参考，不要原样复述）：\n' + ctx.text });
      payload.push(...history.slice(-10).map(m => ({ role: m.role, content: m.content })));

      await import('../llm.js').then(async (llm) => {
        await llm.chat(channel, payload, {
          stream: true,
          signal: ac.signal,
          onDelta: (t) => setMessages(ms => ms.map((m, i) => i === ms.length - 1 ? { ...m, content: m.content + t } : m)),
          onReasoning: (t) => setMessages(ms => ms.map((m, i) => i === ms.length - 1 ? { ...m, reasoning: (m.reasoning || '') + t } : m))
        });
      });
    } catch (e) {
      if (e.name !== 'AbortError') {
        setMessages(ms => ms.map((m, i) => i === ms.length - 1 && !m.content
          ? { ...m, content: '⚠ 请求失败：' + (e.message || e) + '\n\n请检查渠道配置（Base URL / Key / 模型名）或点「测试连接」。' }
          : m));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const applyBlock = (code, mode) => {
    const cm = buildContext.cm && buildContext.cm();
    if (!cm) return;
    if (mode === 'replaceDoc') {
      if (!window.confirm('用 AI 结果替换整个文档？（Ctrl+Z 可撤销）')) return;
      cm.setValue(code);
    } else if (mode === 'replaceSel') {
      if (!cm.getSelection()) { alert('当前无选区，将改为插入到光标处'); cm.replaceSelection(code); }
      else cm.replaceSelection(code);
    } else {
      cm.replaceSelection(code);
    }
    cm.focus();
  };

  const copy = (t) => navigator.clipboard && navigator.clipboard.writeText(t);

  const renderBlocks = (text, mi) => {
    const parts = [];
    const re = /```(latex|tex|markdown|md|js|python)?\n([\s\S]*?)```/g;
    let last = 0, m, bi = 0;
    while ((m = re.exec(text))) {
      const code = m[2]; // 每轮捕获，避免闭包读到循环结束后的 null
      if (m.index > last) parts.push(<div key={'t' + bi} className="chat-md">{miniMd(text.slice(last, m.index))}</div>);
      parts.push(
        <div key={'c' + bi} className="chat-code">
          <pre>{code}</pre>
          <div className="chat-code-acts">
            <button onClick={() => copy(code)}>复制</button>
            <button onClick={() => applyBlock(code, 'replaceSel')}>替换选区/插入</button>
            <button onClick={() => applyBlock(code, 'replaceDoc')}>替换全文</button>
          </div>
        </div>
      );
      last = re.lastIndex; bi++;
    }
    if (last < text.length) parts.push(<div key="te" className="chat-md">{miniMd(text.slice(last))}</div>);
    return parts;
  };

  return (
    <aside id="chatPanel" className="open">
      <div className="sp-title">
        AI 助手
        <span className="cp-head-acts">
          <button title="AI 设置" onClick={onOpenSettings}>⚙</button>
          <button title="清空对话" onClick={() => setMessages([])}>清</button>
          <button title="关闭" onClick={onClose}>✕</button>
        </span>
      </div>

      <div className="chat-config">
        <select value={channel ? channel.id : ''} onChange={e => setActiveChannelId(e.target.value)}>
          {!channels.length && <option value="">（未配置渠道）</option>}
          {channels.map(c => <option key={c.id} value={c.id}>{c.name} · {c.chatModel || '未设模型'}</option>)}
        </select>
        <select value={scope} onChange={e => setScope(e.target.value)} title="发送给 AI 的上下文范围">
          <option value="selection">上下文：选区</option>
          <option value="paragraph">上下文：光标段落</option>
          <option value="full">上下文：全文</option>
          <option value="retrieve">上下文：检索增强</option>
        </select>
        {channel && channel.cot && <span className="cot-badge" title="该渠道已启用思维链">◈ 思维链</span>}
      </div>

      <div className="chat-list" ref={listRef}>
        {!messages.length && (
          channel ? (
            <div className="chat-empty">
              <div className="chat-suggest-h">试试：</div>
              {['把引言改写得更学术', '润色这段并解释修改点', '帮我把这个公式转成 align 环境'].map(s => (
                <button key={s} className="chat-suggest"
                  onClick={() => { setInput('「' + s + '」'); taRef.current && taRef.current.focus(); }}>
                  「{s}」
                </button>
              ))}
            </div>
          ) : (
            <div className="chat-guide">
              <div className="chat-guide-t">还没有配置 AI 渠道</div>
              <p>添加一个 OpenAI 兼容或 Anthropic 协议的渠道后，即可在这里改写引言、润色段落、修复语法。</p>
              <button className="btn sm primary" onClick={onOpenSettings}>前往 AI 设置</button>
            </div>
          )
        )}
        {messages.map((m, i) => (
          <div key={i} className={'chat-msg ' + m.role}>
            {m.role === 'user' && m.ctxNote && <div className="chat-ctx">{m.ctxNote}</div>}
            {m.role === 'assistant' && m.reasoning ? (
              <div className="chat-cot">
                <button className="cot-toggle" onClick={() => setShowReasoning(s => ({ ...s, [i]: !s[i] }))}>
                  💭 思维链 {showReasoning[i] ? '▾' : '▸'}
                </button>
                {showReasoning[i] && <div className="cot-body">{m.reasoning}</div>}
              </div>
            ) : null}
            {m.content ? renderBlocks(m.content, i) : busy && i === messages.length - 1 ? <span className="typing">思考中…</span> : null}
          </div>
        ))}
      </div>

      <div className="chat-input">
        <textarea
          ref={taRef}
          value={input}
          placeholder={channel ? '描述你的需求…（Enter 发送 / Shift+Enter 换行）' : '配置渠道后即可在此对话'}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
        />
        <div className="chat-input-acts">
          {busy
            ? <button className="btn sm" onClick={() => abortRef.current && abortRef.current.abort()}>■ 停止</button>
            : <button className="btn sm primary" onClick={send} disabled={!channel}>发送 ▸</button>}
        </div>
      </div>
    </aside>
  );
}

// 极简 Markdown 渲染（聊天内）：**粗体** / `code` / 列表 / 换行
function miniMd(t) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let h = esc(t);
  h = h.replace(/```[\s\S]*?```/g, m => m); // 代码块由外层处理
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.replace(/^[-*]\s+(.+)$/gm, '• $1');
  return <span dangerouslySetInnerHTML={{ __html: h.replace(/\n/g, '<br/>') }} />;
}

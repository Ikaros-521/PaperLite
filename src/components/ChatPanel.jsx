import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../useI18n.js';

/* AI 对话面板：多渠道选择、上下文范围（选区/段落/全文/检索增强）、流式输出（含思维链）、
 * 代码块操作（复制 / 替换选区 / 插入光标 / 替换全文）、外部提示词注入（诊断点一键修复） */
export default function ChatPanel({ open, onClose, channels, activeChannelId, setActiveChannelId, onOpenSettings, buildContext, messages, setMessages, inject }) {
  const t = useT();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState('selection');
  const [showReasoning, setShowReasoning] = useState({});
  const [pos, setPos] = useState(null);      // null=停靠右侧；{x,y}=浮动位置（同样式面板）
  const [width, setWidth] = useState(null);  // null=默认 360；左缘可拉伸
  const [height, setHeight] = useState(null);
  const abortRef = useRef(null);
  const listRef = useRef(null);
  const taRef = useRef(null);
  const panelRef = useRef(null);

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

  // 拖拽：按下标题栏（按钮除外）浮窗化并跟随指针，双击标题回停靠（同图样式面板）
  const startDrag = (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const off = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    setPos({ x: rect.left, y: rect.top });
    setHeight(rect.height);
    const move = (ev) => {
      const w = el.offsetWidth;
      const x = Math.min(Math.max(ev.clientX - off.dx, 60 - w), window.innerWidth - 60);
      const y = Math.min(Math.max(ev.clientY - off.dy, 8), window.innerHeight - 44);
      setPos({ x, y });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
    e.preventDefault();
  };

  // 左缘拉伸宽度：右缘保持不动（浮动态同时回移 left）
  const startResize = (e) => {
    if (e.button !== 0) return;
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const startW = rect.width;
    const startX = e.clientX;
    const fixedRight = rect.right;
    const move = (ev) => {
      const maxW = Math.min(720, window.innerWidth - 80);
      const w = Math.min(maxW, Math.max(300, startW + (startX - ev.clientX)));
      setWidth(w);
      if (pos) setPos(p => (p ? { ...p, x: fixedRight - w } : p));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.style.userSelect = 'none';
    e.preventDefault();
  };

  const send = async () => {
    const q = input.trim();
    if (!q || busy) return;
    if (!channel) { alert(t('chat.needChannel')); onOpenSettings(); return; }
    setInput('');
    const ctx = await buildContext(scope, q, channel);
    const userMsg = { role: 'user', content: q, ctxNote: ctx.note };
    const history = [...messages, userMsg];
    setMessages([...history, { role: 'assistant', content: '', reasoning: '' }]);
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const sys = { role: 'system', content: t('ai.system') };
      const payload = [sys];
      if (ctx.text) payload.push({ role: 'system', content: t('ai.ctxHeader') + '\n' + ctx.text });
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
          ? { ...m, content: t('chat.reqFailed', { msg: e.message || e }) }
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
      if (!window.confirm(t('chat.replaceDocConfirm'))) return;
      cm.setValue(code);
    } else if (mode === 'replaceSel') {
      if (!cm.getSelection()) { alert(t('chat.noSelInsert')); cm.replaceSelection(code); }
      else cm.replaceSelection(code);
    } else {
      cm.replaceSelection(code);
    }
    cm.focus();
  };

  const copy = (text) => navigator.clipboard && navigator.clipboard.writeText(text);

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
            <button onClick={() => copy(code)}>{t('chat.copy')}</button>
            <button onClick={() => applyBlock(code, 'replaceSel')}>{t('chat.replaceSel')}</button>
            <button onClick={() => applyBlock(code, 'replaceDoc')}>{t('chat.replaceDoc')}</button>
          </div>
        </div>
      );
      last = re.lastIndex; bi++;
    }
    if (last < text.length) parts.push(<div key="te" className="chat-md">{miniMd(text.slice(last))}</div>);
    return parts;
  };

  return (
    <aside
      id="chatPanel"
      ref={panelRef}
      className={'open' + (pos ? ' floating' : '')}
      style={{
        ...(width ? { width: width + 'px' } : {}),
        ...(pos ? {
          left: pos.x + 'px', top: pos.y + 'px',
          height: (height || 420) + 'px',
          maxHeight: 'calc(100vh - ' + (pos.y + 12) + 'px)'
        } : {})
      }}
    >
      <span className="cp-resize" title={t('chat.resize')} onPointerDown={startResize}></span>
      <div className="sp-title" onPointerDown={startDrag} onDoubleClick={() => setPos(null)}>
        <span className="sp-drag" title={t('chat.drag')}>⠿</span>
        <span className="sp-t">{t('chat.title')}</span>
        <span className="cp-head-acts">
          <button title={t('chat.settings')} onClick={onOpenSettings}>⚙</button>
          <button title={t('chat.clear')} onClick={() => setMessages([])}>清</button>
          <button title={t('chat.close')} onClick={onClose}>✕</button>
        </span>
      </div>

      <div className="chat-config">
        <select value={channel ? channel.id : ''} onChange={e => setActiveChannelId(e.target.value)}>
          {!channels.length && <option value="">{t('chat.noChannelOpt')}</option>}
          {channels.map(c => <option key={c.id} value={c.id}>{c.name} · {c.chatModel || t('chat.noModel')}</option>)}
        </select>
        <select value={scope} onChange={e => setScope(e.target.value)} title={t('chat.scopeTip')}>
          <option value="selection">{t('chat.scopeSel')}</option>
          <option value="paragraph">{t('chat.scopePara')}</option>
          <option value="full">{t('chat.scopeFull')}</option>
          <option value="retrieve">{t('chat.scopeRag')}</option>
        </select>
        {channel && channel.cot && <span className="cot-badge" title={t('chat.cotTip')}>{t('chat.cot')}</span>}
      </div>

      <div className="chat-list" ref={listRef}>
        {!messages.length && (
          channel ? (
            <div className="chat-empty">
              <div className="chat-suggest-h">{t('chat.try')}</div>
              {[t('chat.sug1'), t('chat.sug2'), t('chat.sug3')].map(s => (
                <button key={s} className="chat-suggest"
                  onClick={() => { setInput('「' + s + '」'); taRef.current && taRef.current.focus(); }}>
                  「{s}」
                </button>
              ))}
            </div>
          ) : (
            <div className="chat-guide">
              <div className="chat-guide-t">{t('chat.noChannelT')}</div>
              <p>{t('chat.noChannelP')}</p>
              <button className="btn sm primary" onClick={onOpenSettings}>{t('chat.openSettings')}</button>
            </div>
          )
        )}
        {messages.map((m, i) => (
          <div key={i} className={'chat-msg ' + m.role}>
            {m.role === 'user' && m.ctxNote && <div className="chat-ctx">{m.ctxNote}</div>}
            {m.role === 'assistant' && m.reasoning ? (
              <div className="chat-cot">
                <button className="cot-toggle" onClick={() => setShowReasoning(s => ({ ...s, [i]: !s[i] }))}>
                  {t('chat.cotToggle')} {showReasoning[i] ? '▾' : '▸'}
                </button>
                {showReasoning[i] && <div className="cot-body">{m.reasoning}</div>}
              </div>
            ) : null}
            {m.content ? renderBlocks(m.content, i) : busy && i === messages.length - 1 ? <span className="typing">{t('chat.thinking')}</span> : null}
          </div>
        ))}
      </div>

      <div className="chat-input">
        <textarea
          ref={taRef}
          value={input}
          placeholder={channel ? t('chat.phReady') : t('chat.phNoChannel')}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
        />
        <div className="chat-input-acts">
          {busy
            ? <button className="btn sm" onClick={() => abortRef.current && abortRef.current.abort()}>{t('chat.stop')}</button>
            : <button className="btn sm primary" onClick={send} disabled={!channel}>{t('chat.send')}</button>}
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

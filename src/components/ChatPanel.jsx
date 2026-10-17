import { useEffect, useMemo, useRef, useState } from 'react';
import { useLang, useT } from '../useI18n.js';
import * as ctx from '../context.js';
import { showAlert as alert, showConfirm } from '../dialogs.js';

/* AI 对话面板：多渠道选择、上下文范围（选区/段落/全文/检索增强）、流式输出（含思维链）、
 * 代码块操作（复制 / 替换选区 / 插入光标 / 替换全文）、外部提示词注入（诊断点一键修复）、
 * 上下文用量状态栏（实测/估算）与压缩（模型摘要，失败回退本地裁剪）。
 * 载荷装配与 token 口径统一在 context.js，后续 agent 工具调用共用同一预算。 */
const KEEP_TURNS = 6;      // 压缩时保留末尾条数
const COMPACT_AT = 0.85;   // 达到窗口该比例时提示并可自动压缩

export default function ChatPanel({ open, onClose, channels, activeChannelId, setActiveChannelId, onOpenSettings, buildContext, messages, setMessages, inject, onBeforeApply, narrow = false, externalBusy = false }) {
  const t = useT();
  const lang = useLang();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState('selection');
  const [showReasoning, setShowReasoning] = useState({});
  const [pos, setPos] = useState(null);      // null=停靠右侧；{x,y}=浮动位置（同样式面板）
  const [width, setWidth] = useState(null);  // null=默认 360；左缘可拉伸
  const [height, setHeight] = useState(null);
  const [reqUsage, setReqUsage] = useState(null); // 最近一次请求装配出的分类用量
  const [realUsage, setRealUsage] = useState(null); // 服务端返回的实测 usage（缺省则用估算）
  const [compacting, setCompacting] = useState(false);
  const [compactSecs, setCompactSecs] = useState(0);
  const [note, setNote] = useState('');   // 状态栏短暂提示（压缩结果等）
  const abortRef = useRef(null);
  const noteTimer = useRef(null);
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

  // 用量基线：只随消息条数变化重算，流式增量不触发整段历史重新估算
  const settledCount = busy ? messages.length - 1 : messages.length;
  const base = useMemo(() => {
    const u = ctx.rawUsage({
      system: t('ai.system'),
      summaryHeader: t('ai.summaryHeader'),
      history: messages.slice(0, Math.max(0, settledCount))
    });
    const docCost = reqUsage ? reqUsage.doc : 0;
    return { ...u, doc: docCost, total: u.total + docCost };
  }, [settledCount, reqUsage, lang]);

  useEffect(() => () => clearTimeout(noteTimer.current), []);

  // 压缩是同步等待的一次模型请求，慢渠道要让用户看到已经过了多久
  useEffect(() => {
    if (!compacting) { setCompactSecs(0); return undefined; }
    const iv = setInterval(() => setCompactSecs(s => s + 1), 1000);
    return () => clearInterval(iv);
  }, [compacting]);

  if (!open) return null;

  // 拖拽：按下标题栏（按钮除外）浮窗化并跟随指针，双击标题回停靠（同图样式面板）
  // narrow（移动端嵌入）下不浮窗：面板填满容器，拖动只会让它在 430px 宽里乱跑
  const startDrag = (e) => {
    if (narrow || e.button !== 0 || e.target.closest('button')) return;
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const off = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    setPos({ x: rect.left, y: rect.top });
    setHeight(rect.height);
    beginPointerDrag(e, 'grabbing', (ev) => {
      const w = el.offsetWidth;
      const x = Math.min(Math.max(ev.clientX - off.dx, 60 - w), window.innerWidth - 60);
      const y = Math.min(Math.max(ev.clientY - off.dy, 8), window.innerHeight - 44);
      setPos({ x, y });
    });
  };

  // 左缘拉伸宽度：右缘保持不动（浮动态同时回移 left）
  const startResize = (e) => {
    if (narrow || e.button !== 0) return;
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const startW = rect.width;
    const startX = e.clientX;
    const fixedRight = rect.right;
    beginPointerDrag(e, 'ew-resize', (ev) => {
      const maxW = Math.min(960, window.innerWidth - 80);
      const w = Math.min(maxW, Math.max(300, startW + (startX - ev.clientX)));
      setWidth(w);
      if (pos) setPos(p => (p ? { ...p, x: fixedRight - w } : p));
    });
  };

  // 用量状态栏：服务端有 usage 时显示实测，否则用分类估算汇总
  const winInfo = ctx.resolveWindow(channel);
  const win = winInfo.tokens;
  const budget = ctx.inputBudget(channel);
  const reserve = ctx.outputReserve(channel);
  const liveOut = busy ? ctx.estimateTokens((messages[messages.length - 1] || {}).content) : 0;
  const isReal = !busy && !!realUsage;
  const used = isReal ? realUsage.input + realUsage.output : base.total + liveOut;
  const pct = win ? used / win : 0;
  const level = pct >= COMPACT_AT ? 'bad' : pct >= 0.6 ? 'warn' : 'ok';
  const srcKey = { model: 'chat.ctxWinModel', custom: 'chat.ctxWinCustom', fallback: 'chat.ctxWinDefault' }[winInfo.source];
  const tipText = [
    t('chat.ctxSys') + ' ' + ctx.formatTokens(base.system),
    t('chat.ctxDoc') + ' ' + ctx.formatTokens(base.doc),
    t('chat.ctxHist') + ' ' + ctx.formatTokens(base.history),
    // 回复只在已知时列出：空闲且无实测时它已计入「历史」，再列一遍会重复计数
    isReal ? t('chat.ctxOut') + ' ' + ctx.formatTokens(realUsage.output) : null,
    busy ? t('chat.ctxOut') + ' ' + ctx.formatTokens(liveOut) : null,
    t('chat.ctxReserve') + ' ' + ctx.formatTokens(reserve),
    t('chat.ctxWin') + ' ' + ctx.formatTokens(win) + ' · ' + t(srcKey)
  ].filter(Boolean).join(' · ');

  const flashNote = (msg) => {
    setNote(msg);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(''), 5000);
  };

  // 压缩上下文：较早的历史交给模型生成摘要，末尾若干条保留原文；
  // 摘要请求失败时退化为本地裁剪（丢弃最早消息），保证一定能腾出预算。
  const runCompact = async (list, auto) => {
    if (!channel || compacting) return null;
    const split = ctx.splitForCompact(list, KEEP_TURNS);
    if (!split) { if (!auto) flashNote(t('chat.compactSkip')); return null; }
    const before = ctx.rawUsage({ summaryHeader: t('ai.summaryHeader'), history: list }).total;
    let summary = '';
    try {
      setCompacting(true);
      const llm = await import('../llm.js');
      const text = ctx.historyToText(split.head, {
        user: t('chat.roleUser'), assistant: t('chat.roleAi'), summary: t('chat.summaryLabel')
      });
      summary = (await llm.summarize(channel, text, ctx.summaryBudget(channel))).content;
    } catch (e) {
      summary = '';
    } finally {
      setCompacting(false);
    }
    const msg = {
      role: 'assistant',
      kind: 'summary',
      count: split.head.length,
      content: summary || t('chat.compactTrimmed', { n: split.head.length })
    };
    const next = [msg].concat(split.tail);
    const after = ctx.rawUsage({ summaryHeader: t('ai.summaryHeader'), history: next }).total;
    setMessages(next);
    setRealUsage(null);
    setReqUsage(null);
    flashNote(t(auto ? 'chat.compactAuto' : 'chat.compactDone', {
      n: split.head.length,
      saved: ctx.formatTokens(Math.max(0, before - after))
    }));
    return next;
  };

  const send = async () => {
    const q = input.trim();
    if (!q || busy || externalBusy) return;
    if (!channel) { alert(t('chat.needChannel')); onOpenSettings(); return; }
    setInput('');
    setNote('');
    const pack = await buildContext(scope, q, channel);
    const build = (list) => ctx.buildPayload({
      system: t('ai.system'),
      docHeader: t('ai.ctxHeader'),
      doc: pack.text,
      summaryHeader: t('ai.summaryHeader'),
      history: list,
      budget
    });
    let history = messages.concat([{ role: 'user', content: q, ctxNote: pack.note }]);
    let built = build(history);
    // 判断用未裁剪的总占用：装配结果本身会被预算截断，看不出「到底差多少」
    const need = ctx.rawUsage({
      system: t('ai.system'), docHeader: t('ai.ctxHeader'), doc: pack.text,
      summaryHeader: t('ai.summaryHeader'), history
    }).total;
    if (need >= budget * COMPACT_AT) {
      const compacted = await runCompact(history, true);
      if (compacted) { history = compacted; built = build(history); }
    }
    setReqUsage(built.usage);
    setRealUsage(null);
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    setMessages(history.concat([{ role: 'assistant', content: '', reasoning: '' }]));
    try {
      const llm = await import('../llm.js');
      const res = await llm.chat(channel, built.messages, {
        stream: true,
        signal: ac.signal,
        onDelta: (d) => setMessages(ms => ms.map((m, i) => i === ms.length - 1 ? { ...m, content: m.content + d } : m)),
        onReasoning: (d) => setMessages(ms => ms.map((m, i) => i === ms.length - 1 ? { ...m, reasoning: (m.reasoning || '') + d } : m))
      });
      setRealUsage(res.usage || null);
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

  const applyBlock = async (code, mode) => {
    const cm = buildContext.cm && buildContext.cm();
    if (!cm) return;
    // 撤销栈一被冲掉就回不来了：整篇/整段替换前先存一份版本（取消则不留）
    if (mode === 'replaceDoc') {
      if (!await showConfirm(t('chat.replaceDocConfirm'))) return;
      if (onBeforeApply) onBeforeApply();
      cm.setValue(code);
    } else if (mode === 'replaceSel') {
      if (onBeforeApply) onBeforeApply();
      if (!cm.getSelection()) { await alert(t('chat.noSelInsert')); cm.replaceSelection(code); }
      else cm.replaceSelection(code);
    } else {
      cm.replaceSelection(code);
    }
    cm.focus && cm.focus();
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
      role="complementary"
      aria-label={t('m.aiAssistant')}
      ref={panelRef}
      className={'open' + (narrow ? ' narrow' : '') + (pos ? ' floating' : '')}
      style={narrow ? {} : {
        ...(width ? { width: width + 'px' } : {}),
        ...(pos ? {
          left: pos.x + 'px', top: pos.y + 'px',
          height: (height || 420) + 'px',
          maxHeight: 'calc(100vh - ' + (pos.y + 12) + 'px)'
        } : {})
      }}
    >
      {!narrow && <span className="cp-resize" title={t('chat.resize')} onPointerDown={startResize}></span>}
      <div className="sp-title" onPointerDown={startDrag} onDoubleClick={narrow ? undefined : () => setPos(null)}>
        {!narrow && <span className="sp-drag" title={t('chat.drag')}>⠿</span>}
        <span className="sp-t">{t('chat.title')}</span>
        <span className="cp-head-acts">
          <button title={t('chat.settings')} onClick={onOpenSettings}>⚙</button>
          <button title={t('chat.clear')} onClick={() => { setMessages([]); setReqUsage(null); setRealUsage(null); setNote(''); }}>{lang === 'zh' ? '清' : 'Clr'}</button>
          {!narrow && <button title={t('chat.close')} onClick={onClose}>✕</button>}
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
        {messages.map((m, i) => m.kind === 'summary' ? (
          <div key={i} className="chat-summary">
            <div className="chat-summary-h">
              <b>{t('chat.summaryLabel')}</b>
              <em>{t('chat.summaryNote', { n: m.count || 0 })}</em>
            </div>
            <div className="chat-summary-b">{m.content}</div>
          </div>
        ) : (
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

      <div className={'ctx-bar ' + level} title={tipText}>
        <span className="ctx-track">
          <i className="ctx-fill" style={{ width: Math.min(100, Math.round(pct * 100)) + '%' }} />
        </span>
        <span className="ctx-num">
          {ctx.formatTokens(used)}/{ctx.formatTokens(win)} · {Math.round(pct * 100)}%
          <em>{t(isReal ? 'chat.ctxReal' : 'chat.ctxEst')}</em>
        </span>
        <span className="ctx-acts">
          {note ? <span className="ctx-note">{note}</span>
            : pct >= COMPACT_AT ? <span className="ctx-hint">{t('chat.ctxNear')}</span> : null}
          <button className="ctx-compact" onClick={() => runCompact(messages, false)}
            disabled={!channel || busy || compacting || !messages.length}
            title={t('chat.compactTip')}>
            {compacting ? t('chat.compacting') + ' ' + compactSecs + 's' : t('chat.compact')}
          </button>
        </span>
      </div>

      <div className="chat-input">
        <textarea
          ref={taRef}
          value={input}
          placeholder={externalBusy ? t('diag.fixing') : (channel ? t('chat.phReady') : t('chat.phNoChannel'))}
          disabled={externalBusy}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
        />
        <div className="chat-input-acts">
          {busy
            ? <button className="btn sm" onClick={() => abortRef.current && abortRef.current.abort()}>{t('chat.stop')}</button>
            : <button className="btn sm primary" onClick={send} disabled={!channel || externalBusy}>{t('chat.send')}</button>}
        </div>
      </div>
    </aside>
  );
}

// 指针捕获 + 全屏遮罩接管指针：快速拖动甩离把手、越过预览 iframe 或移出窗口时事件不丢失
function beginPointerDrag(e, cursor, onMove) {
  const handle = e.currentTarget;
  const pointerId = e.pointerId;
  const move = (ev) => onMove(ev);
  const finish = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    window.removeEventListener('blur', finish);
    if (handle.hasPointerCapture && handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    document.body.classList.remove('cp-dragging');
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
  window.addEventListener('blur', finish);
  document.body.style.userSelect = 'none';
  document.body.style.cursor = cursor;
  document.body.classList.add('cp-dragging');
  try { handle.setPointerCapture(pointerId); } catch (err) { /* 捕获失败时由遮罩兜底 */ }
  e.preventDefault();
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

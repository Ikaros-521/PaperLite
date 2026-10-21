import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLang, useT } from '../useI18n.js';
import * as ctx from '../context.js';
import { showAlert as alert, showConfirm } from '../dialogs.js';
import { stripToolBlocks, parseToolCalls } from '../workspace/agentTools.js';
import { renderChatMarkdown, splitChatBlocks } from '../engines/markdown.js';
import { runAgentLoop, agentSystemPrompt, AGENT_APPROVALS } from '../workspace/agentRuntime.js';
import { dropTurn, editResend, MAX_SESSIONS } from '../workspace/chatSessions.js';
import { thinkingSwitch } from '../llm.js';

/* AI 对话面板：多渠道选择、上下文范围（选区/段落/全文/检索增强）、流式输出（含思维链）、
 * 代码块操作（复制 / 替换选区 / 插入光标 / 替换全文）、外部提示词注入（诊断点一键修复、
 * 划词翻译/润色的自动发送）、上下文用量状态栏（实测/估算）与压缩（模型摘要，失败回退本地裁剪）。
 * Agent 模式（agentEnv 可用时）：模型经文本协议调用工具（读项目/搜索/改文档），循环执行直到完成。
 * 载荷装配与 token 口径统一在 context.js，agent 工具调用共用同一预算。 */
const KEEP_TURNS = 6;      // 压缩时保留末尾条数
const COMPACT_AT = 0.85;   // 达到窗口该比例时提示并可自动压缩
const NEAR_BOTTOM = 80;    // 距底部小于此像素才视为「贴着底部」，自动跟随只在这个范围内生效
const PLAN_OPEN_KEY = 'paperlite.chat.planOpen.v1';   // 计划卡折叠偏好（跨会话保留）
const RECT_KEY = 'paperlite.chat.rect.v1';            // 浮窗位置 / 宽高（刷新后回原处）

// scrollHeight 会随流式增长，所以这个值必须在滚动发生的那一刻读，不能缓存
const gapToBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight;

// 与拖拽时同一套边界：标题栏至少留 60px 在视口里，否则浮窗拖不回来
const clampPanelPos = (p, w) => ({
  x: Math.min(Math.max(p.x, 60 - w), Math.max(60, window.innerWidth - 60)),
  y: Math.min(Math.max(p.y, 8), Math.max(8, window.innerHeight - 44))
});

const readPanelRect = () => {
  try {
    const s = JSON.parse(localStorage.getItem(RECT_KEY) || 'null');
    if (!s || typeof s !== 'object') return null;
    const width = Number.isFinite(s.width)
      ? Math.min(Math.max(s.width, 300), Math.max(300, Math.min(960, window.innerWidth - 80)))
      : null;
    const height = Number.isFinite(s.height) ? s.height : null;
    const pos = s.pos && Number.isFinite(s.pos.x) && Number.isFinite(s.pos.y)
      ? clampPanelPos(s.pos, width || 360)
      : null;
    return { pos, width, height };
  } catch (e) { return null; }
};

export default function ChatPanel({ open, onClose, channels, activeChannelId, setActiveChannelId, setChannels = null, onOpenSettings, buildContext, messages, setMessages, inject, onBeforeApply, narrow = false, externalBusy = false, agentEnv = null, agentCfg = null, onAgentApproval = null, onBusyChange = null, sessions = null, activeSessionId = '', onNewSession = null, onSwitchSession = null, onDeleteSession = null, onForkSession = null }) {
  const t = useT();
  const lang = useLang();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState('selection');
  const [mode, setMode] = useState('chat');   // 'chat' 普通对话 | 'agent' 工具代理
  const [showReasoning, setShowReasoning] = useState({});
  // 刷新后回到上次的浮窗几何；移动端（narrow）填满容器，不读这份
  const [savedRect] = useState(() => (narrow ? null : readPanelRect()));
  const [pos, setPos] = useState(savedRect ? savedRect.pos : null);      // null=停靠右侧；{x,y}=浮动位置（同样式面板）
  const [width, setWidth] = useState(savedRect ? savedRect.width : null);  // null=默认 360；左缘可拉伸
  const [height, setHeight] = useState(savedRect ? savedRect.height : null);
  const [reqUsage, setReqUsage] = useState(null); // 最近一次请求装配出的分类用量
  const [realUsage, setRealUsage] = useState(null); // 服务端返回的实测 usage（缺省则用估算）
  const [compacting, setCompacting] = useState(false);
  const [compactSecs, setCompactSecs] = useState(0);
  const [note, setNote] = useState('');   // 状态栏短暂提示（压缩结果等）
  const [agentTask, setAgentTask] = useState(null);  // 本轮 Agent 的任务状态（计划卡与回滚入口）
  const [showSessions, setShowSessions] = useState(false);  // 会话列表浮层
  // 计划卡默认展开，但可以折成一行——它压着对话区，长任务跑完更没必须一直摊开
  const [planOpen, setPlanOpen] = useState(() => {
    try { return localStorage.getItem(PLAN_OPEN_KEY) !== '0'; } catch (e) { return true; }
  });
  const planPhaseRef = useRef('');
  const manualPlanRef = useRef(false);   // 本轮里用户手动折/展过 → 不再自动改它的状态
  const abortRef = useRef(null);
  const noteTimer = useRef(null);
  const listRef = useRef(null);
  const stickRef = useRef(true);   // 是否跟随到底部（用户上滚超出阈值即关闭）
  const holdRef = useRef(false);   // 指针按住中：拖滚动条 / 选文本时不抢滚动
  const lastStRef = useRef(0);     // 最后一次「我们或用户」放下的滚动位置
  const taRef = useRef(null);
  const panelRef = useRef(null);
  const busyRef = useRef(false);          // inject 自动发送时读最新 busy，不依赖 state 时机
  const sendRef = useRef(null);           // send 声明在下面，effect 里经 ref 取最新实现

  // 面板忙（对话 / agent 循环 / 上下文压缩）要报给宿主：AI 修复队列是另一条独立的
  // LLM 通道，两边同时跑等于双份 token，而且都会往同一个消息数组写
  useEffect(() => { if (onBusyChange) onBusyChange(busy || compacting); }, [busy, compacting, onBusyChange]);

  // 拖动 / 拉伸时每个 pointermove 都在改 state，落盘做防抖。
  // 停靠（pos=null）也算一种状态：双击标题回停靠后刷新仍是停靠。
  useEffect(() => {
    if (narrow) return undefined;
    const timer = setTimeout(() => {
      try {
        if (pos || width || height) localStorage.setItem(RECT_KEY, JSON.stringify({ pos, width, height }));
        else localStorage.removeItem(RECT_KEY);
      } catch (e) { /* 存不下只是下次回到默认位置 */ }
    }, 300);
    return () => clearTimeout(timer);
  }, [narrow, pos, width, height]);

  // 窗口变小后，上次的坐标可能把标题栏推出视口，拖都拖不回来
  useEffect(() => {
    if (narrow) return undefined;
    const onResize = () => {
      const w = panelRef.current ? panelRef.current.offsetWidth : (width || 360);
      setPos(p => (p ? clampPanelPos(p, w) : p));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [narrow, width]);

  const channel = useMemo(
    () => channels.filter(c => c.id === activeChannelId)[0] || channels[0] || null,
    [channels, activeChannelId]
  );

  // 用户把视图往上推走 = 想回看，关掉跟随；推回来落在阈值内 = 想跟上，重新跟随。
  // 参照物是 lastStRef（我们上次放下的位置）而不是「上一个滚动事件的值」：滚动事件是异步
  // 派发的，流式跳底会先一步把用户那次上滚盖掉，等事件真的到了，位置已经是我们写回去的底部，
  // 只看事件流会漏判（触屏惯性、键盘、无按压的拖动都是这条路径）。
  const syncStick = (el) => {
    const st = el.scrollTop;
    const near = gapToBottom(el) <= NEAR_BOTTOM;
    if (st < lastStRef.current - 2) { if (!near) stickRef.current = false; }
    else if (st > lastStRef.current + 2 && near) stickRef.current = true;
    lastStRef.current = st;
  };

  const followBottom = (el) => {
    el.scrollTop = el.scrollHeight;
    lastStRef.current = el.scrollTop;
  };

  // 流式回复每个增量都会换一次 messages 引用，无条件跳底会把上滚回看的用户一直拽回底部。
  // 先吸收掉两次渲染之间用户可能做过的滚动，再决定要不要跟随；按住指针时一律不跳。
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    syncStick(el);
    if (stickRef.current && !holdRef.current) followBottom(el);
  }, [messages]);

  // 默认走 Agent 模式：桌面挂上 agentEnv 就以工具代理为先（能读项目、能改文档），
  // 用户手动切过钮之后就不再自动改它。移动端不传 agentEnv，自然留在普通对话。
  const touchedModeRef = useRef(false);
  useEffect(() => {
    if (agentEnv && !touchedModeRef.current) setMode('agent');
  }, [agentEnv]);

  // 内层的代码块 / 思维链 / 工具结果都是自己的滚动区，且都在列表内部，所以监听挂在捕获
  // 阶段；处理函数只读列表自身的位置，内层那些滚动事件因此等同于没发生。
  useEffect(() => {
    const el = listRef.current;
    if (!el) return undefined;
    const onScroll = () => syncStick(el);
    lastStRef.current = el.scrollTop;
    el.addEventListener('scroll', onScroll, true);
    return () => el.removeEventListener('scroll', onScroll, true);
  }, [open]);

  // 指针离开列表（在列表外松开、或浏览器丢事件）也要解除按住，否则跟随会永久关掉。
  // onPointerUp 挂在列表上收不到列表外的松开事件，所以用窗口级监听兜底。
  useEffect(() => {
    const release = () => {
      if (!holdRef.current) return;
      holdRef.current = false;
      const el = listRef.current;
      // 松手只看「跟随」这个意图，不按实时 gap 重算：按住不动时流式高度照样会把 gap 顶过
      // 阈值，那是内容长出来的，不是用户离开了底部（真滚动已经由 syncStick 关掉跟随了）
      if (el && stickRef.current) followBottom(el);
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('blur', release);
    };
  }, []);

  // 外部注入提示词：诊断红点预填并聚焦；划词翻译/润色自动发送（auto 为完整问题文本）。
  // scope/mode 顺带切换（如划词动作强制 selection/chat）——注意 setScope/setMode 是
  // 异步的，自动发送当拍就要用，因此把 scope 与 mode 都作为覆盖参数传给 send，不吃旧闭包值。
  useEffect(() => {
    if (inject && inject.n) {
      if (inject.scope) setScope(inject.scope);
      if (inject.mode) setMode(inject.mode);
      if (inject.auto) {
        // 对话进行中不自动发送：文本落进输入框，本轮结束后手动发送，不静默丢弃
        if (!busyRef.current && sendRef.current) sendRef.current(inject.auto, { scope: inject.scope, mode: inject.mode });
        else setInput(inject.auto);
        return;
      }
      setInput(inject.text || '');
      setTimeout(() => {
        const ta = taRef.current;
        if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      }, 60);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // 移动端聊天是路由页：离开页面时组件卸载，进行中的流式请求若不中止，
  // 回调会继续打到已卸载组件（桌面常驻挂载，不受影响）
  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  // 压缩是同步等待的一次模型请求，慢渠道要让用户看到已经过了多久
  useEffect(() => {
    if (!compacting) { setCompactSecs(0); return undefined; }
    const iv = setInterval(() => setCompactSecs(s => s + 1), 1000);
    return () => clearInterval(iv);
  }, [compacting]);

  // 整体发布消息数组时，要保住这条路径「没见过」的气泡（AI 修复队列的 fixId 气泡）：
  // 裸 setMessages(list) 会把等待期间由 App 追加的修复气泡整段冲掉，之后 patchMsg 按
  // fixId 找不到目标全部空转 —— 修复照跑、token 照花，界面上一个字都不显示。
  // 必须声明在下面的 `if (!open) return null` 之前：hook 数量随开合变化会直接崩掉 React
  const publish = useCallback((list) => setMessages(prev => {
    const have = new Set(list.filter(m => m && m.fixId).map(m => m.fixId));
    const missing = prev.filter(m => m && m.fixId && !have.has(m.fixId));
    return missing.length ? list.concat(missing) : list;
  }), [setMessages]);

  // 对话与任务状态的落库在宿主侧（useChatSessions 是会话的唯一所有者）：
  // 面板只负责改 messages，不自己决定「存哪、存几份、什么时候淘汰」。

  // 任务收口后自动折成一行：计划卡的价值在执行中（看进度、看哪步被拦），
  // 跑完还摊着半屏就是挡对话区。用户在收口后手动展开过，就不再自动折。
  useEffect(() => {
    const phase = (agentTask && agentTask.phase) || '';
    const prev = planPhaseRef.current;
    planPhaseRef.current = phase;
    if (!phase || phase === prev) return;
    if ((phase === 'completed' || phase === 'tripped') && !manualPlanRef.current) setPlanOpen(false);
  }, [agentTask]);

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
    publish(next);
    setRealUsage(null);
    setReqUsage(null);
    flashNote(t(auto ? 'chat.compactAuto' : 'chat.compactDone', {
      n: split.head.length,
      saved: ctx.formatTokens(Math.max(0, before - after))
    }));
    return next;
  };

  // ---- Agent 模式：模型经文本协议调工具，循环执行直到给出最终回答 ----
  const runAgent = async (q) => {
    const brief = agentEnv.buildBrief();
    const plan = !agentCfg || agentCfg.plan !== false;
    setReqUsage(null);
    setRealUsage(null);
    setAgentTask(null);
    manualPlanRef.current = false;   // 新一轮开始时，收口自动折叠的许可重新生效
    setBusy(true); busyRef.current = true;
    const ac = new AbortController();
    abortRef.current = ac;
    publish(messages.concat([{ role: 'user', content: q }]));
    try {
      const { usage, task, answer } = await runAgentLoop({
        channel,
        messages: messages.concat([{ role: 'user', content: q }]),
        system: agentSystemPrompt({ withTaskTools: plan }) + (plan ? t('agent.planRules') : ''),
        docHeader: t('ai.agentCtxHeader'),
        doc: brief,
        summaryHeader: t('ai.summaryHeader'),
        budget,
        maxSteps: agentCfg && agentCfg.maxSteps,
        keepResults: agentCfg && agentCfg.keepResults,
        execute: agentEnv.execute,
        approval: agentCfg && agentCfg.approval,
        requestApproval: agentEnv.requestApproval,
        plan,
        activePath: agentEnv.activePath,
        onTask: setAgentTask,
        onUpdate: publish,
        signal: ac.signal,
      });
      setRealUsage(usage || null);
      if (task) {
        persistTask(task);
        // 评审是额外一整轮请求（实测 ~700 token），要能被「停止」掐掉：
        // 复用本轮的 AbortController，它到 finally 才被清空
        if (agentCfg && agentCfg.review) await runReview(task, answer, ac.signal);
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        setMessages(ms => ms.map((m, i) => i === ms.length - 1 && !m.content
          ? { ...m, content: t('chat.reqFailed', { msg: e.message || e }) }
          : m));
      }
    } finally {
      setBusy(false); busyRef.current = false;
      abortRef.current = null;
    }
  };

  // 验收评审：换一个只读的会话问「目标覆盖了吗、过程干净吗、结论可信吗」。
  // 失败只落一条说明——已经做完的任务不该因为评审挂了而看起来失败了。
  const runReview = async (task, answer, signal) => {
    if (!channel) return;
    const note = { role: 'assistant', kind: 'review', running: true, content: '', review: null, usage: null };
    setMessages(ms => ms.concat([note]));
    try {
      const { runReview: rr } = await import('../workspace/agentReview.js');
      const r = await rr({ channel, task, finalAnswer: answer, signal });
      setMessages(ms => ms.map((m, i) => i === ms.length - 1 && m.kind === 'review' && m.running
        ? { ...m, running: false, review: r.verdict, content: r.text, usage: r.usage } : m));
      flashNote(t('agent.reviewUsage', { n: ctx.formatTokens(r.usage ? (r.usage.input + r.usage.output) : 0) }));
    } catch (e) {
      // 用户按停止：这条评审卡就地关掉，不算任务失败（正文已经交付完了）
      const text = e && e.name === 'AbortError' ? t('llm.cancelled') : t('agent.reviewFailed', { msg: e.message || String(e) });
      setMessages(ms => ms.map((m, i) => i === ms.length - 1 && m.kind === 'review' && m.running
        ? { ...m, running: false, content: text } : m));
    }
  };

  // 任务状态与审计落库（阶段三的 IndexedDB）；关掉开关时 persistTask 自己会跳过
  const persistTask = async (task) => {
    if (!agentCfg || agentCfg.persist === false) return;
    try {
      const { saveTask, saveCase } = await import('../workspace/taskStore.js');
      await saveTask(task);
      // 失败/熔断的任务才进案例库：成功任务的复盘价值低，却要把整条链路写进库里
      if (task.phase === 'failed' || task.phase === 'tripped') await saveCase(task);
    } catch (e) { /* 存不下不影响这轮回答，界面上也不报错 */ }
  };

  // 回滚到某个子任务的起点：内容整体替换回那一版，当前内容先记一条 beforeRestore
  const rollbackTo = async (snap) => {
    if (!agentEnv || !agentEnv.restore || busy) return;
    const files = snap && snap.files ? Object.entries(snap.files).filter(([, id]) => id) : [];
    if (!files.length) { flashNote(t('agent.snapshotNone', { n: snap.step })); return; }
    if (!await showConfirm(t('agent.rollbackConfirm', { n: files.length, step: snap.step }))) return;
    const r = await agentEnv.restore(Object.fromEntries(files));
    if (r.restored) flashNote(t('agent.rollbackDone', { n: r.restored, step: snap.step }));
    if (r.missing && r.missing.length) flashNote(t('agent.rollbackPartial', { list: r.missing.join(', ') }));
    else if (!r.restored) flashNote(t('agent.rollbackFail'));
  };

  // 思维链唯一开关：改的是「这个渠道」的配置，设置弹窗不再提供重复入口，
  // 关掉时对支持的渠道还会发显式关闭字段（见 llm.js 的 disableThinking）。
  // 切换后清掉用量：cot 影响输出预留比例，旧数字对新口径没有意义。
  const toggleCot = () => {
    if (!channel || !setChannels) return;
    setChannels(cs => (cs || []).map(c => (c.id === channel.id ? { ...c, cot: !c.cot } : c)));
    setReqUsage(null); setRealUsage(null);
  };

  const send = async (preset, opts) => {
    // preset 只接受字符串：onClick={send} 会把事件对象传进来，绝不能当成提问文本
    const q = (typeof preset === 'string' ? preset : input).trim();
    // compacting 也要挡：压缩完成时的 setMessages(旧快照) 会整段覆盖，
    // 压缩期间发出的消息与流式回复会被吞掉
    if (!q || busy || compacting || externalBusy) return;
    if (!channel) { alert(t('chat.needChannel')); onOpenSettings(); return; }
    setInput('');
    setNote('');
    // 发送是用户主动动作：无条件回到底部并恢复跟随（上滚关掉的跟随在这里重新打开）
    stickRef.current = true; holdRef.current = false;
    // 自动发送的注入会带 scope/mode 覆盖（setScope/setMode 要下一拍才生效，不能吃旧闭包值）
    const useMode = (opts && opts.mode) || mode;
    if (useMode === 'agent' && agentEnv) return runAgent(q);
    const useScope = (opts && opts.scope) || scope;
    // 进异步段前先置忙：buildContext（检索范围走网络）与自动压缩都有长 await 窗口，
    // 期间 inject 自动发送按 busyRef 判忙会二次进入，两个 send 互相覆盖消息
    setBusy(true); busyRef.current = true;
    try {
    const pack = await buildContext(useScope, q, channel);
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
    const ac = new AbortController();
    abortRef.current = ac;
    publish(history.concat([{ role: 'assistant', content: '', reasoning: '' }]));
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
    }
    } catch (e) {
      // 上下文构建 / 自动压缩段的异常：此前以 unhandled rejection 沉默失败
      flashNote(t('chat.reqFailed', { msg: e.message || e }));
    } finally {
      setBusy(false); busyRef.current = false;
      abortRef.current = null;
    }
  };
  sendRef.current = send;   // inject 自动发送经 ref 取最新闭包（messages/busly 都是当次渲染值）

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

  // 复制失败（非安全上下文、权限被拒）不该抛未捕获的 rejection：给一句提示
  const copy = (text) => {
    const done = () => flashNote(t('chat.copied'));
    if (!navigator.clipboard || !navigator.clipboard.writeText) { flashNote(t('chat.copyFailed')); return; }
    Promise.resolve(navigator.clipboard.writeText(text)).then(done, () => flashNote(t('chat.copyFailed')));
  };

  // 消息级操作。删除与编辑重发都走 chatSessions 的同一套「轮次」语义：
  // 点用户提问 = 连着它后面那段回答与工具回执一起处理，点回答 = 只动那一条。
  const removeMessage = async (i) => {
    if (busy || !messages[i]) return;
    const turn = messages[i].role === 'user' && !messages[i].kind;
    if (!await showConfirm(t(turn ? 'chat.deleteTurnConfirm' : 'chat.deleteOneConfirm'))) return;
    publish(dropTurn(messages, i));
  };
  const resendAt = async (i) => {
    if (busy || !messages[i]) return;
    const r = editResend(messages, i);
    publish(r.list);
    setInput(r.text);
    stickRef.current = true;
    setTimeout(() => { const ta = taRef.current; if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }, 60);
  };
  const forkAt = async (i) => {
    if (!onForkSession) return;
    await onForkSession(i);
    flashNote(t('chat.forked'));
  };
  const removeSession = async (s) => {
    if (busy || !onDeleteSession) return;
    if (!await showConfirm(t('chat.deleteSessionConfirm', { title: s.title || t('chat.sessionUntitled') }))) return;
    await onDeleteSession(s.id);
  };
  const when = (ts) => (ts ? new Date(ts).toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
  // 折叠偏好跨会话保留：这是界面习惯，不是本轮任务状态
  const foldPlan = (v) => { setPlanOpen(v); manualPlanRef.current = true; try { localStorage.setItem(PLAN_OPEN_KEY, v ? '1' : '0'); } catch (e) { /* 存不下只是下次回到默认 */ } };
  const argsTip = (s) => (s.length > 3000 ? s.slice(0, 3000) + '…' : s);

  // 正文里的 ```tool 块渲染为「工具调用」卡片（执行状态看紧随的 tool-result 卡片）；
  // 先统一 strip：流式中未闭合的 tool 块也不会把半截 JSON 露到正文
  const renderWithTools = (text, asMd) => {
    const { calls } = parseToolCalls(text);
    const stripped = stripToolBlocks(text);
    if (!calls.length) return renderBlocks(stripped, asMd);
    return (
      <>
        {stripped ? renderBlocks(stripped, asMd) : null}
        {calls.map((c, ci) => {
          const args = JSON.stringify(c.args || {});
          return (
            <div key={'tool' + ci} className="chat-tool-call">
              <span className="ctc-gear">⚙</span>
              <code>{c.tool}</code>
              {/* 参数只占一行，完整内容交给悬浮；不截断的话一次编辑的正文能把整屏糊住 */}
              <span className="ctc-args" title={argsTip(args)}>{args}</span>
            </div>
          );
        })}
      </>
    );
  };

  // 模型回复走 Markdown；用户气泡不走——本项目正文全是 LaTeX，`_` 与 `$`
  // 会被当成斜体和公式吃掉，把提问渲染坏比少个粗体严重得多。
  // 「替换选区/替换全文」只对 LaTeX 围栏给（含裸围栏），json/bash 那两类按钮是噪音
  const renderBlocks = (text, asMd) => splitChatBlocks(text).map((b, bi) => {
    if (b.type === 'code') {
      return (
        <div key={'c' + bi} className="chat-code">
          <pre>{b.text}</pre>
          <div className="chat-code-acts">
            <button onClick={() => copy(b.text)}>{t('chat.copy')}</button>
            {b.tex ? <button onClick={() => applyBlock(b.text, 'replaceSel')}>{t('chat.replaceSel')}</button> : null}
            {b.tex ? <button onClick={() => applyBlock(b.text, 'replaceDoc')}>{t('chat.replaceDoc')}</button> : null}
            {!b.tex && b.lang ? <span className="cca-lang">{b.lang}</span> : null}
          </div>
        </div>
      );
    }
    if (!b.text.trim()) return null;
    return asMd
      ? <div key={'t' + bi} className="chat-md" dangerouslySetInnerHTML={{ __html: renderChatMarkdown(b.text) }} />
      : <div key={'t' + bi} className="chat-plain">{b.text}</div>;
  });

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
          {sessions && sessions.length > 0 && (
            <button title={t('chat.sessions')} aria-expanded={showSessions ? 'true' : 'false'}
              className={showSessions ? 'on' : ''}
              onClick={() => setShowSessions(v => !v)}>🗂</button>
          )}
          <button title={t('chat.settings')} onClick={onOpenSettings}>⚙</button>
              <button
                title={t('chat.clear')}
                disabled={busy || compacting || externalBusy}
                onClick={() => { setMessages([]); setReqUsage(null); setRealUsage(null); setNote(''); setAgentTask(null); }}
              >{lang === 'zh' ? '清' : 'Clr'}</button>
          {!narrow && <button title={t('chat.close')} onClick={onClose}>✕</button>}
        </span>
      </div>

      {/* 会话列表：切换 / 新建 / 删除。刻意做小——超过上限由宿主按最近使用时间自动
          淘汰当前会话以外的旧会话，历史管理是「回头找那一句」，不是网盘。 */}
      {showSessions && sessions && sessions.length > 0 && (
        <div className="chat-sessions">
          <div className="cs-head">
            <b>{t('chat.sessionsTitle')}</b>
            <button className="btn sm" disabled={busy || !onNewSession}
              onClick={async () => { if (onNewSession) { await onNewSession(); setAgentTask(null); } setShowSessions(false); }}>
              ＋ {t('chat.newSession')}
            </button>
            <span className="cs-hint">{t('chat.sessionsHint', { n: sessions.length, max: MAX_SESSIONS })}</span>
          </div>
          <ul className="cs-list">
            {sessions.map(s => (
              <li key={s.id} className={s.id === activeSessionId ? 'on' : ''}>
                <button className="cs-item" title={s.title} disabled={busy}
                  onClick={() => { if (onSwitchSession) onSwitchSession(s.id); setShowSessions(false); }}>
                  <span className="cs-t">{s.title}</span>
                  <span className="cs-m">{t('chat.sessionMsgs', { n: s.count })} · {when(s.updatedAt)}</span>
                </button>
                <button className="cs-del" title={t('chat.deleteSession')} disabled={busy} onClick={() => removeSession(s)}>✕</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 任务状态面板：计划、每步的交付物与完成判定、快照回滚入口。
          它是框架持有的状态，不是模型自述——所以模型说「我做完了」不算，标记要落在计划上。 */}
      {mode === 'agent' && agentTask && agentTask.steps && agentTask.steps.length ? (
        <div className={'agent-plan' + (planOpen ? '' : ' folded')}>
          <div className="ap-head">
            <button className="ap-fold" aria-expanded={planOpen ? 'true' : 'false'}
              title={t(planOpen ? 'agent.planFold' : 'agent.planExpand')}
              onClick={() => foldPlan(!planOpen)}>{planOpen ? '▾' : '▸'}</button>
            <b>{t('agent.planCard')}</b>
            <span className="ap-count">{agentTask.steps.filter(s => s.status === 'done').length}/{agentTask.steps.length}</span>
            <span className="ap-phase">{t('agent.planPhase', { phase: t('agent.phase.' + agentTask.phase) })}</span>
            <span className="ap-quota" title={t('agent.planQuotaTip')}>
              {t('agent.planCalls')} {agentTask.counters.calls} · {t('agent.planWrites')} {agentTask.counters.writes} · {t('agent.planBlocked')} {agentTask.counters.blocked}
            </span>
          </div>
          {planOpen && (
            <>
              <ol className="ap-steps">
                {agentTask.steps.map(s => (
                  <li key={s.n} className={'ap-step ' + s.status + (s.n === agentTask.currentStep ? ' cur' : '')}>
                    <span className="ap-mark">{({ done: '✓', doing: '▶', blocked: '!', skipped: '–' })[s.status] || '○'}</span>
                    <span className="ap-title">{s.n}. {s.title}</span>
                    <span className="ap-st">{t('agent.plan' + s.status[0].toUpperCase() + s.status.slice(1))}</span>
                    <div className="ap-meta">
                      {s.deliverable}｜{s.doneWhen}
                      {s.deps && s.deps.length ? ' ← ' + s.deps.join(', ') : ''}
                      {s.note ? ' · ' + s.note : ''}
                    </div>
                  </li>
                ))}
              </ol>
              {agentTask.snapshots && agentTask.snapshots.length ? (
                <div className="ap-rolls">
                  {agentTask.snapshots.map((sn, si) => (
                    <button key={si} className="btn sm" disabled={busy || !agentEnv.restore}
                      title={t('agent.rollbackTip')} onClick={() => rollbackTo(sn)}>
                      ⟲ {t('agent.rollbackTo', { n: sn.step })}
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      <div
        className="chat-list"
        ref={listRef}
        onWheel={e => { if (e.deltaY < 0) stickRef.current = false; }}
        onPointerDown={() => { holdRef.current = true; }}
      >
        {!messages.length && (
          channel ? (
            <div className="chat-empty">
              <div className="chat-suggest-h">{t('chat.try')}</div>
              {(mode === 'agent' && agentEnv
                ? [t('agent.sug1'), t('agent.sug2'), t('agent.sug3')]
                : [t('chat.sug1'), t('chat.sug2'), t('chat.sug3')]
              ).map(s => (
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
        ) : m.kind === 'tool-result' ? (() => {
          const a = JSON.stringify(m.args || {});
          return (
            <div key={i} className={'chat-tool-result' + (m.running ? ' running' : m.ok ? '' : ' bad')}>
              <div className="ctr-head">
                <span>{m.running ? '⏳' : (m.ok ? '✅' : '❌')} {t('agent.toolRan')} <code>{m.tool}</code></span>
                <span className="ctr-args" title={argsTip(a)}>{a.slice(0, 140)}</span>
                {m.content ? <button className="ctr-copy" title={t('chat.copyResult')} onClick={() => copy(String(m.content))}>⧉</button> : null}
              </div>
              <pre className="ctr-body">{String(m.content || '').slice(0, 1500)}</pre>
            </div>
          );
        })() : m.kind === 'agent-limit' ? (
          <div key={i} className="chat-agent-limit">{m.content}</div>
        ) : m.kind === 'review' ? (
          <div key={i} className={'chat-review' + (m.running ? ' running' : m.review && m.review.goalOk && m.review.processOk && m.review.qualityOk ? ' ok' : ' warn')}>
            <div className="cr-head">
              <b>{t('agent.reviewTitle')}</b>
              {m.running ? <em>{t('agent.reviewRunning')}</em>
                : m.usage ? <em>{t('agent.reviewUsage', { n: ctx.formatTokens(m.usage.input + m.usage.output) })}</em> : null}
              {m.content ? <button className="ctr-copy" title={t('chat.copyResult')} onClick={() => copy(String(m.content))}>⧉</button> : null}
            </div>
            {!m.running && m.review ? (
              <ul className="cr-list">
                <li className={m.review.goalOk ? 'good' : 'bad'}>
                  {m.review.goalOk ? t('agent.reviewGoalOk') : t('agent.reviewGoalBad')}
                  {m.review.missing && m.review.missing.length ? ' ' + m.review.missing.join('；') : ''}
                </li>
                <li className={m.review.processOk ? 'good' : 'bad'}>
                  {m.review.processOk ? t('agent.reviewProcessOk') : t('agent.reviewProcessBad')}
                  {m.review.processIssues && m.review.processIssues.length ? ' ' + m.review.processIssues.join('；') : ''}
                </li>
                <li className={m.review.qualityOk ? 'good' : 'bad'}>
                  {m.review.qualityOk ? t('agent.reviewQualityOk') : t('agent.reviewQualityBad')}
                  {m.review.qualityIssues && m.review.qualityIssues.length ? ' ' + m.review.qualityIssues.join('；') : ''}
                </li>
              </ul>
            ) : !m.running ? (
              <div className="cr-body">{m.content ? (m.review ? m.content : t('agent.reviewNoVerdict') + ' ' + m.content) : ''}</div>
            ) : null}
          </div>
        ) : (
          <div key={i} className={'chat-msg ' + m.role}>
            {m.role === 'user' && m.ctxNote && <div className="chat-ctx">{m.ctxNote}</div>}
            {m.role === 'assistant' && m.reasoning ? (
              channel && channel.cot ? (
                (() => {
                  // 折叠态按内容片段记忆而不是消息下标：压缩/清空会让下标漂移，
                  // 展开态会串到别的消息上
                  const rk = (m.reasoning || '').slice(0, 40);
                  return (
                    <div className="chat-cot">
                      <button className="cot-toggle" onClick={() => setShowReasoning(s => ({ ...s, [rk]: !s[rk] }))}>
                        {t('chat.cotToggle')} {showReasoning[rk] ? '▾' : '▸'}
                      </button>
                      {showReasoning[rk] && <div className="cot-body">{m.reasoning}</div>}
                    </div>
                  );
                })()
              ) : (
                // 开关关着就不画思维链块，但要说清「为什么这条消息还有推理内容」：
                // 有些模型（GLM-4.5/Qwen3 默认思考、R1 只会思考）不是提示词能关掉的，
                // 不说清就等于把「状态不同步」从界面挪进了用户脑子里
                <div className="chat-cot-off" title={t('chat.cotOffWhy')}>
                  💭 {thinkingSwitch(channel && channel.chatModel)
                    ? t('chat.cotOffSwitchable', { n: m.reasoning.length })
                    : t('chat.cotOffAlways', { n: m.reasoning.length })}
                </div>
              )
            ) : null}
            {m.content ? renderWithTools(m.content, m.role === 'assistant') : busy && i === messages.length - 1 ? <span className="typing">{t('chat.thinking')}</span> : null}
            {/* 每条气泡的快捷操作：复制正文（去掉工具块）、编辑重发（只给提问）、
                从这里分一支到新会话、删除这一轮。流式进行中不给，避免边收边改列表 */}
            {!busy && (m.content || m.role === 'user') ? (
              <div className="chat-msg-acts">
                {m.content ? <button title={t('chat.copyMsg')} onClick={() => copy(stripToolBlocks(m.content))}>⧉</button> : null}
                {m.role === 'user' && !m.kind ? <button title={t('chat.editResend')} onClick={() => resendAt(i)}>✎</button> : null}
                {onForkSession && m.content ? <button title={t('chat.forkHere')} onClick={() => forkAt(i)}>⑂</button> : null}
                <button title={t('chat.deleteMsg')} onClick={() => removeMessage(i)}>🗑</button>
              </div>
            ) : null}
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
            // isComposing：输入法组合态的 Enter 是「确认候选词」不是「发送」，
            // 中文输入时回车选词会把半成品文本发出去
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
          }}
        />
        {/* 输入框下方的快捷开关条（DeepSeek 那种排布）：发这一句之前要确认的事，
            都放在视线已经停着的地方，而不是面板顶上 */}
        <div className="chat-tools">
          <select className="ct-chip" value={channel ? channel.id : ''} onChange={e => {
            setActiveChannelId(e.target.value);
            // 换渠道就换口径：旧渠道的实测/装配用量对新渠道的窗口没有意义，清掉防误导
            setReqUsage(null); setRealUsage(null);
          }} title={t('chat.chanTip')}>
            {!channels.length && <option value="">{t('chat.noChannelOpt')}</option>}
            {channels.map(c => <option key={c.id} value={c.id}>{c.name} · {c.chatModel || t('chat.noModel')}</option>)}
          </select>
          {mode === 'agent' && agentEnv ? (
            // 权限档位就地可切：跑一轮 Agent 时才发现「每次审核」在设置弹窗里，
            // 等于要么打断工作去开设置、要么整轮免确认
            onAgentApproval && (
              <select className="ct-chip" value={(agentCfg && agentCfg.approval) || 'auto'}
                onChange={e => onAgentApproval(e.target.value)}
                title={t('agent.lvTip')} disabled={busy}>
                {AGENT_APPROVALS.map(lv => <option key={lv} value={lv}>{t('agent.lv' + lv[0].toUpperCase() + lv.slice(1))}</option>)}
              </select>
            )
          ) : (
            <select className="ct-chip" value={scope} onChange={e => setScope(e.target.value)} title={t('chat.scopeTip')}>
              <option value="selection">{t('chat.scopeSel')}</option>
              <option value="paragraph">{t('chat.scopePara')}</option>
              <option value="full">{t('chat.scopeFull')}</option>
              <option value="retrieve">{t('chat.scopeRag')}</option>
            </select>
          )}
          {agentEnv && (
            <button className={'ct-chip' + (mode === 'agent' ? ' on' : '')}
              disabled={busy || externalBusy || compacting}
              onClick={() => { touchedModeRef.current = true; setMode(m => (m === 'agent' ? 'chat' : 'agent')); }}
              title={t('agent.toggleTip')}>
              🤖 {t('agent.toggle')}
            </button>
          )}
          <button className={'ct-chip' + (channel && channel.cot ? ' on' : '')}
            disabled={!channel || !setChannels || busy}
            onClick={toggleCot}
            title={channel && channel.cot ? t('chat.cotOnTip') : t('chat.cotTip')}>
            ◈ {t('chat.cotChip')}
          </button>
          <span className="ct-grow" />
          {busy
            ? <button className="btn sm" onClick={() => abortRef.current && abortRef.current.abort()}>{t('chat.stop')}</button>
            : <button className="btn sm primary" onClick={() => send()} disabled={!channel || externalBusy}>{t('chat.send')}</button>}
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

/**
 * 工作区状态机（桌面 App.jsx 与移动端 #/m 共用一份编排）。
 *
 * 为什么必须共享而不是各写一份：标签形状、脏判定、草稿落盘、historyKey 迁移
 * （草稿 → 文件时 copyHistory）、权限失效提示这些细节，两份实现迟早漂移，
 * 而漂移的代价是丢稿（audit-1 就是这类）。
 *
 * UI 相关的副作用（提示、确认、输入框、文件树刷新、切侧栏页签）全部通过 ui 注入，
 * 桌面用 <dialog> 实现，移动端用 antd-mobile 的 Dialog / 表单实现。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as fs from '../fs.js';
import { infoFor } from '../fileTypes.js';
import { validName } from '../fileActions.js';
import { downloadFile } from '../exporter.js';
import { recordVersion, copyHistory } from '../historyStorage.js';
import { samples } from '../engines/samples.js';
import { tr, getLang, detectLang } from '../i18n.js';
import { makeTab, restoreDraftTabs, persistDrafts, markDraftsStored, hasUnsavedWork, renameHistoryKey } from './tabModel.js';

/**
 * @param ui {{
 *   t: (key: string, params?: object) => string,
 *   flash: (msg: string) => void,
 *   alertBox: (msg: string) => void,
 *   confirm: (msg: string) => Promise<boolean>,
 *   prompt: (msg: string, fallback?: string) => Promise<string|null>,
 *   onTreeChanged: () => void,
 *   onSideTab: (tab: string) => void,
 * }}
 */
export function useWorkspace(ui) {
  const { t, flash, alertBox, confirm, prompt, onTreeChanged, onSideTab } = ui;

  const [tabs, setTabs] = useState(() => restoreDraftTabs(detectLang()));
  // 焦点落在最后恢复的那篇（最近编辑的）；不依赖模块级计数器，StrictMode 下会被调用两次
  const [activeId, setActiveId] = useState(() => (tabs.length ? tabs[tabs.length - 1].id : 1));
  const [activeValue, setActiveValue] = useState(() => {
    const first = tabs.length ? tabs[tabs.length - 1] : null;
    return first && first.doc ? first.doc.getValue() : '';
  });
  const [rootDir, setRootDir] = useState(null);
  const [restorePrompt, setRestorePrompt] = useState(null);
  const [historyTick, setHistoryTick] = useState(0);
  const [historyError, setHistoryError] = useState('');

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // 记录「已被清空历史时文档的内容」，避免清空后又被防抖快照写回去
  const historyClearedRef = useRef(new WeakMap());
  const flashRef = useRef(flash);
  flashRef.current = flash;

  const activeTab = useMemo(() => tabs.filter(x => x.id === activeId)[0] || null, [tabs, activeId]);
  const historyKey = activeTab?.historyKey
    || JSON.stringify([rootDir?.name || '', activeTab?.kind === 'draft' ? 'draft' : activeTab?.path]);

  // ---- 草稿自动保存：整组草稿标签各存一份。写失败必须让人看见——静默 catch 等于静默丢稿 ----
  const draftsWarnedRef = useRef(false);
  const draftMembership = tabs.filter(tab => tab.kind === 'draft').map(tab => tab.id).join(',');
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const snap = tabsRef.current;
        persistDrafts(snap);
        draftsWarnedRef.current = false;
        // 在写入的那一刻捕获各草稿的已落盘内容：渲染期执行 markDraftsStored 时
        // 重读 doc 会拿到更新的值，saved 被超前推进后 beforeunload 就不再设防
        const persisted = new Map(snap.filter(x => x.kind === 'draft' && x.doc).map(x => [x.draftId, x.doc.getValue()]));
        setTabs(ts => markDraftsStored(ts, persisted));
      } catch (e) {
        setTabs(ts => ts.map(x => x.kind === 'draft' ? { ...x, saveError: tr(getLang(), 'app.draftSaveFailed') } : x));
        if (!draftsWarnedRef.current) {
          draftsWarnedRef.current = true;
          flashRef.current(tr(getLang(), 'app.draftSaveFailed'));
        }
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [activeValue, tabs.length, draftMembership]);

  // 草稿写入失败或尚在防抖等待期间，也必须防止刷新丢稿。
  useEffect(() => {
    if (!hasUnsavedWork(tabs)) return;
    const onUnload = e => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [tabs]);

  // ---- 版本历史快照 ----
  // 失败只在历史对话框页脚常驻；超限文档（>1M 字符）每次快照都失败，对话框外
  // 也要 flash 一次，否则用户以为历史一直在积累。恢复成功后允许再次提醒。
  const histWarnedRef = useRef(false);
  const noteHistory = useCallback(result => {
    setHistoryError(result.ok ? '' : tr(getLang(), 'hist.storageError'));
    // 超上限淘汰旧版本是静默的（README 记为有意取舍），但用户必须看得见被清了几条
    if (result.ok && result.dropped) flashRef.current(tr(getLang(), 'hist.dropped', { n: result.dropped }));
    if (!result.ok && !histWarnedRef.current) {
      histWarnedRef.current = true;
      flashRef.current(tr(getLang(), 'hist.storageError'));
    } else if (result.ok) {
      histWarnedRef.current = false;
    }
    setHistoryTick(n => n + 1);
  }, []);

  const snapshot = useCallback((label = '', reason = 'manual', force = true) => {
    if (!activeTab?.doc) return false;
    const result = recordVersion(historyKey, activeTab.doc.getValue(), { label, reason, force });
    noteHistory(result);
    return result.ok;
  }, [activeTab, historyKey, noteHistory]);

  useEffect(() => {
    const doc = activeTab?.doc;
    if (!doc) return;
    let timer;
    const capture = () => {
      if (historyClearedRef.current.get(doc) === doc.getValue()) return;
      noteHistory(recordVersion(historyKey, doc.getValue()));
    };
    capture();
    const changed = () => {
      if (historyClearedRef.current.get(doc) !== doc.getValue()) historyClearedRef.current.delete(doc);
      clearTimeout(timer); timer = setTimeout(capture, 3000);
    };
    doc.on('change', changed);
    // 切标签时刷真实文档，绝不记录过期的 activeValue。cleanup 跑在新 render 之后，
    // 另存为/改名换过键的要按标签现键写，否则刚回收的草稿键会被这一下重新建出来
    const flushDoc = () => {
      const key = tabsRef.current.filter(x => x.doc === doc)[0]?.historyKey || historyKey;
      if (historyClearedRef.current.get(doc) !== doc.getValue()) recordVersion(key, doc.getValue());
    };
    window.addEventListener('pagehide', flushDoc);
    return () => { clearTimeout(timer); doc.off('change', changed); window.removeEventListener('pagehide', flushDoc); flushDoc(); };
  }, [activeTab?.doc, historyKey, noteHistory]);

  // ---- 文件夹 ----
  const openFolder = useCallback(async () => {
    try {
      const handle = await fs.pickDirectory();
      setRootDir(handle); setRestorePrompt(null);
      await fs.saveRootHandle(handle);
      onSideTab('files');
      flashRef.current(t('app.folderOpened', { name: handle.name }));
    } catch (e) {
      if (e && e.name !== 'AbortError') alertBox(t('app.openFolderFailed', { msg: e.message || e }));
    }
  }, [t, alertBox, onSideTab]);

  const closeFolder = useCallback(async () => {
    setRootDir(null); setRestorePrompt(null); await fs.clearRootHandle();
  }, []);

  const restoreFolder = useCallback(async () => {
    if (!restorePrompt) return;
    const perm = await fs.requestPermission(restorePrompt, 'readwrite');
    if (perm === 'granted') { setRootDir(restorePrompt); setRestorePrompt(null); onSideTab('files'); }
  }, [restorePrompt, onSideTab]);

  // ---- 打开文件 ----
  const openFileTab = useCallback(async (fileHandle, path, parentDir) => {
    const name = fileHandle.name || (path ? path.split('/').pop() : tr(getLang(), 'app.untitled'));
    const info = infoFor(name);
    const exist = tabsRef.current.filter(x => x.handle === fileHandle)[0];
    if (exist) { setActiveId(exist.id); return exist; }
    try {
      if (info.kind === 'image' || info.kind === 'pdf') {
        const url = await fs.fileBlobUrl(fileHandle);
        const tab = makeTab({ name, path, kind: info.kind, handle: fileHandle, parentDir, imageUrl: url });
        setTabs(ts => ts.concat([tab])); setActiveId(tab.id); setActiveValue('');
        return tab;
      }
      const text = await fs.readFileText(fileHandle);
      const tab = makeTab({
        name, path, kind: info.kind, handle: fileHandle, parentDir, text,
        modeSpec: info.mode, saved: text, historyScope: parentDir ? rootDir?.name || '' : '',
      });
      setTabs(ts => ts.concat([tab])); setActiveId(tab.id); setActiveValue(text);
      return tab;
    } catch (e) {
      alertBox(tr(getLang(), 'app.cannotOpen', { name, msg: e.message || e }));
      return null;
    }
  }, [rootDir?.name, alertBox]);

  // ---- 新建 / 复制 / 上传 ----
  const newFile = useCallback(async () => {
    let n = 1;
    const base = t('app.newFileDefault', { n: '' });
    const existNames = new Set(tabsRef.current.map(x => x.name));
    while (existNames.has(base.replace('.tex', (n > 1 ? n : '') + '.tex'))) n++;
    const input = await prompt(t('app.newFilePrompt'), base.replace('.tex', (n > 1 ? n : '') + '.tex'));
    if (!input) return;
    const name = input.trim();
    if (!validName(name)) { alertBox(t('app.badFileName')); return; }
    const info = infoFor(name);
    const tab = makeTab({ name, path: t('app.unsavedPath') + '/' + name, kind: info.kind, text: '', modeSpec: info.mode, saved: '' });
    setTabs(ts => ts.concat([tab])); setActiveId(tab.id); setActiveValue('');
    flashRef.current(t('app.created', { name }));
  }, [t, prompt, alertBox]);

  const makeCopy = useCallback(() => {
    const source = tabsRef.current.filter(x => x.id === activeId)[0];
    if (!source?.doc) return;
    const original = source.name;
    const dot = original.lastIndexOf('.');
    const base = dot > 0 ? original.slice(0, dot) : original;
    const ext = dot > 0 ? original.slice(dot) : '';
    let name = base + '-copy' + ext, n = 2;
    while (tabsRef.current.some(tab => tab.name === name)) name = base + '-copy-' + n++ + ext;
    const value = source.doc.getValue(), info = infoFor(name);
    const copy = makeTab({ name, path: t('app.unsavedPath') + '/' + name, kind: info.kind, text: value, modeSpec: info.mode, saved: '' });
    copy.dirty = !!value;
    setTabs(ts => ts.concat(copy)); setActiveId(copy.id); setActiveValue(value);
    flashRef.current(t('app.created', { name }));
  }, [activeId, t]);

  /** 上传文件：已连文件夹时写盘并打开，否则只在内存里开一个标签（移动端主路径） */
  const uploadFiles = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = true;
    input.onchange = async () => {
      for (const file of Array.from(input.files || [])) {
        try {
          if (!validName(file.name)) throw new Error(t('app.badFileName'));
          if (rootDir) {
            let exists = false;
            try { await rootDir.getFileHandle(file.name); exists = true; } catch (e) { if (e.name !== 'NotFoundError') throw e; }
            const opened = tabsRef.current.find(tab => tab.handle && tab.path === file.name);
            if ((exists || opened) && !await confirm(t('app.overwriteConfirm', { name: file.name }))) continue;
            const handle = await fs.createFile(rootDir, file.name);
            const writable = await handle.createWritable();
            await writable.write(file); await writable.close();
            if (opened) {
              if (opened.doc) {
                const value = await file.text();
                opened.doc.setValue(value);
                setTabs(ts => ts.map(x => x.id === opened.id ? { ...x, saved: value, dirty: false } : x));
              } else {
                const url = await fs.fileBlobUrl(handle);
                URL.revokeObjectURL(opened.imageUrl);
                setTabs(ts => ts.map(x => x.id === opened.id ? { ...x, imageUrl: url } : x));
              }
              setActiveId(opened.id);
            } else await openFileTab(handle, file.name, rootDir);
          } else {
            const info = infoFor(file.name);
            let uploaded;
            if (info.kind === 'image' || info.kind === 'pdf') uploaded = makeTab({ name: file.name, kind: info.kind, imageUrl: URL.createObjectURL(file) });
            else {
              const text = file.size <= 2 * 1024 * 1024 ? await file.text() : null;
              uploaded = text !== null && !text.includes('\u0000')
                ? makeTab({ name: file.name, kind: info.kind, text, modeSpec: info.mode })
                : makeTab({ name: file.name, kind: 'asset' });
            }
            uploaded.uploadedFile = file;
            setTabs(ts => ts.concat(uploaded)); setActiveId(uploaded.id); setActiveValue(uploaded.doc?.getValue() || '');
          }
        } catch (e) { alertBox(t('file.uploadFailed', { name: file.name, msg: e.message })); }
      }
      onTreeChanged();
      if (rootDir) onSideTab('files');
    };
    input.click();
  }, [t, rootDir, confirm, alertBox, openFileTab, onTreeChanged, onSideTab]);

  // ---- 另存为 ----
  const saveTabAs = useCallback(async (tab) => {
    const value = tab.doc ? tab.doc.getValue() : '';
    if (rootDir) {
      try {
        await rootDir.getFileHandle(tab.name);
        if (!await confirm(t('app.overwriteConfirm', { name: tab.name }))) return false;
      } catch (e) { /* 不存在，直接创建 */ }
      try {
        const h = await fs.createFile(rootDir, tab.name);
        setTabs(ts => ts.map(x => x.id === tab.id ? { ...x, saving: true } : x));
        await fs.writeFileText(h, value);
        const nextKey = JSON.stringify([rootDir.name, tab.name]);
        // 草稿键按 draftId 索引且只有这一个标签用，转存后标签已不是草稿 → 迁移即回收源键；
        // 未落盘标签的键是 [范围, 路径]，可能与其他同名内存标签共用，照旧只复制
        const copied = copyHistory(tab.historyKey, nextKey, { move: tab.kind === 'draft' });
        if (!copied) setHistoryError(tr(getLang(), 'hist.storageError'));
        setTabs(ts => ts.map(x => x.id === tab.id ? {
          ...x, historyKey: copied ? nextKey : x.historyKey,
          kind: x.kind === 'draft' ? infoFor(tab.name).kind : x.kind,
          handle: h, parentDir: rootDir, path: tab.name, saved: value,
          dirty: x.doc.getValue() !== value, saving: false, saveError: '',
        } : x));
        onTreeChanged();
        flashRef.current(t('app.savedToFolder', { name: tab.name }));
        return true;
      } catch (e) {
        setTabs(ts => ts.map(x => x.id === tab.id ? { ...x, saving: false, saveError: String(e.message || e) } : x));
        alertBox(t('app.saveFailed', { msg: e.message || e }));
        return false;
      }
    }
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const h = await window.showSaveFilePicker({ suggestedName: tab.name });
        setTabs(ts => ts.map(x => x.id === tab.id ? { ...x, saving: true } : x));
        await fs.writeFileText(h, value);
        const nextKey = JSON.stringify(['', h.name]);
        const copied = copyHistory(tab.historyKey, nextKey, { move: tab.kind === 'draft' });
        if (!copied) setHistoryError(tr(getLang(), 'hist.storageError'));
        setTabs(ts => ts.map(x => x.id === tab.id ? {
          ...x, historyKey: copied ? nextKey : x.historyKey,
          kind: x.kind === 'draft' ? infoFor(h.name).kind : x.kind,
          name: h.name, handle: h, path: h.name, saved: value,
          dirty: x.doc.getValue() !== value, saving: false, saveError: '',
        } : x));
        flashRef.current(t('app.saved', { name: h.name }));
        return true;
      } catch (e) {
        setTabs(ts => ts.map(x => x.id === tab.id ? { ...x, saving: false, ...(e?.name !== 'AbortError' ? { saveError: String(e.message || e) } : {}) } : x));
        if (e && e.name !== 'AbortError') alertBox(t('app.saveFailed', { msg: e.message || e }));
        return false;
      }
    }
    downloadFile(tab.name, value, 'text/plain;charset=utf-8');
    flashRef.current(t('app.downloadFallback', { name: tab.name }));
    return false;
  }, [t, rootDir, confirm, alertBox, onTreeChanged]);

  // ---- 保存当前标签 ----
  const saveActive = useCallback(async () => {
    const tab = tabsRef.current.filter(x => x.id === activeId)[0];
    if (!tab?.doc || tab.saving) return;
    const recorded = recordVersion(tab.historyKey, tab.doc.getValue(), { reason: 'save' });
    setHistoryError(recorded.ok ? '' : tr(getLang(), 'hist.storageError'));
    setHistoryTick(n => n + 1);
    if (tab.kind === 'draft') {
      try {
        persistDrafts(tabsRef.current);
      } catch (e) {
        setTabs(ts => ts.map(x => x.kind === 'draft' ? { ...x, saveError: tr(getLang(), 'app.draftSaveFailed') } : x));
        flashRef.current(tr(getLang(), 'app.draftSaveFailed'));
        return;
      }
      setTabs(ts => ts.map(x => x.kind === 'draft' && x.doc
        ? { ...x, saved: x.doc.getValue(), browserStored: true, saveError: '', dirty: x.id === tab.id ? false : x.dirty }
        : x));
      flashRef.current(tr(getLang(), 'app.draftSaved'));
      return;
    }
    if (!tab.handle) { await saveTabAs(tab); return; }
    try {
      const value = tab.doc.getValue();
      setTabs(ts => ts.map(x => x.id === tab.id ? { ...x, saving: true } : x));
      await fs.writeFileText(tab.handle, value);
      setTabs(ts => ts.map(x => x.id === tab.id ? { ...x, saved: value, dirty: x.doc.getValue() !== value, saving: false, saveError: '' } : x));
      flashRef.current(tr(getLang(), 'app.saved', { name: tab.name }));
    } catch (e) {
      setTabs(ts => ts.map(x => x.id === tab.id ? { ...x, saving: false, saveError: String(e.message || e) } : x));
      // 权限失效是最高频的一种（句柄跨会话/文件夹被移动）：给出口，别抛浏览器英文原文
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) alertBox(tr(getLang(), 'app.savePermission', { name: tab.name }));
      else alertBox(tr(getLang(), 'app.saveFailed', { msg: e.message || e }));
    }
  }, [activeId, rootDir, saveTabAs, alertBox]);

  // ---- 关闭标签 ----
  // 返回是否真正关闭：脏标签在确认框点「取消」时返回 false，调用方（如移动端
  // 删除路径）据此中止后续的「已删除」提示与撤销横幅
  const closeTab = useCallback(async (id) => {
    const tab = tabsRef.current.filter(x => x.id === id)[0];
    if (tab && tab.dirty && !await confirm(tr(getLang(), 'app.dirtyClose', { name: tab.name }))) return false;
    if (tab && tab.imageUrl) URL.revokeObjectURL(tab.imageUrl);
    setTabs(ts => {
      const rest = ts.filter(x => x.id !== id);
      if (!rest.length) {
        const text = samples.blank;
        const nt = makeTab({ name: tr(getLang(), 'app.draftName'), path: tr(getLang(), 'app.draftPath'), kind: 'draft', text, modeSpec: 'stex', saved: text });
        setActiveId(nt.id); setActiveValue(text);
        return [nt];
      }
      if (id === activeId) {
        const nt = rest[rest.length - 1];
        setActiveId(nt.id);
        setActiveValue(nt.doc ? nt.doc.getValue() : '');
      }
      return rest;
    });
    return true;
  }, [activeId, confirm]);

  /** 编辑器内容变化：脏标记 + 让旧的编译诊断失效 */
  const onDocChange = useCallback((doc, value, retireDiagnostics) => {
    retireDiagnostics?.();
    setActiveValue(value);
    setTabs(ts => ts.map(x => x.doc === doc ? { ...x, dirty: value !== x.saved } : x));
  }, []);

  /** 切标签时同步 activeValue（不依赖模块级计数器） */
  const activateTab = useCallback((id) => {
    const tab = tabsRef.current.filter(x => x.id === id)[0];
    setActiveId(id);
    if (tab?.doc) setActiveValue(tab.doc.getValue());
    else if (tab) setActiveValue('');
    return tab || null;
  }, []);

  /** 浏览器草稿：移动端「新建草稿」与桌面空态共用。立即落盘，避免改名/新建后刷新即丢 */
  const addDraft = useCallback((name, text = '') => {
    const tab = makeTab({
      name: name || tr(getLang(), 'app.draftName'),
      path: tr(getLang(), 'app.draftPath'),
      kind: 'draft', text, modeSpec: 'stex', saved: text,
    });
    setTabs(ts => {
      const next = ts.concat(tab);
      try { persistDrafts(next); } catch (e) { /* 自动保存会再报，这里不重复弹 */ }
      return next;
    });
    setActiveId(tab.id);
    setActiveValue(text);
    return tab;
  }, []);

  /**
   * 磁盘上改完名后，把所有指向旧路径的已打开标签对齐到新名字（文件树重命名走这里）。
   * 不能只按 handle 匹配：同一个文件可能分别从文件树和项目搜索打开过，两份句柄是不相等的包装对象，
   * 漏掉的那些会一直顶着旧名/旧路径——而 path 同时是 zip 导出条目名、主文档解析与搜索去重的键。
   * doc 一律不碰：改名不该丢内容，dirty/saved/saving 照旧。
   */
  const renameTabPath = useCallback((oldPath, handle, newName) => {
    const from = String(oldPath || '');
    const name = String(newName || '').trim();
    if (!from || !name) return false;
    const slash = from.lastIndexOf('/');
    const to = (slash >= 0 ? from.slice(0, slash + 1) : '') + name;
    if (to === from) return false;
    const plan = [];
    for (const tab of tabsRef.current) {
      if (!tab.handle) continue;          // 无磁盘后端的标签（草稿、未落盘的上传件）不跟着改名
      const path = tab.path || tab.name;
      const sameFile = tab.handle === handle || path === from;
      // oldPath 是文件夹：整棵子树换前缀，标签名不变
      const underDir = !sameFile && path.startsWith(from + '/');
      if (!sameFile && !underDir) continue;
      const nextPath = sameFile ? to : to + '/' + path.slice(from.length + 1);
      plan.push({
        id: tab.id, name: sameFile ? name : tab.name, path: nextPath,
        handle: sameFile && handle ? handle : tab.handle,
        fromKey: tab.historyKey, historyKey: renameHistoryKey(tab.historyKey, path, nextPath),
      });
    }
    if (!plan.length) return false;
    // 版本历史按 [文件夹, 路径] 归档，不迁移就等于改名后历史「凭空消失」（与另存为共用 copyHistory）。
    // 磁盘旧路径已经不存在，没有任何标签还会再命中旧键 → 迁移即回收，不留僵尸键占共享配额。
    // 同一旧键被多个标签共用时（同名文件开两次）第二次读到的是空源键，目标键里的版本不受影响。
    const migrated = new Map();
    let historyFailed = false;
    for (const p of plan) {
      if (!p.historyKey) continue;   // 键形状不符（草稿键）：保持原样，历史不迁移
      if (copyHistory(p.fromKey, p.historyKey, { move: true })) migrated.set(p.id, p.historyKey);
      else historyFailed = true;
    }
    if (historyFailed) setHistoryError(tr(getLang(), 'hist.storageError'));
    setTabs(ts => ts.map(tab => {
      const p = plan.filter(x => x.id === tab.id)[0];
      if (!p) return tab;
      return { ...tab, name: p.name, path: p.path, handle: p.handle, historyKey: migrated.get(p.id) || tab.historyKey };
    }));
    return true;
  }, [setHistoryError]);

  /**
   * 改名：磁盘标签先改盘、成功后才同步元数据；草稿与未落盘标签只改显示名。
   * 顺序反了会留下「标签新名 + 磁盘旧名」——保存静默写回旧文件，下轮文件夹扫描又把旧名扫回来。
   * 移动端没有文件树，这里是磁盘文件唯一的重命名通道，所以它是 async 的（调用方要 await）。
   */
  const renameTab = useCallback(async (id, name) => {
    const trimmed = String(name || '').trim();
    if (!trimmed) return false;
    if (!validName(trimmed)) { alertBox(t('app.badFileName')); return false; }
    const tab = tabsRef.current.filter(x => x.id === id)[0];
    if (!tab) return false;
    if (tab.name === trimmed) return true;
    if (tab.handle && tab.kind !== 'draft') {
      const oldPath = tab.path || tab.name;
      try {
        const handle = await fs.renameEntry(tab.handle, trimmed, tab.parentDir);
        onTreeChanged();
        return renameTabPath(oldPath, handle, trimmed);
      } catch (e) {
        alertBox(t('ft.renameFailed', { msg: e.message || e }));
        return false;
      }
    }
    setTabs(ts => {
      const next = ts.map(x => {
        if (x.id !== id) return x;
        if (x.kind === 'draft') return { ...x, name: trimmed };
        // 只换最后一段文件名：chapters/intro.tex 改名不能把子目录段抹掉
        // （path 用于主文档解析、搜索去重与 zip 导出命名，丢了前缀会全线错乱）
        const slash = x.path && x.path.lastIndexOf('/');
        const dir = slash > 0 ? x.path.slice(0, slash + 1) : '';
        return { ...x, name: trimmed, path: dir + trimmed };
      });
      try { persistDrafts(next); } catch (e) { /* 自动保存会再报 */ }
      return next;
    });
    return true;
  }, [alertBox, t, onTreeChanged, renameTabPath]);

  /** 落盘成功后推进 saved（Ctrl+S 的浏览器路径） */
  const persistNow = useCallback(() => {
    try {
      const snap = tabsRef.current;
      persistDrafts(snap);
      const persisted = new Map(snap.filter(x => x.kind === 'draft' && x.doc).map(x => [x.draftId, x.doc.getValue()]));
      setTabs(ts => markDraftsStored(ts, persisted));
      return true;
    } catch (e) {
      setTabs(ts => ts.map(x => x.kind === 'draft' ? { ...x, saveError: tr(getLang(), 'app.draftSaveFailed') } : x));
      return false;
    }
  }, []);

  return {
    tabs, setTabs, tabsRef, activeId, setActiveId, activeValue, setActiveValue, activeTab,
    rootDir, setRootDir, restorePrompt, setRestorePrompt,
    historyKey, historyTick, setHistoryTick, historyError, setHistoryError, historyClearedRef,
    noteHistory, snapshot,
    openFolder, closeFolder, restoreFolder, openFileTab,
    newFile, makeCopy, uploadFiles, saveTabAs, saveActive, closeTab,
    addDraft, renameTab, renameTabPath, persistNow,
    onDocChange, activateTab,
  };
}

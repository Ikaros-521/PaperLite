/**
 * 编译链状态机（桌面与移动端共用）。
 *
 * 只管"编译这件事"：引擎探测、内置 wasm 预热、发起/取消、结果与错误、PDF Blob 生命周期。
 * 界面反应（切预览模式、换视图、弹提示）由调用方根据返回的 status 决定，
 * 因为桌面是"切右侧面板"，移动端是"push 一个 PDF 页"，形态不同但编译语义必须一致。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { warmEngine, compileXeLaTeX, cancelCompile, onEngineStatus } from '../engines/xelatex.js';
import { collectCompileFiles } from '../compileProject.js';

/**
 * @param ui {{ t: Function, flash: Function, alertBox: Function }}
 * @param source {{ tabsRef: {current: any[]}, activeTab: any, isTexLike: boolean, autoWarm?: boolean,
 *   getEntry?: () => Promise<{source: string, name: string, parentDir: object|null, entryTabId: number|null}|null> }}
 * getEntry：多文件项目的编译入口（主文档）。返回 null 或不传时退回「当前标签」，
 * 移动端未接主文档，行为不变。
 */
export function useCompile({ t, flash, alertBox }, { tabsRef, activeTab, isTexLike, autoWarm = true, getEntry = null }) {
  const [engines, setEngines] = useState([]);
  const [engine, setEngine] = useState('builtin');
  const [builtinStatus, setBuiltinStatus] = useState('idle');
  const [compiling, setCompiling] = useState(false);
  const [compileResult, setCompileResult] = useState(null);

  const contextRef = useRef(null);
  const abortRef = useRef(null);
  const pdfUrlRef = useRef(null);
  const flashRef = useRef(flash);
  flashRef.current = flash;

  // 卸载时回收最后一个 PDF Blob URL：成功编译只会在下一次成功时 revoke，
  // 移动端路由切换会卸载本 hook，数 MB 的 blob 就此泄漏
  useEffect(() => () => { if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current); }, []);

  // 换文档即换上下文：迟到的响应不许把已经改过的稿子的错误再贴回去
  const bindDoc = useCallback(doc => {
    if (contextRef.current?.doc !== doc) contextRef.current = { doc: doc || null };
    return contextRef.current;
  }, []);
  const context = bindDoc(activeTab?.doc || null);

  // ---- 本机 TeX 引擎探测：静态托管时 fetch 失败是常态，只剩内置引擎 ----
  useEffect(() => {
    (async () => {
      let local = [];
      try {
        const r = await fetch('/api/health');
        if (r.ok) local = (await r.json()).engines || [];
      } catch (e) { /* 无本机服务 */ }
      setEngines(local.length ? [...local, 'builtin'] : ['builtin']);
      if (!local.includes('xelatex')) setEngine('builtin');
    })();
  }, []);

  useEffect(() => onEngineStatus(setBuiltinStatus), []);

  // ---- 内置 XeLaTeX：文档或导言区变化时后台预热（首次要拉约 98MB 资源）----
  // autoWarm=false 时不预拉：移动端可能在蜂窝网络下，资源只在用户真的点「开始编译」时才下载
  const warmPreamble = (activeTab?.doc ? activeTab.doc.getValue() : '').split(/\\begin\s*\{document\}/)[0];
  useEffect(() => {
    if (!autoWarm || !isTexLike) return;
    const kick = () => { warmEngine(contextRef.current?.doc?.getValue() || '').catch(() => { /* 状态已置 error，由 UI 提示 */ }); };
    let ic = null, tid = null;
    if ('requestIdleCallback' in window) ic = requestIdleCallback(kick, { timeout: 1000 });
    else tid = setTimeout(kick, 1000);
    return () => {
      if (ic !== null && 'cancelIdleCallback' in window) cancelIdleCallback(ic);
      if (tid !== null) clearTimeout(tid);
    };
  }, [autoWarm, activeTab?.doc, warmPreamble, isTexLike]);

  /** 让旧诊断失效（编辑时调用）：保留 PDF 产物，只撤错误标记 */
  const retireErrors = useCallback(() => {
    setCompileResult(r => (r ? { ...r, errors: [] } : r));
  }, []);

  /**
   * 发起编译。
   * @param {{ quiet?: boolean }} [opts] quiet = 自动编译：成功不 flash、失败不弹窗（问题栏与状态栏照常反映）
   * @returns {Promise<'ok'|'fail'|'cancelled'|'stale'|'blocked'>}
   */
  const compile = useCallback(async (opts) => {
    const quiet = !!(opts && opts.quiet);
    if (compiling) return 'blocked';
    const tab = tabsRef.current.filter(x => x.id === (activeTab?.id ?? tabsRef.current[tabsRef.current.length - 1]?.id))[0];
    if (!tab?.doc) return 'blocked';
    if (engine !== 'builtin' && !engines.includes(engine)) {
      alertBox(t('app.noEngine'));
      return 'blocked';
    }

    const owner = contextRef.current;
    // 编译入口：默认当前标签；桌面传入 getEntry 时按主文档解析（子文件标签上也从主文档走）
    let source = tab.doc.getValue();
    let entryName = tab.name;
    let entryTabId = tab.id;
    let parentDir = tab.parentDir || null;
    let entryIsTex = isTexLike;
    if (getEntry) {
      try {
        const entry = await getEntry();
        if (entry && typeof entry.source === 'string') {
          source = entry.source;
          entryName = entry.name || entryName;
          entryTabId = entry.entryTabId != null ? entry.entryTabId : null;
          parentDir = entry.parentDir != null ? entry.parentDir : parentDir;
          entryIsTex = true;
        }
      } catch (e) { /* 主文档读取失败退回当前标签 */ }
    }
    if (!entryIsTex) { flashRef.current(t('app.onlyTexCompile')); return 'blocked'; }

    setCompiling(true);
    const abort = new AbortController();
    abortRef.current = abort;
    const tabId = tab.id;
    // PDF 过期判据做成闭包随结果走：入口来自打开标签就比较其最新内容，
    // 入口来自磁盘时用「项目里有未保存修改」近似（保存过的改动无法低成本察觉）
    const staleNow = entryTabId != null
      ? () => { const et = tabsRef.current.filter(x => x.id === entryTabId)[0]; return et?.doc ? et.doc.getValue() !== source : false; }
      : () => (tabsRef.current || []).some(x => x.dirty && (!parentDir || x.parentDir === parentDir));
    retireErrors();

    try {
      let ok, pdfBytes, log, errors, errText, wasCancelled = false;
      if (engine === 'builtin') {
        const files = await collectCompileFiles({ ...tab, parentDir }, tabsRef.current);
        if (abort.signal.aborted) { flashRef.current(t('app.compileCancelled')); return 'cancelled'; }
        const r = await compileXeLaTeX(source, files);
        ok = r.ok; pdfBytes = r.pdfBytes; log = r.log || ''; errors = r.errors || [];
        wasCancelled = !!r.cancelled;
        if (!ok && !wasCancelled) errText = (errors[0] && errors[0].msg) || t('app.compileFailed');
      } else {
        const r = await fetch('/api/compile', {
          method: 'POST',
          signal: abort.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ engine, source }),
        });
        const j = await r.json();
        ok = j.ok; log = j.log || ''; errors = j.errors || [];
        if (ok) {
          const bin = atob(j.pdf);
          pdfBytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) pdfBytes[i] = bin.charCodeAt(i);
        } else errText = j.error || t('app.compileFailed');
      }

      // 迟到的响应不许覆盖已经切走/改过的文档
      if (contextRef.current !== owner) return 'stale';
      if (wasCancelled) { flashRef.current(t('app.compileCancelled')); return 'cancelled'; }

      if (ok) {
        if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
        pdfUrlRef.current = URL.createObjectURL(new Blob([pdfBytes], { type: 'application/pdf' }));
        setCompileResult({ ok: true, pdfUrl: pdfUrlRef.current, log, errors, engine, tabId, source, entryName, staleNow });
        if (!quiet) flashRef.current(t('app.compileOk', { engine: engine === 'builtin' ? t('app.builtinEngine') : engine }));
        return 'ok';
      }
      setCompileResult({ ok: false, log, errors, error: errText, engine, tabId, source, entryName, staleNow });
      return 'fail';
    } catch (e) {
      if (contextRef.current !== owner) return 'stale';
      if (abort.signal.aborted || String(e && e.message || e) === 'cancelled') { flashRef.current(t('app.compileCancelled')); return 'cancelled'; }
      if (quiet) flashRef.current(t('app.compileReqFailed', { msg: e.message || e }));
      else alertBox(t('app.compileReqFailed', { msg: e.message || e }));
      return 'fail';
    } finally {
      abortRef.current = null;
      setCompiling(false);
    }
  }, [compiling, isTexLike, engine, engines, activeTab?.id, tabsRef, t, alertBox, retireErrors, getEntry]);

  /** 拆掉 Worker 立刻归还界面，长任务不该只能干等 */
  const cancelCompileNow = useCallback(() => {
    abortRef.current?.abort();
    cancelCompile();
  }, []);

  const clearResult = useCallback(() => setCompileResult(null), []);

  return {
    engines, engine, setEngine, builtinStatus, compiling,
    compileResult, setCompileResult,
    compile, cancelCompile: cancelCompileNow, clearCompileResult: clearResult,
    retireErrors,
    /** PDF 过期判据：编译时入口源码与当前是否一致（主文档入口随结果携带闭包） */
    pdfIsStale: !!compileResult?.ok && (compileResult.staleNow ? !!compileResult.staleNow()
      : compileResult.source !== (activeTab?.doc ? activeTab.doc.getValue() : null)),
  };
}

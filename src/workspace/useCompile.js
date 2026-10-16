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
 * @param source {{ tabsRef: {current: any[]}, activeTab: any, isTexLike: boolean, autoWarm?: boolean }}
 */
export function useCompile({ t, flash, alertBox }, { tabsRef, activeTab, isTexLike, autoWarm = true }) {
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
   * @returns {Promise<'ok'|'fail'|'cancelled'|'stale'|'blocked'>}
   */
  const compile = useCallback(async () => {
    if (compiling) return 'blocked';
    if (!isTexLike) { flashRef.current(t('app.onlyTexCompile')); return 'blocked'; }
    const tab = tabsRef.current.filter(x => x.id === (activeTab?.id ?? tabsRef.current[tabsRef.current.length - 1]?.id))[0];
    if (!tab?.doc) return 'blocked';
    if (engine !== 'builtin' && !engines.includes(engine)) {
      alertBox(t('app.noEngine'));
      return 'blocked';
    }

    setCompiling(true);
    const abort = new AbortController();
    abortRef.current = abort;
    const owner = contextRef.current;
    const source = tab.doc.getValue();
    const tabId = tab.id;
    retireErrors();

    try {
      let ok, pdfBytes, log, errors, errText, wasCancelled = false;
      if (engine === 'builtin') {
        const files = await collectCompileFiles(tab, tabsRef.current);
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
        setCompileResult({ ok: true, pdfUrl: pdfUrlRef.current, log, errors, engine, tabId, source });
        flashRef.current(t('app.compileOk', { engine: engine === 'builtin' ? t('app.builtinEngine') : engine }));
        return 'ok';
      }
      setCompileResult({ ok: false, log, errors, error: errText, engine, tabId, source });
      return 'fail';
    } catch (e) {
      if (contextRef.current !== owner) return 'stale';
      if (abort.signal.aborted || String(e && e.message || e) === 'cancelled') { flashRef.current(t('app.compileCancelled')); return 'cancelled'; }
      alertBox(t('app.compileReqFailed', { msg: e.message || e }));
      return 'fail';
    } finally {
      abortRef.current = null;
      setCompiling(false);
    }
  }, [compiling, isTexLike, engine, engines, activeTab?.id, tabsRef, t, alertBox, retireErrors]);

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
    /** PDF 过期判据：编译时的源码与当前是否一致 */
    pdfIsStale: !!compileResult?.ok && compileResult.source !== (activeTab?.doc ? activeTab.doc.getValue() : null),
  };
}

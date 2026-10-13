import { createContext, useContext, useMemo } from 'react';
import { tr } from './i18n.js';

/* 双语支持的 React 侧：App 持有 lang 状态并通过 Provider 下发，
 * 组件用 useT() 取当前语言的 t 函数（lang 变化时引用更新触发重渲染）。 */

export const LangContext = createContext('zh');

export function useLang() {
  return useContext(LangContext);
}

export function useT() {
  const lang = useContext(LangContext);
  return useMemo(() => (key, params) => tr(lang, key, params), [lang]);
}

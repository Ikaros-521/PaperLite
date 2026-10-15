/* 皮肤注册表：id 与 themes.css 的 [data-theme="…"] / [data-pick="…"] 一一对应，
 * 名称是界面文案，放在 i18n 的 DICT（theme.<id>）。 */

export const LS_THEME = 'paperlite.theme.v1';
export const DEFAULT_THEME = 'ink';
export const THEME_IDS = ['ink', 'frost', 'moss', 'midnight', 'graphite', 'orchid'];

export function isTheme(id) {
  return THEME_IDS.includes(id);
}

export function detectTheme() {
  try {
    const s = localStorage.getItem(LS_THEME);
    if (isTheme(s)) return s;
  } catch (e) { /* ignore */ }
  return DEFAULT_THEME;
}

/* 涂到 <html data-theme> 上并落盘；非法 id 回退默认皮肤 */
export function applyTheme(id) {
  const next = isTheme(id) ? id : DEFAULT_THEME;
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(LS_THEME, next); } catch (e) { /* ignore */ }
  return next;
}

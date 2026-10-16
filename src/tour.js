/* 使用教程：步骤表 + 首次访问标记。
 * tourStepsFor 根据当前视图筛选步骤，并将窄窗口锚点映射到可见入口。
 * 文案位于 i18n 的 tour.*；无法定位的锚点仍可退化为居中卡片。 */

export const LS_TOUR = 'paperlite.tour.v1';
export const TOUR_VERSION = 1;

// place: top | right | bottom | left | inside（inside = 浮在锚点中央，适合大面积区域）
export const TOUR_STEPS = [
  { key: 'menus', target: '[data-tour="menubar"]', place: 'bottom', chapter: 'tour.ch.ui' },
  { key: 'rightbar', target: '.mb-right', place: 'bottom', chapter: 'tour.ch.ui' },
  { key: 'quicktools', target: '#toolbelt', place: 'bottom', chapter: 'tour.ch.write' },
  { key: 'sidebar', target: '#sidebar', place: 'right', chapter: 'tour.ch.write' },
  { key: 'tabs', target: '#tabsBar', place: 'bottom', chapter: 'tour.ch.write' },
  { key: 'editor', target: '#editorPane', place: 'inside', chapter: 'tour.ch.write' },
  { key: 'insert', target: '[data-tour="menu-insert"]', place: 'bottom', chapter: 'tour.ch.write' },
  { key: 'previewbar', target: '#previewBar', place: 'bottom', chapter: 'tour.ch.output' },
  { key: 'paper', target: '#paper', place: 'inside', chapter: 'tour.ch.output' },
  { key: 'tex', target: '[data-tour="menu-tex"]', place: 'bottom', chapter: 'tour.ch.output' },
  { key: 'ai', target: '[data-tour="menu-ai"]', place: 'bottom', chapter: 'tour.ch.ai' },
  { key: 'help', target: '[data-tour="menu-help"]', place: 'bottom', chapter: 'tour.ch.help' },
  { key: 'statusbar', target: '#statusbar', place: 'top', chapter: 'tour.ch.help' },
  { key: 'end', target: null, place: 'center', chapter: 'tour.ch.help' }
];

// Keep the tutorial anchored to controls that exist in the current workspace.
export function tourStepsFor({ compact, viewMode, hasEditor, richPreview, texDocument }) {
  const mobileTargets = { menus: '#compactMenuToggle', sidebar: '#sidebarToggle', insert: '#tFormat', tex: '.mb-right', ai: '#tAi', help: '#compactMenuToggle' };
  return TOUR_STEPS.filter(step => {
    if (['editor', 'tabs'].includes(step.key)) return hasEditor && viewMode !== 'preview';
    if (['quicktools', 'insert'].includes(step.key)) return hasEditor && (richPreview || texDocument);
    if (['paper', 'previewbar'].includes(step.key)) return richPreview && viewMode !== 'edit';
    if (step.key === 'sidebar') return compact || viewMode !== 'preview';
    if (step.key === 'tex') return texDocument;
    return true;
  }).map(step => compact && mobileTargets[step.key] ? { ...step, target: step.key === 'ai' && !richPreview && !texDocument ? '#compactMenuToggle' : mobileTargets[step.key] } : step);
}

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_TOUR) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch (e) { return {}; }
}

function write(patch) {
  const next = { ...read(), v: TOUR_VERSION, ...patch };
  try { localStorage.setItem(LS_TOUR, JSON.stringify(next)); } catch (e) { /* ignore */ }
  return next;
}

// 沿用旧版 noAuto/done 偏好；起稿、继续和关闭欢迎页均视为明确选择。
export function shouldWelcome() {
  const s = read();
  return !s.noAuto && !s.done;
}

// 调用方传 true 记住已处理欢迎页；保留 false 以兼容旧版调用。
export function dismissWelcome(noAuto) {
  return noAuto ? write({ noAuto: true }) : read();
}

// 走完或跳过导览后不再自动打扰，「帮助 → 使用教程」随时可以重看
export function markTourDone() {
  return write({ done: true });
}

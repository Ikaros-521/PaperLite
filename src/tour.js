/* 使用教程：步骤表 + 首次访问标记
 * 步骤只声明「锚点选择器 + 摆放方向 + 文案键」，文案全在 i18n 的 tour.* 里；
 * 锚点在当前视图下不存在时（如仅预览模式没有编辑区），TourGuide 会降级成居中卡片，
 * 所以这里不需要为视图模式写分支逻辑。 */

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

// 欢迎页只在「没勾过不再弹出、且从没走完/跳过过导览」时自动出现
export function shouldWelcome() {
  const s = read();
  return !s.noAuto && !s.done;
}

// 直接关掉欢迎页不算表态：只有勾了「不再自动弹出」才压下去
export function dismissWelcome(noAuto) {
  return noAuto ? write({ noAuto: true }) : read();
}

// 走完或跳过导览后不再自动打扰，「帮助 → 使用教程」随时可以重看
export function markTourDone() {
  return write({ done: true });
}

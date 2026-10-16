/**
 * 移动端字号档位：唯一的取值来源。
 * 之前 CSS 里写着三档 data-scale，但没有任何地方设置这个属性，等于没有该功能；
 * 现在由移动壳把选中值注入 --pl-font，纸面预览、幽灵预览与编辑器都读同一个变量。
 */
export const SCALE_IDS = ['small', 'normal', 'large'] as const
export type ScaleId = (typeof SCALE_IDS)[number]

/** 单位 px；改这里就会同时作用于预览与编辑区，不要再在 CSS 里写第二份数字 */
export const SCALE_FONT: Record<ScaleId, number> = {
  small: 13,
  normal: 15,
  large: 17.5,
}

const LS_SCALE = 'paperlite.mobile.scale.v1'

export function readScale(): ScaleId {
  try {
    const v = localStorage.getItem(LS_SCALE)
    if (v && (SCALE_IDS as readonly string[]).includes(v)) return v as ScaleId
  } catch { /* 隐私模式读不到就用默认档 */ }
  return 'normal'
}

export function writeScale(scale: ScaleId): void {
  try { localStorage.setItem(LS_SCALE, scale) } catch { /* 存不下也只是下次回到默认档 */ }
}

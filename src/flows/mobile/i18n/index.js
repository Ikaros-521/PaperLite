/**
 * 移动端文案词典装配。
 * 每个 flow 自己一份字典文件，避免四个 flow 抢着往 src/i18n.js 里加键；
 * src/i18n.js 只负责在启动时把这里合并进 DICT。
 * 键前缀按 flow 分段（mb.doc / mb.ed / mb.cp / mb.hist / mb.sh），跨文件不会撞名。
 */
import { DOC_ZH, DOC_EN } from './documents.js';
import { ED_ZH, ED_EN } from './editor.js';
import { CP_ZH, CP_EN } from './compile.js';
import { HIST_ZH, HIST_EN } from './history.js';
import { SH_ZH, SH_EN } from './shell.js';
import { LB_ZH, LB_EN } from './labels.js';
import { FMT_ZH, FMT_EN } from './format.js';

export const MOBILE_DICT = {
  zh: { ...DOC_ZH, ...ED_ZH, ...CP_ZH, ...HIST_ZH, ...SH_ZH, ...LB_ZH, ...FMT_ZH },
  en: { ...DOC_EN, ...ED_EN, ...CP_EN, ...HIST_EN, ...SH_EN, ...LB_EN, ...FMT_EN },
};

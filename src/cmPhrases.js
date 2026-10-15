/* CodeMirror 查找/替换对话框的中文短语（英文走 CodeMirror 内置原文，返回空表）
 * 机制：Editor.prototype.phrase() 读 options.phrases，命中才替换，因此可整表覆盖。 */
const ZH = {
  'Search:': '查找：',
  'With:': '替换为：',
  'Replace?': '要替换这一处吗？',
  'Yes': '替换',
  'No': '跳过',
  'All': '全部替换',
  'Stop': '停止',
  'Replace all:': '全部替换：',
  'Replace:': '替换：',
  'Replace with:': '替换为：',
  '(Use /re/ syntax for regexp search)': '（可用 /正则/ 写法）'
};

export function cmPhrases(lang) {
  return lang === 'zh' ? ZH : null;
}

/* 要拼进 innerHTML / srcdoc 的文本先过这里。
 * 单独成模块的原因：转义口径散在各组件里迟早会漏一处（桌面渲染错误路径就漏过），
 * 而漏的那一处通常正好在「把异常原文回显给用户」的路径上——异常消息会带上文档内容片段。
 */
export function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

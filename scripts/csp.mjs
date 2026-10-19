/**
 * CSP 策略的唯一来源：伴随服务（响应头）与构建产物（index.html 的 meta，GitHub Pages
 * 下不了响应头）都用它，避免两处各写一份而漂移。
 *
 * 这套值是按 2026-10 实测得到的，不是抄常见配置：
 *  - script-src 不给 unsafe-inline / unsafe-eval：注入型脚本一律跑不起来。
 *    'wasm-unsafe-eval' 是内置 XeLaTeX（SwiftLaTeX 的 wasm + dvipdfmx）必需的，
 *    去掉后 wasm 实例化失败，编译整条链路断。
 *  - style-src 必须留 'unsafe-inline'：index.html 的启动骨架内联 <style>、
 *    mermaid 注入到 SVG 里的 <style>、打印 iframe 的 srcdoc 内联样式都靠它。
 *    实测去掉后 mermaid 图与打印排版会花；CSS 注入不能执行脚本，代价可接受。
 *  - worker-src/child-src/frame-src 要带 blob：XeLaTeX Worker、pdf.js worker、
 *    导出用的 srcdoc/blob 帧。
 *  - img-src/font-src 要带 data: 与 blob:：内联 SVG 图标、插入的图片走 FileReader
 *    的 data URL、项目内图片走 blob URL、KaTeX 字体。
 *  - connect-src 放开 http:/https:：AI 渠道 Base URL 由用户自填，本机 Ollama /
 *    LM Studio 常是明文 http，收到 'self' 会把它们挡死。这一条因此不構成外发限制，
 *    真正兜住注入的是 script-src。
 */
export const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' http: https: blob: data:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

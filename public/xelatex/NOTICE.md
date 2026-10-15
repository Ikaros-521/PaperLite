# 内置 XeLaTeX 引擎 · 资源与许可说明

本目录包含一套**完全在浏览器内运行**的 XeLaTeX 编译环境（WebAssembly），
使 PaperLite 在 GitHub Pages 纯静态托管下也能把 LaTeX 文档编译成 PDF，
无需本机安装 TeX Live / MiKTeX，也不依赖任何后端服务。

## 组成与来源

| 文件 | 说明 | 来源与许可 |
| --- | --- | --- |
| `swiftlatexxetex.wasm` / `swiftlatexdvipdfm.wasm` | XeTeX 与 dvipdfmx 引擎的 WebAssembly 构建 | [SwiftLaTeX](https://github.com/SwiftLaTeX/SwiftLaTeX)（release 2022-02-20）。上游项目代码 AGPL-3.0；XeTeX 引擎本体为 MIT 风格许可 |
| `swiftlatexxetex.js` / `swiftlatexdvipdfm.js` | emscripten 胶水（Worker 入口）。PaperLite 打了少量补丁：宏包缓存路径不再依赖响应头 `fileid`、HTTP 404 视为未命中缓存、模块配置可预设 | 基于 [SwiftLaTeX](https://github.com/SwiftLaTeX/SwiftLaTeX) 发行版文件修改（emscripten 运行时 MIT） |
| `repo/xetex/` | 静态 TeX 宏包/字体镜像（按 kpathsea 格式号分目录），替代上游已失效的 texlive.swiftlatex.com 按需服务 | 取自 TeX Live 2022 冻结存档（tlnet-final）：LaTeX 基础为 [LPPL 1.3c](https://www.latex-project.org/lppl.txt)；Latin Modern 字体为 GUST Font License；Fandol 字体为 GPL-3.0（字体部分见 CTAN 声明）；Computer Modern Type1（amsfonts）为 LPPL/AMS 许可；`swiftlatexxetex.fmt` 为用上述组件在本引擎上生成的 LaTeX 格式文件 |

## 工作方式

- 编辑器打开后**空闲时后台预热**引擎（`requestIdleCallback`），不阻塞任何交互；
- 首次编译时按需以同步 XHR 从 `repo/xetex/<格式号>/<文件名>` 拉取缺失的
  宏包/字体文件（同源静态文件，浏览器 HTTP 缓存自动生效）；
- 编译管线：XeTeX(wasm) → XDV → dvipdfmx(wasm) → PDF，与官方 demo 一致。

## 重新生成

`swiftlatexxetex.fmt` 及镜像文件由 PaperLite 维护者通过 TL2022 冻结存档
（`ftp.math.utah.edu/pub/tex/historic/systems/texlive/2022/tlnet-final`）
构建；升级需重新自举格式文件并回归验证中英文档。

`repo/xetex/26/booktabs.sty` 同样取自上述 TL2022 冻结存档的
`archive/booktabs.tar.xz`（booktabs 1.61803398，LPPL 许可），支持内置模板的三线表。
Fandol 的六个 `.fontspec` 文件为 PaperLite 提供的空配置，仅结束输入，
用于满足 fontspec 的可选配置探测，避免静态托管下的 404；字体和排版特性仍由
ctex/xeCJK 设置，对应的 `.otf` 字体位于 `repo/xetex/47/`。

# PaperLite · 论文速写编辑器

仿 Overleaf 的**本地论文工具**：LaTeX 实时预览 + 图样式可视化编辑，支持**打开本地文件夹**（文件树/多标签）、**Markdown 渲染与代码编辑**、**TeX 引擎真实编译（pdfLaTeX/LaTeX/XeLaTeX/LuaLaTeX）**、**多级大纲跳转**、**语法检测定位**、**多渠道 LLM（AI 修复 / 对话改写）**。

当前为 **React + Vite 实现**；最早的零依赖 vanilla 版本保留在 [`legacy/`](legacy/)。

## 快速开始

```bash
npm install
npm run dev        # 开发：http://localhost:5173
npm run build      # 构建 → dist/
npm test           # 冒烟测试（渲染引擎 + 皮肤 token 契约）
node server.mjs    # 推荐：静态托管 + TeX 编译 API + LLM Mock → http://localhost:8788
```

> 真正的 TeX 编译与 LLM Mock 需通过 `node server.mjs` 访问（dev server 只有富文本预览）。

## 文件菜单

- 新建文件夹：在已打开文件夹的根目录创建；未打开时先选择本地目录。
- 上传文件：支持多选；已打开目录时写入根目录，重名会确认覆盖；未打开目录时保留在内存，可通过源码 ZIP 下载。
- 创建副本：复制当前文本文件到独立的未保存标签，再通过 Ctrl+S 保存。
- 版本历史：从「文件 → 版本历史」或侧栏 ↶ 打开时间线，支持手动创建／命名版本、选择任意两个版本（含当前工作区）比较。Diff 支持左右分栏／行内视图、行号、增删统计、词级高亮、上下处修改跳转与折叠未修改行。回滚前自动备份当前内容，恢复后可继续比较或 Ctrl+Z 撤销，需保存才能写入本地文件。历史保存在当前浏览器，编辑停顿 3 秒、切换文件或保存时记录，每个文件最多 20 版，总历史约 100 万字符；达到上限会淘汰旧版本（含命名版本），存储不可用时会提示并阻止无备份回滚。
- 字数统计：估算当前文档预览正文的中文字数、其他语言词数及字符数；所选源码单独统计。
- 下载：提供源码 ZIP、当前文件源码、打印导出 PDF 与已编译 PDF。ZIP 按文件树可见目录收集资源，已打开的文件使用最新编辑内容；未保存标签放入 `unsaved/` 避免覆盖同名文件。
- 提交：导出投稿所需的源码包与 PDF，再自行提交至期刊或会议系统。
- 设置：编辑器字号、自动换行、同步滚动、界面皮肤和可用 TeX 编译器，设置随浏览器保存。

文件操作补充测试：`node test/fileActions.mjs`（ZIP 解压校验使用 Python 标准库）。

## TeX 引擎编译（pdfLaTeX / LaTeX / XeLaTeX / LuaLaTeX）

1. **内置 XeLaTeX（浏览器）——默认可用，无需安装**：XeTeX/dvipdfmx 的 WebAssembly 构建 + 随站点分发的 TeX 宏包/字体镜像（`public/xelatex/`，来源与许可见 [public/xelatex/NOTICE.md](public/xelatex/NOTICE.md)），GitHub Pages 纯静态托管即可把 LaTeX（含 `ctexart` 中文）编译成 PDF。应用空闲时后台预热引擎，就绪后**先用当前打开的文档跑一遍预热编译**（把这篇真正要用的宏包/字体拉进引擎内存），再按 `repo/warm.json`（内置模板冷编译实际加载的 456 项）并行预取进浏览器缓存；预取期间界面显示「资源预热中」，随时可编译。实测 40ms 往返链路下 demo 模板首次编译从 53s 降到 9s
2. 本机引擎（可选）：安装 [MiKTeX](https://miktex.org) 或 TeX Live 并加入 PATH，`npm run build && node server.mjs` 后引擎下拉会多出本机引擎
3. 「编译」→ 编译两遍（解析目录/引用）→ 预览区直接看 PDF（可下载/新窗口）；`latex` 引擎自动经 `dvipdfmx` 转 PDF
4. **编译失败**：自动切换日志视图，`!` 错误与 `l.NN` 行号被解析成可点击条目，一键跳到源码行（进入「⚠ 问题」面板同样可跳转）

未安装 TeX / 静态打开时仍可使用内置引擎与浏览器打印导出 PDF。

## 界面皮肤

「查看 → 皮肤」或「文件 → 设置… → 界面皮肤」切换 6 套配色：墨纸书斋（默认暖象牙）、素纸霜白、青瓷苔绿、夜航深蓝、石墨鎏金、紫夜幽兰；选择记在浏览器（`paperlite.theme.v1`），深色皮肤同时置 `color-scheme: dark`，原生控件与滚动条一起变暗。

- 换肤只换界面（书桌、菜单栏、侧栏、编辑器、AI 面板），**论文纸面与导出 PDF 始终黑字白页**：TikZ / Mermaid / KaTeX 的描边与字色按浅纸设计，深色皮肤下预览只是把纸色调和一点（冷灰 / 暖米），不会变成黑底图。
- 配色全是 CSS 变量：`src/themes.css` 每套皮肤一个 `@palette` 块（同一套 token，含 CodeMirror 语法色与纸面底色），`src/app.css` 只用 `var()` 消费。加一套皮肤 = 复制一个 `@palette` 块 + 在 `src/theme.js` 的 `THEME_IDS` 与 `i18n.js` 的 `theme.<id>` 补名称，`npm test` 会校验 token 有没有漏、缩略色与调色板是否同源。

## 大纲窗口

左侧栏「☰」：多级大纲（LaTeX 章节 + 子节 / Markdown 标题，带编号缩进）。点击任意条目 → **编辑器跳到对应行（黄色闪烁）+ 预览滚动到对应标题**。

## 语法检测

左侧栏「⚠」（状态栏计数可点）汇总三类问题，全部**点击跳转到源码行**：

- 静态检测（`src/engines/linter.js`，行号级）：环境未闭合/不匹配、花括号不配对、行内 `$` 奇数、未定义 `\ref`/`\cite`、列表外 `\item`
- 渲染警告（引擎实时产生）
- 编译错误（TeX 日志解析）

编辑区内为 **VSCode 风格内联标记**：出错行显示红/橙波浪线（悬停看原因），行号旁 gutter 显示红/橙圆点——**点击圆点自动打开 AI 助手并预填该问题的修复提示词**（含行号、问题描述与出错行内容，可补充修复方向后发送）。

## AI（多渠道 LLM）

「🤖 AI 设置」：支持 **OpenAI 兼容** 与 **Anthropic (Claude)** 两种主流协议，可添加多个渠道，每渠道独立配置：

- **平台预设**：内置 OpenAI / Anthropic / DeepSeek / 智谱 GLM / 通义千问 / Kimi / 硅基流动 / OpenRouter / Ollama / LM Studio 等，选中即自动配好协议与 Base URL（也可手动自定义）
- **协议**：OpenAI 兼容（`/chat/completions`）或 Anthropic（`/v1/messages`，`x-api-key` + `anthropic-version`，浏览器直连自动声明）
- Base URL / API Key / **对话模型** / **检索模型**（embedding，用于文档检索增强；Anthropic 协议无嵌入接口，检索自动回退）
- **模型下拉**：点「获取模型」拉取该渠道可用模型列表（`/models`），输入即过滤、点选填入，也可直接手输
- **思维链开关**（OpenAI 协议发送推理提示，`reasoning_content`；Anthropic 协议启用 extended thinking，`thinking` 块——均可在对话中折叠查看 💭）
- **上下文上限**（字符）
- **测试连接**（按协议拉取 /models 或对话探活，内联显示结果）

两种用法：

- **✨ AI 修复**：问题面板一键把「问题清单 + 文档」交给模型，返回修复后的完整文档（代码块中，可预览后「替换全文」，Ctrl+Z 可撤销）
- **💬 AI 助手**：对话面板流式输出；上下文范围可选 **选区 / 光标段落 / 全文 / 检索增强**（调用检索模型对文档分块嵌入取 top-k，不可用时回退全文截断）；回复中的代码块支持 **复制 / 替换选区 / 插入光标 / 替换全文**

离线体验：`node server.mjs` 内置 Mock（OpenAI 兼容 `/v1/chat/completions` 流式 + `/v1/embeddings`，Anthropic 协议 `/v1/messages` 流式含 thinking），设置里「添加渠道」默认预填。

## 打开本地文件夹（需 Chrome / Edge）

点顶栏「📂 打开文件夹」并授权读写后：

- **文件树**：懒加载展开、文件夹优先排序（自动隐藏 `node_modules`/`.git`/`dist` 等目录）；悬停条目可重命名 ✏️ / 删除 🗑，悬停文件夹可就地新建文件 ＋📄 / 新建文件夹 ＋📁
- **多标签**：点击文件打开为标签（独立撤销历史与光标）；未保存显示 ● 圆点，关闭前有确认；图片文件直接预览

「📃 新建文件…」（Ctrl+Alt+N）：不依赖文件夹即可新建 `.tex` / `.md` / 代码文件标签，正常编辑。**保存规则与典型编辑器一致**：已打开文件夹 → Ctrl+S 直接存入文件夹根目录（重名会确认）；未打开文件夹 → 弹出系统「另存为」对话框自选位置（保存后标签转为普通文件标签，后续 Ctrl+S 直接写回）；浏览器不支持时退化为下载。
- **按类型预览/编辑**：

| 文件类型 | 行为 |
| --- | --- |
| `.tex/.sty/.cls/.bib` | PaperLite 全功能：LaTeX 实时预览 + 图样式面板 |
| `.md/.markdown` | Markdown 实时渲染（表格、`$..$`/`$$..$$` 数学走 KaTeX、\`\`\`mermaid 图、代码高亮块） |
| `.js/.ts/.py/.cpp/.go/.rs/.sql/.yaml/.html/...` 等代码 | 语法高亮编辑（CodeMirror 15+ 语言模式），右侧显示文件信息卡 |
| `.png/.jpg/.gif/...` | 图片预览 |
| 其他文本（`.txt/.log/...`） | 纯文本编辑 |
| 二进制/超大文件（>2MB） | 拒绝打开并提示 |

- **保存**：`Ctrl+S` 或「💾 保存」——文件标签写回磁盘原位置；草稿标签存浏览器；未保存关闭会确认
- **文件夹记忆**：根目录句柄存 IndexedDB，重开浏览器后点「🔓 恢复上次文件夹」即可（需重新授权，浏览器安全策略）

## 核心功能（论文）

编辑器上方的快捷栏参考 Overleaf 的分组方式：AI 助手、撤销/重做、标题与文本格式、公式模板、24 个常用数学符号、链接、源码注释、标签/交叉引用、图片、1–6 行列的表格网格和列表。引用面板自动列出当前文档的标签；插入内容后选中可编辑部分，并可撤销。更多菜单保留流程图、Mermaid、文献和脚注；Markdown 文件的格式、公式、表格及列表按钮使用相应语法。

| 功能 | 说明 |
| --- | --- |
| **实时预览** | React `useDeferredValue` 低优先级渲染，输入不卡顿；标题/章节/公式/表格/引用/脚注/目录即时呈现 |
| **公式** | 行内 `$...$`、行间 `\[...\]`、`equation / align / gather / cases` 等环境，KaTeX 渲染，自动编号，`\label` / `\eqref` 交叉引用 |
| **TikZ 流程图** | 内置 TikZ 子集引擎（`src/engines/tikz.js`，无 DOM 依赖、可单测）：矩形/圆/椭圆/菱形、圆角、虚线、颜色混合（`blue!20`）、定位、`-stealth` 箭头、`|-` `-|` 肘形、`to[bend left=30]` 弯曲、路径标签 |
| **可视化改样式** | 点击预览图中的节点，或用「🎨 图样式」面板：改填充/边框/文字色、线宽、虚线、圆角、形状、字号 → **精确写回 LaTeX 源码**（改 `tikzset` 批量生效；改单节点生成内联覆盖，符合 TikZ 优先级语义） |
| **Mermaid** | `\begin{mermaid}...\end{mermaid}`，按需懒加载（动态 import，不进主包） |
| **导出 PDF** | 「🖨 导出 PDF」调起浏览器打印 → 选「另存为 PDF」。矢量输出、文字可选中、A4 版式 |
| **其他导出** | `.tex`（可传 Overleaf / 本地 TeX 编译）、独立 HTML、单图 SVG（矢量）/ PNG（2x） |
| **编辑器** | CodeMirror 5（stex 高亮、括号匹配/补全、活动行）、工具栏插入模板、拖拽图片转 base64、Ctrl+B/I/S 快捷键 |
| **中英双语** | 菜单栏右侧「中 / EN」一键切换全部界面文案（菜单/面板/对话框/诊断提示），随浏览器语言自动选择，localStorage 记忆；文档内容语言不受影响 |
| **其他** | 三线表（booktabs + multicolumn）、参考文献自动编号、`\newcommand` 宏展开、ctexart 中文排版、双栏预览、同步滚动、字数统计、警告面板 |

## 架构

```
paperlite/
├── index.html            # Vite 入口
├── src/
│   ├── main.jsx          # 挂载
│   ├── App.jsx           # 多标签状态中枢（文件夹/标签/预览路由/保存/同步滚动/快捷键）
│   ├── fs.js             # File System Access API（目录遍历/读写/增删改 + IndexedDB 持久化）
│   ├── fileTypes.js      # 扩展名 → 编辑器模式 / 预览类型 / 图标
│   ├── app.css           # 界面 + 论文/Markdown 排版样式（只 var() 消费配色）
│   ├── themes.css        # ★ 皮肤调色板：每套皮肤一个 @palette 块（含语法色、纸面底色）
│   ├── theme.js          # 皮肤注册表 + 读写 localStorage / 涂 <html data-theme>
│   ├── engines/          # ★ 纯渲染引擎（无 React/DOM 依赖，Node 可直接单测）
│   │   ├── latex.js      #   LaTeX → HTML（注释等长抹除，保证源码偏移可回写）
│   │   ├── tikz.js       #   TikZ 子集 → SVG（记录节点/样式源码区间）
│   │   ├── markdown.js   #   Markdown → HTML（KaTeX 数学 + mermaid 块 + 代码保护）
│   │   └── samples.js    #   内置模板
│   ├── styleMutations.js # 图样式回写纯逻辑（面板 UI 与源码修改解耦）
│   ├── exporter.js       # PDF 打印 / .tex / HTML / SVG / PNG
│   └── components/
│       ├── FileTree.jsx      # 文件树（懒加载/新建/重命名/删除）
│       ├── TabsBar.jsx       # 多标签栏
│       ├── EditorPane.jsx    # CodeMirror 封装（每 Tab 独立 Doc，swapDoc 切换）
│       ├── PreviewPane.jsx   # 预览 + Mermaid 懒加载 + 图工具条 + 选中联动
│       ├── StylePanel.jsx    # 图样式编辑面板（应用时直读 DOM 控件值）
│       └── Toolbar.jsx       # 顶栏 / 文件夹 / 模板 / 导出 / 插入工具
├── legacy/               # v1 vanilla 版（双击 legacy/index.html 可用）
└── test/smoke.mjs        # 冒烟测试（npm test）
```

## Electron 打包（后续方向，已预留）

构建已配置 `base: './'`（相对路径），`dist/` 产物兼容 `file://` 加载，可直接作为 Electron 渲染层。将来打包时只需：

```bash
npm i -D electron electron-builder
# 新建 electron/main.js：mainWindow.loadFile('dist/index.html')
# package.json 增加 "main": "electron/main.js" 与 build 配置后：
npm run electron:build
```

无需改动任何前端代码（引擎、存储 localStorage、导出打印在 file:// 下均可用）。

## GitHub Pages 自动部署

项目内置 GitHub Actions 工作流（[`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml)），**推送到 `main` 分支即自动构建并发布到 GitHub Pages**（也可在 Actions 页面手动触发 Run workflow）。

流水线步骤：安装依赖 → 冒烟测试（48 项）→ `vite build` → 部署 `dist/` 到 Pages。

首次启用只需在仓库设置一次：

> **Settings → Pages → Build and deployment → Source 选择「GitHub Actions」**

之后每次 push 到 `main`，约 2 分钟后即可在 `https://<用户名>.github.io/<仓库名>/` 访问线上版本。构建产物为相对路径（`base: './'`），子路径部署无需任何改动。

> 注意：GitHub Pages 是纯静态托管，TeX 真实编译与 LLM Mock API（`node server.mjs`）仅在本地可用；线上版本使用浏览器打印导出 PDF、AI 需自配可直连的 API 渠道。

## 支持的 LaTeX 子集

结构：`\documentclass`(ctexart/article/twocolumn)、`\title \author \date \maketitle`、`abstract`、`section` 系列（自动编号、`*` 不编号）、`tableofcontents`、`\newpage`

文本：`\textbf \emph \underline \texttt \footnote \cite \ref \eqref \autoref \label \url \href`、列表、`quote/center`、`verbatim/lstlisting`、`~ --- ``...'' \% \& \# \_`

浮动体：`figure/figure*/table/table*` + `\includegraphics`（`width=0.8\textwidth` 与 base64）、`\caption` 自动编号、三线表

> 未知命令/环境会被忽略并在状态栏「⚠ 警告」里列出，不会导致整篇渲染失败。需要完整 TeX 排版（自定义宏包、复杂 TikZ、双栏精确分页）时，用「下载 .tex」转 Overleaf / 本地编译即可。

## 已知限制

- LaTeX 为论文常用子集，非完整 TeX 引擎；`bibtex`、任意宏包请转真实编译
- `align` 环境整块编号（不逐行编号）；流程图标签中的数学以 Unicode 近似显示
- PDF 页码由浏览器打印对话框的页眉页脚设置控制

## 许可证

本项目基于 **[GPL-3.0](LICENSE)**（GNU General Public License v3.0，SPDX: `GPL-3.0-or-later`）开源发布。

- 任何人都可以自由地使用、学习、修改和再分发本项目
- 基于本项目的衍生作品、二次开发成果在分发时必须同样以 GPL-3.0 开源，并保留原始版权与许可声明
- 完整许可证文本见 [LICENSE](LICENSE)；依赖的第三方库各自遵循其原有许可证（见 `node_modules` 中各包的 LICENSE 文件）

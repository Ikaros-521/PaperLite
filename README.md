# PaperLite · 论文速写编辑器

仿 Overleaf 的**本地论文工具**：LaTeX 实时预览 + 图样式可视化编辑，支持**打开本地文件夹**（文件树/多标签）、**Markdown 渲染与代码编辑**、**TeX 引擎真实编译（pdfLaTeX/LaTeX/XeLaTeX/LuaLaTeX）**、**多级大纲跳转**、**语法检测定位**、**多渠道 LLM（AI 修复 / 对话改写）**。

当前为 **React + Vite 实现**；最早的零依赖 vanilla 版本保留在 [`legacy/`](legacy/)。

## 快速开始

```bash
npm install
npm run dev        # 开发：http://localhost:5173
npm run build      # 构建 → dist/
npm test           # 冒烟测试（48 项断言）
node server.mjs    # 推荐：静态托管 + TeX 编译 API + LLM Mock → http://localhost:8788
```

> 真正的 TeX 编译与 LLM Mock 需通过 `node server.mjs` 访问（dev server 只有富文本预览）。

## TeX 引擎编译（pdfLaTeX / LaTeX / XeLaTeX / LuaLaTeX）

1. 本机安装 [MiKTeX](https://miktex.org) 或 TeX Live 并加入 PATH
2. `npm run build && node server.mjs`，顶栏引擎下拉自动列出可用引擎
3. 「⚙ TeX 编译」→ 编译两遍（解析目录/引用）→ 预览区直接看 PDF（可下载/新窗口）；`latex` 引擎自动经 `dvipdfmx` 转 PDF
4. **编译失败**：自动切换日志视图，`!` 错误与 `l.NN` 行号被解析成可点击条目，一键跳到源码行（进入「⚠ 问题」面板同样可跳转）

未安装 TeX / 静态打开时按钮自动禁用并给出指引，浏览器打印导出 PDF 依然可用。

## 大纲窗口

左侧栏「☰」：多级大纲（LaTeX 章节 + 子节 / Markdown 标题，带编号缩进）。点击任意条目 → **编辑器跳到对应行（黄色闪烁）+ 预览滚动到对应标题**。

## 语法检测

左侧栏「⚠」（状态栏计数可点）汇总三类问题，全部**点击跳转到源码行**：

- 静态检测（`src/engines/linter.js`，行号级）：环境未闭合/不匹配、花括号不配对、行内 `$` 奇数、未定义 `\ref`/`\cite`、列表外 `\item`
- 渲染警告（引擎实时产生）
- 编译错误（TeX 日志解析）

## AI（多渠道 LLM）

「🤖 AI 设置」：兼容 OpenAI 协议（OpenAI / DeepSeek / GLM / 通义 / Kimi / Ollama…），可添加多个渠道，每渠道独立配置：

- Base URL / API Key / **对话模型** / **检索模型**（embedding，用于文档检索增强）
- **思维链开关**（发送推理提示；模型返回 `reasoning_content` 时在对话中可折叠查看 💭）
- **上下文上限**（字符）
- **测试连接**（/models 或对话探活，内联显示结果）

两种用法：

- **✨ AI 修复**：问题面板一键把「问题清单 + 文档」交给模型，返回修复后的完整文档（代码块中，可预览后「替换全文」，Ctrl+Z 可撤销）
- **💬 AI 助手**：对话面板流式输出；上下文范围可选 **选区 / 光标段落 / 全文 / 检索增强**（调用检索模型对文档分块嵌入取 top-k，不可用时回退全文截断）；回复中的代码块支持 **复制 / 替换选区 / 插入光标 / 替换全文**

离线体验：`node server.mjs` 内置 OpenAI 兼容 Mock（`/v1/chat/completions` 流式、`/v1/embeddings`），设置里「添加渠道」默认预填。

## 打开本地文件夹（需 Chrome / Edge）

点顶栏「📂 打开文件夹」并授权读写后：

- **文件树**：懒加载展开、文件夹优先排序（自动隐藏 `node_modules`/`.git`/`dist` 等目录）；悬停条目可重命名 ✏️ / 删除 🗑，悬停文件夹可就地新建文件 ＋📄 / 新建文件夹 ＋📁
- **多标签**：点击文件打开为标签（独立撤销历史与光标）；未保存显示 ● 圆点，关闭前有确认；图片文件直接预览
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
│   ├── app.css           # 界面 + 论文/Markdown 排版样式
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

## 支持的 LaTeX 子集

结构：`\documentclass`(ctexart/article/twocolumn)、`\title \author \date \maketitle`、`abstract`、`section` 系列（自动编号、`*` 不编号）、`tableofcontents`、`\newpage`

文本：`\textbf \emph \underline \texttt \footnote \cite \ref \eqref \autoref \label \url \href`、列表、`quote/center`、`verbatim/lstlisting`、`~ --- ``...'' \% \& \# \_`

浮动体：`figure/figure*/table/table*` + `\includegraphics`（`width=0.8\textwidth` 与 base64）、`\caption` 自动编号、三线表

> 未知命令/环境会被忽略并在状态栏「⚠ 警告」里列出，不会导致整篇渲染失败。需要完整 TeX 排版（自定义宏包、复杂 TikZ、双栏精确分页）时，用「下载 .tex」转 Overleaf / 本地编译即可。

## 已知限制

- LaTeX 为论文常用子集，非完整 TeX 引擎；`bibtex`、任意宏包请转真实编译
- `align` 环境整块编号（不逐行编号）；流程图标签中的数学以 Unicode 近似显示
- PDF 页码由浏览器打印对话框的页眉页脚设置控制

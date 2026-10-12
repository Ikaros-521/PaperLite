# PaperLite · 论文速写编辑器

仿 Overleaf 的**本地论文写作工具**：左侧写 LaTeX，右侧实时预览，流程图可视化改样式，一键导出 PDF；支持**打开本地文件夹**——文件树 + 多标签编辑，Markdown 实时渲染、代码高亮编辑、Ctrl+S 直接写回磁盘（VSCode 式体验）。

当前为 **React + Vite 实现**（v2）；最早的零依赖 vanilla 版本保留在 [`legacy/`](legacy/)（双击 `legacy/index.html` 即可用，无需 Node）。两个版本共用同一套渲染引擎逻辑。

## 快速开始（React 版）

```bash
npm install        # 已配置 npmmirror 源（.npmrc）
npm run dev        # 开发：http://localhost:5173
npm run build      # 构建 → dist/（相对路径产物，可直接双击 dist/index.html）
npm run preview    # 本地预览构建产物
npm test           # Node 冒烟测试（真实 KaTeX + Markdown，41 项断言）
```

首次打开即载入中文示例论文（含流程图、公式、三线表、参考文献）；草稿自动保存在浏览器 localStorage。

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

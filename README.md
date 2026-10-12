# PaperLite · 论文速写编辑器

仿 Overleaf 的**本地论文写作工具**：左侧写 LaTeX，右侧实时预览，流程图可视化改样式，一键导出 PDF。纯前端实现、完全离线可用（依赖库已打包在 `vendor/`）。

## 快速开始

任选其一：

```bash
# 方式 A：直接双击 index.html（推荐 Chrome / Edge）

# 方式 B：本地服务器（图片路径更稳）
node server.js 8765
# 然后访问 http://127.0.0.1:8765/index.html
```

首次打开即载入中文示例论文（含流程图、公式、三线表、参考文献）。文档自动保存在浏览器 localStorage。

## 核心功能

| 功能 | 说明 |
| --- | --- |
| **实时预览** | 输入停顿 ~0.3s 自动重渲染；标题/章节/公式/表格/引用/脚注/目录即时呈现 |
| **公式** | 行内 `$...$`、行间 `\[...\]`、`equation / align / gather / cases` 等环境，KaTeX 渲染，自动编号，`\label` / `\eqref` 交叉引用 |
| **TikZ 流程图** | 内置 TikZ 子集引擎：矩形/圆/椭圆/菱形、圆角、虚线、颜色混合（`blue!20`）、`right of` / `right=2cm of` 定位、`->` `-stealth` 箭头、`|-` `-|` 肘形、`to[bend left=30]` 弯曲、路径标签、`node distance`、`scale` |
| **可视化改样式** | 点击预览图中的节点，或用右侧「🎨 图样式」面板：改填充/边框/文字色、线宽、虚线、圆角、形状、字号 → **精确写回 LaTeX 源码**并即时重渲染。改 `tikzset` 样式可一次作用于全部同类节点；改单个节点生成内联覆盖（内联优先，符合 TikZ 语义） |
| **Mermaid** | `\begin{mermaid}...\end{mermaid}` 直接渲染 flowchart / sequence 等图表 |
| **导出 PDF** | 「🖨 导出 PDF」调起浏览器打印 → 选「另存为 PDF」。矢量输出、文字可选中、A4 版式、表格图片不跨页断裂 |
| **导出 .tex** | 源码可直接上传 Overleaf 或本地 TeX Live / MiKTeX 编译（TikZ 样式写回均为合法 xcolor 语法） |
| **图导出** | 鼠标悬停预览中的图 → `SVG`（矢量）/ `PNG`（2x 高清）单独下载 |
| **三线表** | `booktabs` 的 `\toprule / \midrule / \bottomrule` + 竖线；`multicolumn` 支持 |
| **参考文献** | `thebibliography` + `\cite` 自动编号回填，未定义引用标红提示 |
| **宏** | `\newcommand`（含带参数、可选参数）全文档展开 |
| **其他** | 中文字体排版（ctexart 自动识别）、脚注、`\tableofcontents`、图片拖入自动转 base64 内嵌、双栏预览、同步滚动、字数统计 |

## 快捷键

- `Ctrl+S` 保存 · `Ctrl+Enter` 立即重渲染
- `Ctrl+B` 加粗 · `Ctrl+I` 斜体
- 预览区缩放：`− / ＋`

## 支持的 LaTeX 子集

结构：`\documentclass`(ctexart/article/twocolumn)、`\title \author \date \maketitle`、`abstract`、`section/subsection/subsubsection/paragraph`（自动编号、`*` 不编号）、`tableofcontents`、`\newpage`

文本：`\textbf \emph \textit \underline \texttt \textsc \sout \footnote \cite \ref \eqref \autoref \label \url \href`、列表、`quote/center`、`verbatim/lstlisting`、`~ --- -- ``...'' \% \& \# \_`

浮动体：`figure/figure*/table/table*` + `\includegraphics`（支持 `width=0.8\textwidth` 与 base64）、`\caption`、自动编号、三线表

> 未知命令/环境会被忽略并在状态栏「⚠ 警告」里列出，不会导致整篇渲染失败。需要完整 TeX 排版（自定义宏包、复杂 TikZ、双栏精确分页）时，用「下载 .tex」转 Overleaf / 本地编译即可。

## TikZ 速查（本工具支持的写法）

```latex
\tikzset{
  block/.style={rectangle, rounded corners=6pt, fill=blue!12, draw=blue!60!black, align=center},
  decision/.style={diamond, fill=yellow!25, draw=orange!80!black},
  arrow/.style={-stealth, thick},
}
\begin{tikzpicture}[node distance=1.5cm]
  \node[block] (a) {开始};
  \node[block, right of=a, node distance=3cm, text width=2.5cm] (b) {处理\\两行文字};
  \node[decision, below of=b] (c) {判断?};
  \draw[arrow] (a) -- (b);
  \draw[arrow] (b) -- node[above, font=\small]{标签} (c);
  \draw[arrow, bend left=30] (c) to (a);
\end{tikzpicture}
```

## 目录结构

```
paperlite/
├── index.html        # 入口（双击打开）
├── server.js         # 可选静态服务器
├── css/app.css       # 界面 + 论文排版样式
├── js/
│   ├── latex.js      # LaTeX → HTML 渲染器（注释等长抹除保证源码偏移可回写）
│   ├── tikz.js       # TikZ 子集 → SVG 引擎（记录节点/样式源码区间）
│   ├── stylepanel.js # 图样式可视化编辑面板（改样式写回源码）
│   ├── editor.js     # CodeMirror 封装（无 CodeMirror 时退化为 textarea）
│   ├── exporter.js   # PDF 打印 / .tex / SVG / PNG 导出
│   ├── app.js        # 主程序联动
│   └── samples.js    # 内置模板（示例论文 / 流程图速查 / 空白）
├── vendor/           # KaTeX / Mermaid / CodeMirror（离线可用）
└── test/smoke.mjs    # Node 冒烟测试：node test/smoke.mjs
```

## 已知限制

- LaTeX 为论文常用子集，非完整 TeX 引擎；`bibtex`、复杂宏包请转真实编译
- `align` 环境整块编号（不逐行编号）；节内数学粗体等符号在流程图标签中以 Unicode 近似显示
- PDF 页码由浏览器打印对话框的页眉页脚设置控制
- 样式面板目前覆盖 TikZ 图；Mermaid 图通过其自身主题配置调整

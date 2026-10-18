# PaperLite · 论文速写编辑器

仿 Overleaf 的**本地论文工具**：LaTeX 实时预览 + 图样式可视化编辑，支持**打开本地文件夹**（文件树/多标签）、**Markdown 渲染与代码编辑**、**TeX 引擎真实编译（pdfLaTeX/LaTeX/XeLaTeX/LuaLaTeX，含多文件主文档与自动重编译）**、**多级大纲跳转**、**语法检测定位**、**命令/环境/文件名自动补全**、**项目内跨文件搜索**、**文献检索插入（Crossref / OpenAlex / DBLP）与 LanguageTool 语法检查**、**多渠道 LLM（AI 修复 / 对话改写）**。

当前为 **React + Vite 实现**；最早的零依赖 vanilla 版本保留在 [`legacy/`](legacy/)。

## 快速开始

```bash
npm install
npm run dev        # 开发：http://localhost:5173
npm run build      # 构建 → dist/
npm test           # 全量模块测试（渲染引擎 / 皮肤契约 / 主文档 / 补全 / 查找 / 历史 …）
node server.mjs    # 推荐：静态托管 + TeX 编译 API + LLM Mock → http://localhost:8788
```

> 真正的 TeX 编译与 LLM Mock 需通过 `node server.mjs` 访问（dev server 只有富文本预览）。

## 文件菜单

- 新建文件夹：在已打开文件夹的根目录创建；未打开时先选择本地目录。
- 上传文件：支持多选；已打开目录时写入根目录，重名会确认覆盖；未打开目录时保留在内存，可通过源码 ZIP 下载。
- 创建副本：复制当前文本文件到独立的未保存标签，再通过 Ctrl+S 保存。
- 版本历史：从「文件 → 版本历史」或侧栏 ↶ 打开时间线，支持手动创建／命名版本、选择任意两个版本（含当前工作区）比较。Diff 支持左右分栏／行内视图、行号、增删统计、词级高亮、上下处修改跳转与折叠未修改行。回滚前自动备份当前内容，恢复后可继续比较或 Ctrl+Z 撤销，需保存才能写入本地文件。历史保存在当前浏览器，编辑停顿 3 秒、切换文件或保存时记录，每文件最多 20 版，全部最多 200 版、100 万序列化字符（按 UTF-16 约 2 MB）；保存、命名及另存为共用容量限制，超限按时间淘汰最旧版本（含命名版本），被清理时状态栏会提示条数。面板显示存储占用，支持删除所选版本、清空此文件历史、清空全部历史，均需确认；清理不修改文档，也不会在切换标签时立即重新生成已清理的快照，继续编辑后恢复记录。存储配额不足会尝试释放旧历史后重试一次，仍失败则提示并阻止无备份回滚。读取缓存避免反复解析整份历史；Diff 每页最多 300 行，超过合计 50 万字符或 1 万换行的对比提供版本下载，避免大量 DOM 和差异运算阻塞页面。
- 字数统计：估算当前文档预览正文的中文字数、其他语言词数及字符数；所选源码单独统计。
- 下载：提供源码 ZIP、当前文件源码、打印导出 PDF 与已编译 PDF。ZIP 按文件树可见目录收集资源，已打开的文件使用最新编辑内容；未保存标签放入 `unsaved/` 避免覆盖同名文件。
- 提交：导出投稿所需的源码包与 PDF，再自行提交至期刊或会议系统。
- 设置：编辑器字号、自动换行、同步滚动、界面皮肤、TeX 引擎、**主文档**（多文件项目的编译入口，可固定或自动探测）、**自动编译**（保存时 / 停顿后 / 手动）、**Vim 键位**（关闭时零开销，开启时才动态加载约 95 KB 分包）与**语法检查（LanguageTool，联网，默认关闭）**，设置随浏览器保存；当前引擎与预热状态同时常驻在底部状态栏（「资源预热中 / 已就绪 / 预热失败」），不必去下拉框里找。

文件操作补充测试：`node test/fileActions.mjs`（ZIP 解压校验使用 Python 标准库）。

文档安全回归测试：`node test/documentSafety.mjs`（已纳入 `npm test`），覆盖保存期间继续输入、另存为、模板替换、草稿历史隔离与 PDF 资源子路径。浏览器草稿使用随草稿持久化的独立 ID 记录历史；旧版共用的草稿历史保留在原存储中，可从草稿的版本历史面板导出 JSON 查阅，避免把混合记录归到错误文档。保存及另存为期间产生的新修改会继续保留未保存标记；模板替换磁盘文件也需保存后才会写盘。

内置 PDF 阅读器与 PDF 插图预览共用本地 CMap/标准字体配置。开发服务器提供这些资源，构建时自动打包到 `dist/pdfjs/`，支持 GitHub Pages 子路径部署，无需外部字体 CDN。

窗口宽度不超过 900px 时，分栏自动显示为单栏编辑，使用顶栏切换编辑/预览；「文件与大纲」展开侧栏，「菜单」访问完整菜单。自动适配不覆盖原来的桌面分栏偏好。编译统一放在顶栏，完成后可下载编译 PDF；「文件 → 下载 → 打印网页预览」单独保留浏览器打印，所有编译 PDF 下载入口共用源码过期确认。

首次欢迎页可继续当前文档、另建空白草稿或打开本地项目；选择后不再自动弹出，也可从「帮助 → 开始写作」重开。教程为可选项，会按当前视图筛选可见入口，支持 Tab 循环和 Esc 退出。底栏常驻区分「已存浏览器」「已写入文件」、等待、写入中和失败状态；失败可重试。浏览器草稿的「保存到文件」会在写入成功后转为普通文件标签，后续 Ctrl+S 写回同一文件；不支持文件选择器时下载源码副本，仍保留浏览器草稿状态。

## TeX 引擎编译（pdfLaTeX / LaTeX / XeLaTeX / LuaLaTeX）

1. **内置 XeLaTeX（浏览器）——默认可用，无需安装**：XeTeX/dvipdfmx 的 WebAssembly 构建 + 随站点分发的 TeX 宏包/字体镜像（`public/xelatex/`，来源与许可见 [public/xelatex/NOTICE.md](public/xelatex/NOTICE.md)），GitHub Pages 纯静态托管即可把 LaTeX（含 `ctexart` 中文）编译成 PDF。应用空闲时后台预热引擎，就绪后**先用当前打开的文档跑一遍预热编译**（把这篇真正要用的宏包/字体拉进引擎内存），再按 `repo/warm.json`（内置模板冷编译实际加载的 479 项）并行预取进浏览器缓存；预取期间界面显示「资源预热中」，随时可编译。实测 40ms 往返链路下 demo 模板首次编译从 53s 降到 9s
2. 本机引擎（可选）：安装 [MiKTeX](https://miktex.org) 或 TeX Live 并加入 PATH，`npm run build && node server.mjs` 后引擎下拉会多出本机引擎
3. 「编译」→ 编译两遍（解析目录/引用）→ 预览区直接看 PDF（可下载/新窗口）；`latex` 引擎自动经 `dvipdfmx` 转 PDF。PDF 阅读器支持**页码输入跳转 / 上下翻页、按钮与 Ctrl+滚轮缩放、适合宽度、双页对开**（双栏论文双页看更自然；双页下「适合宽度」按两页宽计算）
4. **主文档（编译入口）**：多文件项目（`\input` / `\include` 拆章）在子文件标签上编译，也会从带 `\documentclass` 的主文档走，不会把子文件当独立文档编译报错。自动探测优先级为「当前标签是主文档 > 打开标签里的 `main/paper/root.tex` > 文件夹扫描」，也可在「文件 → 设置」里固定到具体文件（按文件夹名记忆）；入口不是当前文件时状态栏常驻 `⌂ 主文档名`。主文档没打开时直接从磁盘读取参与编译，打开中的标签则连同未保存修改一起编译
5. **自动重编译**：设置里可选「保存时 / 输入停顿 6 秒后 / 手动（默认）」。自动编译为静默模式——不切换视图、成功不弹提示，结果照常更新 PDF 与问题栏；内置引擎只在本次会话已手动编译过一次后才跟随（首次编译要拉约 98 MB 资源，必须由用户发起）
6. **编译失败**：自动切换日志视图，`!` 错误与 `l.NN` 行号被解析成可点击条目，一键跳到源码行（进入「⚠ 问题」面板同样可跳转）

未安装 TeX / 静态打开时仍可使用内置引擎与浏览器打印导出 PDF。主文档解析逻辑在 `src/mainDoc.js`（纯函数，`test/mainDoc.mjs` 覆盖）；移动端已同款接入（无文件夹扫描，在打开的标签里探测主文档），暂不支持手动固定。

## 界面皮肤

「查看 → 皮肤」或「文件 → 设置… → 界面皮肤」切换 6 套配色：墨纸书斋（默认暖象牙）、素纸霜白、青瓷苔绿、夜航深蓝、石墨鎏金、紫夜幽兰；选择记在浏览器（`paperlite.theme.v1`），深色皮肤同时置 `color-scheme: dark`，原生控件与滚动条一起变暗。

- 换肤只换界面（书桌、菜单栏、侧栏、编辑器、AI 面板），**论文纸面与导出 PDF 始终黑字白页**：TikZ / Mermaid / KaTeX 的描边与字色按浅纸设计，深色皮肤下预览只是把纸色调和一点（冷灰 / 暖米），不会变成黑底图。
- 配色全是 CSS 变量：`src/themes.css` 每套皮肤一个 `@palette` 块（同一套 token，含 CodeMirror 语法色与纸面底色），`src/app.css` 只用 `var()` 消费。加一套皮肤 = 复制一个 `@palette` 块 + 在 `src/theme.js` 的 `THEME_IDS` 与 `i18n.js` 的 `theme.<id>` 补名称，`npm test` 会校验 token 有没有漏、缩略色与调色板是否同源。

## 大纲窗口

左侧栏「☰」：多级大纲（LaTeX 章节 + 子节 / Markdown 标题，带编号缩进）。点击任意条目 → **编辑器跳到对应行（黄色闪烁）+ 预览滚动到对应标题**。

## 项目内搜索

左侧栏「搜」（或「编辑 → 项目内搜索…」）：跨**所有打开的标签（实时内容，含未保存修改）+ 文件夹扫描（.tex / .bib / .md / .txt，各 ≤200KB，深度 2 层）**做 grep——范围与 `\ref`/`\cite` 索引共用同一次磁盘扫描。支持区分大小写 / 整词 / 正则（与编辑器内查找同一套规则，整词边界按 `\p{L}` 判定，中文不误切）；结果按文件分组显示行号与命中高亮，**点击任意命中打开对应文件并跳到该行（黄色闪烁）**——磁盘上没打开的文件也能直接从搜索结果打开。单文件封顶 50 处、全局 500 处（超出截断提示），切侧栏页签不丢结果。逻辑在 `src/searchIndex.js`（纯函数，`test/searchIndex.mjs` 覆盖）。

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

- **保存**：`Ctrl+S` 或「💾 保存」——文件标签写回磁盘原位置；每个草稿标签各存一份到浏览器（多草稿不再互相覆盖，重开页面一起回来）；未保存关闭会确认，磁盘文件还有未保存改动时刷新/关页浏览器会拦一次。存储写满时状态栏直接说明，不会静默丢内容
- **文件夹记忆**：根目录句柄存 IndexedDB，重开浏览器后点「🔓 恢复上次文件夹」即可（需重新授权，浏览器安全策略）

## 核心功能（论文）

编辑器上方的快捷栏参考 Overleaf 的分组方式：AI 助手、撤销/重做、标题与文本格式、公式模板、24 个常用数学符号、链接、源码注释、标签/交叉引用、图片、1–6 行列的表格网格和列表。引用面板自动列出当前文档的标签；插入内容后选中可编辑部分，并可撤销。更多菜单保留流程图、Mermaid、文献和脚注；Markdown 文件的格式、公式、表格及列表按钮使用相应语法。

| 功能 | 说明 |
| --- | --- |
| **实时预览** | React `useDeferredValue` 低优先级渲染，输入不卡顿；标题/章节/公式/表格/引用/脚注/目录即时呈现 |
| **预览口径** | 预览工具条的「近似排版」徽标可展开差异说明：双栏分页、bibtex 文献、自定义宏包与复杂 TikZ 一律以编译后的 PDF 为准，投稿前先编译一次 |
| **公式** | 行内 `$...$`、行间 `\[...\]`、`equation / align / gather / cases` 等环境，KaTeX 渲染，自动编号，`\label` / `\eqref` 交叉引用 |
| **TikZ 流程图** | 内置 TikZ 子集引擎（`src/engines/tikz.js`，无 DOM 依赖、可单测）：矩形/圆/椭圆/菱形、圆角、虚线、颜色混合（`blue!20`）、定位、`-stealth` 箭头、`|-` `-|` 肘形、`to[bend left=30]` 弯曲、路径标签 |
| **可视化改样式** | 点击预览图中的节点，或用「🎨 图样式」面板：改填充/边框/文字色、线宽、虚线、圆角、形状、字号 → **精确写回 LaTeX 源码**（改 `tikzset` 批量生效；改单节点生成内联覆盖，符合 TikZ 优先级语义） |
| **可视化表格编辑** | 预览里的表格悬浮出现「✎」，点开网格面板：**单元格直接改文字**（显示源码原文，`\multicolumn` 等包装照实保留，失焦/回车写回并转义 `& % # _`）、**行的插入/删除**（booktabs 规则线原样保留）、**列的增删**与**列格式（colspec）编辑**。排版引擎渲染时记录每个单元格/行/列格式的源码区间（`latex.js` → `result.tables`），写回按区间精确替换并做最小差异合并（保住撤销历史粒度）；单元格点击的回跳源码行语义不受影响。逻辑在 `src/tableMutations.js`（纯函数，`test/tableMutations.mjs` 用真实渲染区间覆盖） |
| **Mermaid** | `\begin{mermaid}...\end{mermaid}`，按需懒加载（动态 import，不进主包） |
| **导出 PDF** | 「🖨 导出 PDF」调起浏览器打印 → 选「另存为 PDF」。矢量输出、文字可选中、A4 版式 |
| **其他导出** | `.tex`（可传 Overleaf / 本地 TeX 编译）、独立 HTML、单图 SVG（矢量）/ PNG（2x） |
| **编辑器** | CodeMirror 5（stex 高亮、括号匹配/补全、活动行、**代码折叠**）、工具栏插入模板；**插入图片（按钮 / 拖拽 / 粘贴）**：打开文件夹时写入项目目录并插 `\includegraphics`（重名自动加序号、顺手补 `\usepackage{graphicx}`），未打开文件夹时 LaTeX 开内存资源标签、Markdown 转 base64 |
| **自动补全** | `\ref` / `\cite` 跨文件键位之外，补齐 **LaTeX 命令**（内置 90+ 常用命令 + 文档 `\newcommand` 定义，光标停在参数内）、**环境名**（`\begin{` 选定后自动闭合 `\end{}`）、**文件名**（`\input` / `\include` / `\includegraphics` / `\bibliography` 等参数里补项目文件路径）。逻辑在 `src/completion.js`（纯函数，`test/completion.mjs` 覆盖） |
| **文献检索插入** | 「插入 → 文献检索」直连 **Crossref / OpenAlex / DBLP** 公共 API（浏览器发起，不经任何服务器中转）：搜标题/作者/关键词 → 点选条目 → 自动生成 BibTeX 键（首作者姓+年+标题词，撞键自动去重）与条目**追加到 .bib 文件**（优先文档 `\bibliography` 引用的，没有则新建 `refs.bib`；打开文件夹时写盘）→ 光标处插入 `\cite{key}`。逻辑在 `src/citation.js`（纯函数，`test/citation.mjs` 覆盖）；网络层 `src/citationSearch.js` 为桌面/移动共用单入口（`test/citationSearch.mjs` 覆盖），移动端工具带「文献」同款可用 |
| **语法检查** | 可选的 **LanguageTool** 联网检查（设置里开启，默认关闭）：输入停顿约 2 秒后把**正文**发送到 languagetool.org 公共接口——发送前先做等长遮罩，注释/公式/命令/引用键不会外发；紫色波浪线标记，悬停显示问题与替换建议，中文英文都支持。长文按空行分块、每轮最多 3 块，公共接口限流友好。逻辑在 `src/grammar.js`（纯函数，`test/grammar.mjs` 覆盖） |
| **快捷键** | `Ctrl+S` 保存、`Ctrl+Enter` 编译、`Ctrl+P` 下载编译 PDF（源码修改后先确认；尚未编译则打印网页预览）、`Ctrl+1/2/3` 仅编辑/分栏/仅预览、`Ctrl+Alt+N` 新建文件；编辑器内 `Ctrl+B` / `Ctrl+I`。「帮助 → 快捷键」列出全部 |
| **写作专注** | 「查看 → 沉浸模式」（Esc 退出）：隐藏菜单/工具条/侧栏/标签/状态栏，编辑区限宽到 860px 居中，只留编辑与预览；「查看 → 打字机滚动」让光标（含点击定位）始终停在视口中央，长文写作不再追着光标翻页，随设置持久化 |
| **自定义片段** | 「插入 → 我的片段」点选插入光标处，「管理片段…」增删改：把反复重打的结构（定理环境、算法框架、信件抬头）沉淀成模板，存浏览器（`paperlite.snippets.v1`），名称去重校验、坏数据自动容错。逻辑在 `src/snippets.js`（纯函数，`test/snippets.mjs` 覆盖） |
| **中英双语** | 菜单栏右侧「中 / EN」一键切换全部界面文案（菜单/面板/对话框/诊断提示），随浏览器语言自动选择，localStorage 记忆；文档内容语言不受影响 |
| **其他** | 三线表（booktabs + multicolumn）、参考文献自动编号、`\newcommand` 宏展开、ctexart 中文排版、双栏预览、同步滚动、字数统计、警告面板 |

## 移动端（`#/m`）

窄屏界面走独立入口：桌面顶栏「手机版」↔ 移动端设置「切换到桌面版」（切换会 `reload()`，好让脏标签的离开确认照常触发），也可以直接访问 `…/#/m`。

- **不是第二套实现**：文稿、编辑器、近似排版、版本历史、编译、PDF、AI 渠道全部复用桌面同一份代码（`src/workspace/useWorkspace.js` / `useCompile.js` / `chatContext.js` 与 `src/components/` 下的组件），移动端只负责窄屏编排与触控交互
- **三个 Tab**：文稿（列表 / 新建草稿 / 导入）、AI（对话面板嵌入窄屏模式）、设置（皮肤、界面语言、正文字号、引擎与渠道）；工作区、编译、历史是全屏页
- **草稿按浏览器隔离**：手机上写的草稿只在该浏览器里（localStorage），不与电脑同步，清站点数据或 iOS 长期未访问会被系统回收——列表页与恢复横幅都会说明这点
- **不自动预热**：桌面空闲时会预拉约 98 MB TeX 资源，移动端刻意不预拉（可能在蜂窝网络下），只在用户真点「开始编译」时下载，弱网先弹流量确认
- **手机浏览器没有 File System Access API**，因此「打开本地文件夹」在移动端不可用，改用顶栏「导入」上传文件
- 中英双语与六套皮肤在两端一致；正文字号三档（13 / 15 / 17.5px）持久化在本地，纸面预览与编辑区同步
- **编辑器与编译同内核增强**：代码折叠、LaTeX 命令/环境/文件名与 ef/\cite 跨标签补全、LanguageTool 语法检查与打字机滚动（读桌面同一设置键，默认关）在移动端同样可用；编译同样从主文档入口走（打开的标签里自动探测 \documentclass）
- **写作工具带同样接全**：工具带「文献」直连 Crossref / OpenAlex / DBLP 检索并走与桌面同一插入策略（BibTeX 追加 .bib + 光标处 `\cite`）；「搜索」跨打开标签做项目内搜索（点命中跳行）；「插入 → 我的片段」与桌面共享同一份片段库（localStorage 同键），可就地增删改

## 架构

```
paperlite/
├── index.html            # Vite 入口
├── vite.config.js        # PDF 字体资源本地化 + cm5-vim 桥接（UMD 头剥成 ESM，见文件内注释）
├── src/
│   ├── main.jsx          # 挂载
│   ├── App.jsx           # 多标签状态中枢（文件夹/标签/预览路由/保存/同步滚动/快捷键）
│   ├── fs.js             # File System Access API（目录遍历/读写/增删改 + IndexedDB 持久化）
│   ├── mainDoc.js        # 主文档（编译入口）解析：固定设置 + \documentclass 探测（纯函数）
│   ├── completion.js     # LaTeX 命令/环境/文件名补全：匹配器与候选表（纯函数）
│   ├── citation.js       # 文献检索：Crossref/OpenAlex/DBLP 归一化 + BibTeX 生成（纯函数）
│   ├── citationSearch.js # 文献检索网络层：桌面/移动共用的 fetch+解析单入口（纯逻辑）
│   ├── grammar.js        # LanguageTool 语法检查：分块/偏移映射（纯函数，复用拼写遮罩）
│   ├── searchIndex.js    # 项目内搜索：文件清单装配 + grep 限量（纯函数，复用 findModel）
│   ├── tableMutations.js # 表格可视化编辑写回：单元格/行列/colspec 区间替换（纯函数）
│   ├── snippets.js       # 自定义片段：localStorage 存取与名称校验（纯函数）
│   ├── imageInsert.js    # 插入图片统一路径：按钮/拖拽/粘贴 → 写盘或 base64 + figure 环境
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
│       ├── CiteDialog.jsx    # 文献检索对话框（fetch 直连公共 API，纯 UI）
│       ├── GlobalSearchPanel.jsx # 项目搜索侧栏面板（受控组件，状态由 App 持有）
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

流水线步骤：安装依赖 → `npm test`（20 个测试文件、1950+ 断言）→ `npm run test:xelatex`（真实引擎编译回归）→ `vite build` → 部署 `dist/` 到 Pages。

首次启用只需在仓库设置一次：

> **Settings → Pages → Build and deployment → Source 选择「GitHub Actions」**

之后每次 push 到 `main`，约 2 分钟后即可在 `https://<用户名>.github.io/<仓库名>/` 访问线上版本。构建产物为相对路径（`base: './'`），子路径部署无需任何改动。

### 线上（Pages）与本机服务分别用哪个引擎

Pages 是纯静态托管，`fetch('/api/health')` 会 404，应用据此把引擎列表收为 `['builtin']` —— 也就是**真实 TeX 编译在线上照常可用**，走的是浏览器内 WebAssembly 的 XeTeX → XDV → dvipdfmx，宏包/字体来自随站点一起部署的 `public/xelatex/`（不是外部 CDN，`force-cache` + 引擎自带缓存，只有首次要拉约 98 MB）。手机直接打开 Pages 地址也能出真 PDF，代价同样只是首次那一下下载（移动端会先弹流量确认）。

`node server.mjs` 不是「能不能编译」的前提，它的价值是把编译交给**本机完整 TeX 发行版**：任意宏包、`bibtex`、复杂 TikZ 与精确双栏，且没有 98 MB 预热。要手机用本机引擎，需要 `server.mjs` 监听局域网地址（当前写死 `127.0.0.1`）并与手机处于同一网络，属于可选优化。

线上唯一确实需要自备的是 AI 渠道：LLM Mock 接口只在 `server.mjs` 上，Pages 版要在 AI 设置里填一个浏览器可直连（允许 CORS）的 API 渠道。

## 支持的 LaTeX 子集

结构：`\documentclass[选项]{类}`（排版语法：`twocolumn`/`onecolumn`、`8pt…20pt`、`a4paper`/`letterpaper` 等选项驱动预览的双栏、字号与纸宽；ctexart/article/report 与 `IEEEtran` 的 journal/conference/technote 模式已建模）、`\title \author \date \maketitle`、`abstract`、`section` 系列（自动编号、`*` 不编号）、`tableofcontents`、`\newpage`

期刊排版：`\documentclass[journal]{IEEEtran}` 在预览里就是 IEEE 杂志版式——跨栏标题带 + 双栏正文、`\markboth` 期刊页眉、`\authorblockN`/`\authorblockA`/`\and`/`\IEEEauthorrefmark`/`\thanks` 作者带、`\IEEEPARstart` 首字下沉与首词小型大写、`IEEEkeywords` 索引术语、`IEEEbiography`/`IEEEbiographynophoto` 作者简介、`IEEEeqnarray`/`IEEEproof`；章节编号按 IEEE 用 I / A) / 1)。内置 XeLaTeX 已收录 `IEEEtran.cls`（V1.8b）与 `cite.sty`，同一篇文档在 GitHub Pages 纯静态托管下也能编译成真 PDF。

文本：`\textbf \emph \underline \texttt \footnote \cite \ref \eqref \autoref \label \url \href`、列表、`quote/center`、`verbatim/lstlisting`、`~ --- ``...'' \% \& \# \_`、换行 `\\` 及其间距参数 `\\[0.5cm]`（表格行 `\\[6pt]` 同样生效）

浮动体：`figure/figure*/table/table*` + `\includegraphics`（`width=0.8\textwidth` 与 base64）、`\caption` 自动编号、三线表

> 未知命令/环境会被忽略并在状态栏「⚠ 警告」里列出，不会导致整篇渲染失败。需要完整 TeX 排版（自定义宏包、复杂 TikZ、双栏精确分页）时，用「下载 .tex」转 Overleaf / 本地编译即可。

## 已知限制

- 近似预览为论文常用子集，非完整 TeX 引擎；`bibtex` 文献、任意宏包与复杂 TikZ 以「编译」产出的 PDF 为准（内置 XeLaTeX 引擎本身已跑 `bibtex` 通路）
- 文献检索与语法检查是**联网**功能：请求由浏览器直连 Crossref / OpenAlex / DBLP / languagetool.org 公共接口，无服务器中转，也因此受各家限流约束（失败会提示、不影响本地功能）
- 多文件项目编译时，日志行号以主文档为口径：错误发生在子文件里时，行号跳转以打开的主文档标签为准
- `align` 环境整块编号（不逐行编号）；流程图标签中的数学以 Unicode 近似显示
- PDF 页码由浏览器打印对话框的页眉页脚设置控制

## 许可证

本项目基于 **[GPL-3.0](LICENSE)**（GNU General Public License v3.0，SPDX: `GPL-3.0-or-later`）开源发布。

- 任何人都可以自由地使用、学习、修改和再分发本项目
- 基于本项目的衍生作品、二次开发成果在分发时必须同样以 GPL-3.0 开源，并保留原始版权与许可声明
- 完整许可证文本见 [LICENSE](LICENSE)；依赖的第三方库各自遵循其原有许可证（见 `node_modules` 中各包的 LICENSE 文件）

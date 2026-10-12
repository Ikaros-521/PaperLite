import { useEffect, useRef, useState } from 'react';

/* 顶栏：文件夹 / 模板 / 编译 / AI / 导出 + 编辑插入工具 */
export default function Toolbar({ actions, viewMode, setViewMode, latexOk, engines, engine, setEngine, compiling, onCompile, channelCount, onOpenChat, onOpenSettings }) {
  const [tplOpen, setTplOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    const close = e => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setTplOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  const T = [
    ['tSec', 'H1', '插入 \\section'],
    ['tSub', 'H2', '插入 \\subsection'],
    null,
    ['tB', 'B', '加粗 Ctrl+B'],
    ['tI', 'I', '斜体 Ctrl+I'],
    ['tU', 'U', '下划线'],
    ['tTt', 'T', '等宽'],
    null,
    ['tMath', '$x$', '行内公式'],
    ['tEq', '∑', '行间公式环境'],
    null,
    ['tList', '•≡', '无序列表'],
    ['tEnum', '1≡', '有序列表'],
    ['tTable', '▦', '三线表'],
    ['tImg', '🖼', '插入本地图片（base64 内嵌）'],
    ['tFlow', '🔀 流程图', '插入 TikZ 流程图'],
    ['tMermaid', '🏝', '插入 Mermaid 图'],
    null,
    ['tBib', '[引]', '插入引用'],
    ['tFn', '†', '脚注']
  ];

  return (
    <header id="topbar" ref={rootRef}>
      <div className="brand">📄 PaperLite <span className="sub">论文速写 · LaTeX 实时预览</span></div>

      <div className="tb-group">
        <div className="dropdown">
          <button className="btn" onClick={() => setTplOpen(o => !o)}>模板 ▾</button>
          {tplOpen && (
            <div className="menu open">
              <button onClick={() => { actions.loadTemplate('demo'); setTplOpen(false); }}>📄 中文示例论文（推荐）</button>
              <button onClick={() => { actions.loadTemplate('flow'); setTplOpen(false); }}>🔀 TikZ 流程图速查</button>
              <button onClick={() => { actions.loadTemplate('blank'); setTplOpen(false); }}>✒️ 空白论文</button>
            </div>
          )}
        </div>
        <button className="btn" title="打开本地文件夹（文件树 + 读写保存，需 Chrome/Edge）" onClick={actions.openFolder}>📂 打开文件夹</button>
        <button className="btn" title="打开单个文件" onClick={actions.openFile}>🗎 打开文件</button>
        <button className="btn" title="保存当前标签（Ctrl+S）：草稿→浏览器，文件→写回磁盘" onClick={actions.save}>💾 保存</button>
        <span className="tb-compile" title={engines && engines.length ? '本机 TeX 引擎真实编译（pdflatex / latex / xelatex / lualatex）' : '未检测到本机 TeX 引擎（安装 MiKTeX/TeX Live 后经 node server.mjs 访问可用）'}>
          <select value={engine} onChange={e => setEngine(e.target.value)} disabled={!engines || !engines.length}>
            {(engines && engines.length ? engines : ['未检测到引擎']).map(en => <option key={en} value={en}>{en}</option>)}
          </select>
          <button className="btn" disabled={compiling || !engines || !engines.length} onClick={onCompile}>{compiling ? '⟳ 编译中…' : '⚙ TeX 编译'}</button>
        </span>
        <button className="btn" title="AI 渠道设置（多渠道 / 测试连接 / 思维链 / 检索模型）" onClick={onOpenSettings}>🤖 AI 设置{channelCount ? '' : ' ·未配置'}</button>
        <button className="btn" title="AI 对话 / 内容改写" onClick={onOpenChat}>💬 AI 助手</button>
        <button className="btn" title="下载当前 .tex（可导入 Overleaf / 本地 TeX 编译）" onClick={actions.exportTex}>⬇ .tex</button>
        <button className="btn primary" title="调起浏览器打印，选择「另存为 PDF」即得矢量 PDF" onClick={actions.exportPdf}>🖨 导出 PDF</button>
      </div>

      <div className="tb-group edit-tools">
        {T.map((t, i) => t === null
          ? <span key={i} className="tsep"></span>
          : <button
              key={t[0]}
              id={t[0]}
              className={'btn sm' + (t[0] === 'tFlow' ? ' accent' : '')}
              title={latexOk ? t[2] : t[2] + '（当前文件非 .tex/.md，不可用）'}
              disabled={!latexOk}
              onClick={() => latexOk && actions.tool(t[0])}
            >
              {t[1] === 'B' ? <b>B</b> : t[1] === 'I' ? <i>I</i> : t[1] === 'U' ? <u>U</u> : t[1]}
            </button>
        )}
      </div>

      <div className="tb-right">
        <div className="view-switch">
          {[['edit', '✎'], ['split', '▤▤'], ['preview', '👁']].map(([m, ic]) => (
            <button key={m} className={'btn sm' + (viewMode === m ? ' on' : '')} onClick={() => setViewMode(m)}>{ic}</button>
          ))}
        </div>
      </div>
    </header>
  );
}

import { useRef, useState, useEffect } from 'react';

/* 顶栏：模板 / 文件 / 导出 + 编辑插入工具 */
export default function Toolbar({ actions, viewMode, setViewMode }) {
  const [tplOpen, setTplOpen] = useState(false);
  const fileRef = useRef(null);
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
        <button className="btn" title="打开 .tex 文件" onClick={() => fileRef.current && fileRef.current.click()}>📂 打开</button>
        <button className="btn" title="下载 .tex（可导入 Overleaf / 本地 TeX 编译）" onClick={actions.exportTex}>💾 下载 .tex</button>
        <button className="btn" title="导出独立 HTML" onClick={actions.exportHtml}>🌐 导出 HTML</button>
        <button className="btn primary" title="调起浏览器打印，选择「另存为 PDF」即得矢量 PDF" onClick={actions.exportPdf}>🖨 导出 PDF</button>
        <input ref={fileRef} type="file" accept=".tex,.txt,.latex,image/*" hidden onChange={e => { actions.openFile(e.target.files && e.target.files[0]); e.target.value = ''; }} />
      </div>

      <div className="tb-group edit-tools">
        {T.map((t, i) => t === null
          ? <span key={i} className="tsep"></span>
          : <button key={t[0]} id={t[0]} className={'btn sm' + (t[0] === 'tFlow' ? ' accent' : '')} title={t[2]} onClick={() => actions.tool(t[0])}>
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

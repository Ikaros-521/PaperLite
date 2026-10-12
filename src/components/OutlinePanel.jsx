import { useMemo } from 'react';

/* 大纲面板：多级标题，点击跳转（编辑器行 + 预览锚点） */
export default function OutlinePanel({ kind, headings, onJump }) {
  const items = useMemo(() => (headings || []).slice(0, 300), [headings]);

  if (kind !== 'tex' && kind !== 'md' && kind !== 'draft') {
    return <div className="side-pad hint">当前文件不支持大纲（.tex / .md 文件可显示大纲）。</div>;
  }
  if (!items.length) {
    return <div className="side-pad hint">未发现标题。<br />LaTeX：用 \\section / \\subsection；<br />Markdown：用 # / ## 。</div>;
  }

  return (
    <div className="outline">
      {items.map((h, i) => (
        <div
          key={i}
          className={'ol-item ol-l' + h.level}
          onClick={() => onJump(h)}
          title={h.text}
        >
          {h.num ? <span className="ol-num">{h.num}</span> : null}
          <span className="ol-text">{h.text || '(空标题)'}</span>
        </div>
      ))}
    </div>
  );
}

import { useMemo, useRef, useState } from 'react';
import * as TIKZ from '../engines/tikz.js';
import {
  FONT_NAMES, SHAPES, SHAPE_NAMES, LW_OPTIONS, nearestFontPx,
  getRecord, applyChanges, addNewStyle
} from '../styleMutations.js';

/* 图样式编辑面板：样式(tikzset)批量改 + 单节点内联覆盖，修改精确写回源码。
 * 标题栏可拖拽浮窗化（双击标题回停靠），右上 ✕ 关闭。 */
export default function StylePanel({ open, onClose, result, cm, selection, setSelection }) {
  const panelRef = useRef(null);
  const [pos, setPos] = useState(null); // null=停靠右侧；{x,y}=浮动位置
  const diagram = useMemo(() => {
    if (!result || !result.diagrams.length) return null;
    return result.diagrams[Math.min(selection.did, result.diagrams.length - 1)] || null;
  }, [result, selection.did]);

  const record = useMemo(
    () => (cm && result && selection.sel ? getRecord(cm, result, { type: selection.sel.type, did: selection.did, ...selection.sel }) : null),
    [cm, result, selection]
  );

  const cmText = (start, end) => {
    try { return cm.getRange(cm.posFromIndex(start), cm.posFromIndex(end)); } catch (e) { return ''; }
  };

  const swatch = (fill, draw, drawOn) => ({
    background: fill || 'transparent',
    border: '1.5px solid ' + (drawOn ? draw : '#ccc')
  });

  if (!open) return null;

  // 拖拽：按下标题栏（关闭按钮除外）浮窗化并跟随指针，双击标题回停靠
  const startDrag = (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const off = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    setPos({ x: rect.left, y: rect.top });
    const move = (ev) => {
      const w = el.offsetWidth;
      const x = Math.min(Math.max(ev.clientX - off.dx, 60 - w), window.innerWidth - 60);
      const y = Math.min(Math.max(ev.clientY - off.dy, 8), window.innerHeight - 44);
      setPos({ x, y });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
    e.preventDefault();
  };

  return (
    <aside
      id="stylePanel"
      ref={panelRef}
      className={'open' + (pos ? ' floating' : '')}
      style={pos ? { left: pos.x + 'px', top: pos.y + 'px', maxHeight: 'calc(100vh - ' + (pos.y + 16) + 'px)' } : undefined}
    >
      <div className="sp-title" onPointerDown={startDrag} onDoubleClick={() => setPos(null)}>
        <span className="sp-drag" title="拖拽移动面板（双击标题回到停靠）">⠿</span>
                <span className="sp-t">图样式编辑</span>
        <span className="sp-head-acts">
          <button title="关闭" onClick={onClose}>✕</button>
        </span>
      </div>

      {!result || !result.diagrams.length ? (
        <div className="sp-empty">
          文档中还没有 tikzpicture 流程图。
          <div className="sp-hint">在工具栏点「流程图」插入一个试试。</div>
        </div>
      ) : (
        <>
          {result.diagrams.length > 1 && (
            <div className="sp-tabs">
              {result.diagrams.map((d, i) => (
                <button
                  key={i}
                  className={'sp-tab' + (i === selection.did ? ' on' : '')}
                  onClick={() => setSelection({ did: i, sel: null })}
                >图 {i + 1}</button>
              ))}
            </div>
          )}

          <div className="sp-sec">
            <div className="sp-sec-h">样式（tikzset）</div>
            {!(diagram && diagram.tikzsetRanges && diagram.tikzsetRanges.length) && (
              <div className="sp-hint">本文档还没有定义样式，可点击下方新建。</div>
            )}
            {(diagram && diagram.tikzsetRanges || []).map((sr, i) => {
              const itp = TIKZ.interpret(TIKZ.parseOpts(cmText(sr.start, sr.end) || ''));
              return (
                <div
                  key={i}
                  className={'sp-item' + (selection.sel && selection.sel.type === 'style' && selection.sel.key === sr.name ? ' on' : '')}
                  onClick={() => setSelection({ did: selection.did, sel: { type: 'style', key: sr.name } })}
                >
                  <span className="sw" style={swatch(
                    itp.fill && itp.fill !== 'none' ? itp.fill : null,
                    itp.draw && itp.draw !== 'none' ? itp.draw : '#ccc',
                    !(itp.draw === undefined || itp.draw === null || itp.draw === 'none')
                  )} />
                  <code>{sr.name}</code>
                </div>
              );
            })}
            <button className="sp-newstyle" onClick={() => {
              if (!cm) return;
              const name = addNewStyle(cm);
              setSelection(s => ({ did: s.did, sel: { type: 'style', key: name } }));
            }}>＋ 新建样式</button>
          </div>

          <div className="sp-sec">
            <div className="sp-sec-h">节点（点击图可选中）</div>
            {!(diagram && diagram.nodes && diagram.nodes.length) && <div className="sp-hint">本图没有命名节点。</div>}
            {(diagram && diagram.nodes || []).map((nd, i) => (
              <div
                key={i}
                className={'sp-item' + (selection.sel && selection.sel.type === 'node' && selection.sel.sidx === nd.sidx ? ' on' : '')}
                onClick={() => setSelection({ did: selection.did, sel: { type: 'node', sidx: nd.sidx } })}
              >
                <span className="sw sw-sm" style={swatch(nd.fill, nd.draw, nd.drawOn)} />
                <code>{nd.name || '·'}</code>
                <span className="sp-ntext" title={nd.text || ''}>{nd.text || ''}</span>
              </div>
            ))}
          </div>

          {record && (
            <RecordForm
              key={record.kind === 'style' ? 's-' + record.name : 'n-' + record.node.sidx + '-' + result.diagrams.length + '-' + (record.node.optStart)}
              record={record}
              cm={cm}
            />
          )}
        </>
      )}
    </aside>
  );
}

/* 属性表单（key 变化时重挂载重置；应用时直接读控件当前值，健壮不依赖事件记账） */
function RecordForm({ record, cm }) {
  const p = record.props;
  const formElRef = useRef(null);
  const head = record.kind === 'style'
    ? '样式 “' + record.name + '”'
    : '节点 ' + (record.node.name || '');

  const apply = () => {
    const el = formElRef.current;
    if (!el) return;
    const g = name => el.querySelector('[name="' + name + '"]');
    applyChanges(cm, record, {
      fillOn: g('fillOn').checked, fill: g('fill').value,
      borderOn: g('borderOn').checked, borderColor: g('borderColor').value,
      textOn: g('textOn').checked, text: g('text').value,
      lwPt: g('lwPt').value, dashed: g('dashed').checked,
      shape: g('shape').value, round: parseFloat(g('round').value) || 0,
      fontPx: g('fontPx') ? g('fontPx').value : null
    });
  };

  const colorRow = (label, onName, hexName, onInit, hexInit) => (
    <label className="sp-row">
      <span className="sp-lb">{label}</span>
      <span className="sp-cw">
        <input type="checkbox" name={onName} defaultChecked={onInit}
          onClick={e => { e.target.nextElementSibling.disabled = !e.target.checked; }} />
        <input type="color" name={hexName} defaultValue={hexInit} disabled={!onInit} />
      </span>
    </label>
  );

  return (
    <div className="sp-form" ref={formElRef}>
      <div className="sp-form-h">{head}</div>
      {colorRow('填充色', 'fillOn', 'fill', !!p.fill, p.fill || '#ffffff')}
      {colorRow('边框', 'borderOn', 'borderColor', !!p.border, p.borderColor || '#000000')}
      {colorRow('文字色', 'textOn', 'text', !!p.textColor, p.textColor || '#111111')}
      <label className="sp-row">
        <span className="sp-lb">线宽</span>
        <select name="lwPt" defaultValue={String(p.lwPt || 0.4)}>
          {LW_OPTIONS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
      </label>
      <label className="sp-row">
        <span className="sp-lb">虚线</span>
        <input type="checkbox" name="dashed" defaultChecked={!!p.dashed} />
      </label>
      <label className="sp-row">
        <span className="sp-lb">形状</span>
        <select name="shape" defaultValue={p.shape || 'rectangle'}>
          {SHAPES.map(s => <option key={s} value={s}>{SHAPE_NAMES[s]}</option>)}
        </select>
      </label>
      <label className="sp-row">
        <span className="sp-lb">圆角(pt)</span>
        <input type="number" name="round" min="0" max="30" step="1" style={{ width: 70 }} defaultValue={p.roundedPt || 0} />
      </label>
      {record.kind === 'node' && (
        <label className="sp-row">
          <span className="sp-lb">字号</span>
          <select name="fontPx" defaultValue={String(nearestFontPx(p.fontpx))}>
            {Object.keys(FONT_NAMES).map(px => <option key={px} value={px}>{px}px</option>)}
          </select>
        </label>
      )}
      <button className="sp-apply" onClick={apply}>✓ 应用到源码</button>
      {record.kind === 'node' && (
        <div className="sp-hint">提示：给节点指定样式名（如 block）后，改样式可一次作用于全部同类节点。</div>
      )}
    </div>
  );
}

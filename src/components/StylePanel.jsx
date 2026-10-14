import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../useI18n.js';
import * as TIKZ from '../engines/tikz.js';
import {
  FONT_NAMES, SHAPES, SHAPE_NAMES, LW_OPTIONS, nearestFontPx,
  getRecord, applyChanges, addNewStyle
} from '../styleMutations.js';
import {
  findMermaidBlocks, readMermaidInit, readMermaidNodeStyle,
  readMermaidDirection, applyMermaidNodeStyle, applyMermaidTheme, applyMermaidDirection,
  readMermaidGeoms, applyMermaidNodeGeom
} from '../mermaidMutations.js';

/* 图样式编辑面板：TikZ 样式(tikzset)批量改 + 单节点内联覆盖 + 布局；
 * Mermaid 节点颜色（style 行）与全局主题/方向/间距（init 头），修改精确写回源码。
 * 标题栏可拖拽浮窗化（双击标题回停靠），右上 ✕ 关闭。 */
export default function StylePanel({ open, onClose, result, cm, selection, setSelection }) {
  const t = useT();
  const panelRef = useRef(null);
  const [pos, setPos] = useState(null); // null=停靠右侧；{x,y}=浮动位置
  const diagram = useMemo(() => {
    if (!result || !result.diagrams.length) return null;
    return result.diagrams[Math.min(selection.did, result.diagrams.length - 1)] || null;
  }, [result, selection.did]);

  const record = useMemo(
    () => (cm && result && selection.sel && selection.sel.type !== 'mermaid'
      ? getRecord(cm, result, { type: selection.sel.type, did: selection.did, ...selection.sel }) : null),
    [cm, result, selection]
  );

  // Mermaid 记录：{kind:'mermaidNode'|'mermaidTheme', block, id?, range, code, props}
  const mmRecord = useMemo(() => {
    if (!cm || !selection.sel || selection.sel.type !== 'mermaid') return null;
    const src = cm.getValue();
    const range = findMermaidBlocks(src)[selection.sel.block];
    if (!range) return null;
    const code = src.slice(range.start, range.end);
    const cur = selection.sel.cur || {};
    if (selection.sel.id) {
      const st = readMermaidNodeStyle(code, selection.sel.id) || {};
      const gSrc = readMermaidGeoms(code)[selection.sel.id] || {};
      return {
        kind: 'mermaidNode', block: selection.sel.block, id: selection.sel.id, range, code,
        props: {
          fill: st.fill || cur.fill || null,
          stroke: st.stroke || cur.stroke || null,
          color: st.color || cur.color || null,
          // 布局：源码注释行的已存值优先，否则用点击时从 SVG 读到的 dagre 值
          gx: gSrc.x != null ? gSrc.x : (cur.x != null ? cur.x : null),
          gy: gSrc.y != null ? gSrc.y : (cur.y != null ? cur.y : null),
          gs: gSrc.s != null ? gSrc.s : (cur.s != null ? cur.s : 1),
          gw: gSrc.w != null ? gSrc.w : (cur.w != null ? cur.w : null),
          gh: gSrc.h != null ? gSrc.h : (cur.h != null ? cur.h : null)
        }
      };
    }
    const init = readMermaidInit(code);
    const vars = (init && init.json.themeVariables) || {};
    const fl = (init && init.json.flowchart) || {};
    return {
      kind: 'mermaidTheme', block: selection.sel.block, range, code,
      props: {
        dir: readMermaidDirection(code) || 'TB',
        nodeSpacing: fl.nodeSpacing != null ? fl.nodeSpacing : 50,
        rankSpacing: fl.rankSpacing != null ? fl.rankSpacing : 50,
        primary: vars.primaryColor || cur.primary || null,
        border: vars.primaryBorderColor || cur.border || null,
        text: vars.primaryTextColor || cur.text || null,
        line: vars.lineColor || cur.line || null
      }
    };
  }, [cm, selection, result]);

  // 选中变化后把属性表单滚入视野：列表占满一屏时表单（含常驻应用按钮）不用手动找
  useEffect(() => {
    const el = panelRef.current && panelRef.current.querySelector('.sp-form');
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selection, result]);

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
        <span className="sp-drag" title={t('style.drag')}>⠿</span>
                <span className="sp-t">{t('style.title')}</span>
        <span className="sp-head-acts">
          <button title={t('style.close')} onClick={onClose}>✕</button>
        </span>
      </div>

      {!result || !result.diagrams.length ? (
        <div className="sp-empty">
          {t('style.empty')}
          <div className="sp-hint">{t('style.emptyHint')}</div>
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
                >{t('style.fig', { n: i + 1 })}</button>
              ))}
            </div>
          )}

          <div className="sp-sec">
            <div className="sp-sec-h">{t('style.styles')}</div>
            {!(diagram && diagram.tikzsetRanges && diagram.tikzsetRanges.length) && (
              <div className="sp-hint">{t('style.noStyles')}</div>
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
            }}>{t('style.new')}</button>
          </div>

          <div className="sp-sec">
            <div className="sp-sec-h">{t('style.nodes')}</div>
            {!(diagram && diagram.nodes && diagram.nodes.length) && <div className="sp-hint">{t('style.noNodes')}</div>}
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
          {!record && mmRecord && (
            <MermaidForm
              key={'m-' + mmRecord.kind + '-' + mmRecord.block + '-' + (mmRecord.id || '') + '-' + mmRecord.range.start}
              record={mmRecord}
              cm={cm}
            />
          )}
        </>
      )}
    </aside>
  );
}

/* 滑动条行：range 拖动与数值框双向联动；应用时仍读数值框（name=numName） */
function SliderRow({ label, numName, min, max, step, init, unit }) {
  const rowRef = useRef(null);
  const round = v => Math.round(v * 100) / 100;
  return (
    <div className="sp-slider-row" ref={rowRef}>
      <span className="sp-lb">{label}</span>
      <input type="range" min={min} max={max} step={step} defaultValue={init == null || isNaN(+init) ? min : +init}
        onInput={e => {
          const num = rowRef.current && rowRef.current.querySelector('input[type=number]');
          if (num) num.value = round(+e.target.value);
        }} />
      <input type="number" name={numName} min={min} max={max} step={step} defaultValue={init == null || isNaN(+init) ? '' : round(+init)}
        onInput={e => {
          const r = rowRef.current && rowRef.current.querySelector('input[type=range]');
          if (r && e.target.value !== '' && !isNaN(+e.target.value)) r.value = Math.min(max, Math.max(min, +e.target.value));
        }} />
      <span className="sp-unit">{unit}</span>
    </div>
  );
}

/* 属性表单（key 变化时重挂载重置；应用时直接读控件当前值，健壮不依赖事件记账） */
function RecordForm({ record, cm }) {
  const t = useT();
  const p = record.props;
  const formElRef = useRef(null);
  const head = record.kind === 'style'
    ? t('style.headStyle', { name: record.name })
    : t('style.headNode', { name: record.node.name || '' });

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
      fontPx: g('fontPx') ? g('fontPx').value : null,
      ...(record.kind === 'node' ? {
        posX: parseFloat(g('posX').value), posY: parseFloat(g('posY').value),
        wcm: parseFloat(g('wcm').value), hcm: parseFloat(g('hcm').value)
      } : {})
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
      {colorRow(t('style.fill'), 'fillOn', 'fill', !!p.fill, p.fill || '#ffffff')}
      {colorRow(t('style.border'), 'borderOn', 'borderColor', !!p.border, p.borderColor || '#000000')}
      {colorRow(t('style.text'), 'textOn', 'text', !!p.textColor, p.textColor || '#111111')}
      <label className="sp-row">
        <span className="sp-lb">{t('style.lw')}</span>
        <select name="lwPt" defaultValue={String(p.lwPt || 0.4)}>
          {LW_OPTIONS.map(o => <option key={o.v} value={o.v}>{t(o.key)}</option>)}
        </select>
      </label>
      <label className="sp-row">
        <span className="sp-lb">{t('style.dashed')}</span>
        <input type="checkbox" name="dashed" defaultChecked={!!p.dashed} />
      </label>
      <label className="sp-row">
        <span className="sp-lb">{t('style.shape')}</span>
        <select name="shape" defaultValue={p.shape || 'rectangle'}>
          {SHAPES.map(s => <option key={s} value={s}>{SHAPE_NAMES[s]}</option>)}
        </select>
      </label>
      <label className="sp-row">
        <span className="sp-lb">{t('style.round')}</span>
        <input type="number" name="round" min="0" max="30" step="1" style={{ width: 70 }} defaultValue={p.roundedPt || 0} />
      </label>
      {record.kind === 'node' && (
        <label className="sp-row">
          <span className="sp-lb">{t('style.font')}</span>
          <select name="fontPx" defaultValue={String(nearestFontPx(p.fontpx))}>
            {Object.keys(FONT_NAMES).map(px => <option key={px} value={px}>{px}px</option>)}
          </select>
        </label>
      )}
      {record.kind === 'node' && (
        <>
          <div className="sp-geo-h">布局</div>
          <div className="sp-geo-grid">
            <label className="sp-row">
              <span className="sp-lb">位置 X</span>
              <input type="number" name="posX" step="0.1" defaultValue={p.posX} />
              <span className="sp-unit">cm</span>
            </label>
            <label className="sp-row">
              <span className="sp-lb">位置 Y</span>
              <input type="number" name="posY" step="0.1" defaultValue={p.posY} />
              <span className="sp-unit">cm</span>
            </label>
          </div>
          <SliderRow label="宽度" numName="wcm" min={0} max={8} step={0.1} init={p.wcm} unit="cm" />
          <SliderRow label="高度" numName="hcm" min={0} max={8} step={0.1} init={p.hcm} unit="cm" />
          <div className="sp-hint">
            {p.placed ? '该节点原本相对定位，应用位置后会改写为绝对坐标。' : ''}
            宽高为最小尺寸（文字更宽时以文字为准），拉到最左(0)恢复自动。
          </div>
        </>
      )}
      <div className="sp-apply-row">
        <button className="sp-apply" onClick={apply}>{t('style.apply')}</button>
        <button className="sp-undo" title={t('style.undoTip')} onClick={() => { cm.undo(); cm.focus(); }}>↶ {t('style.undo')}</button>
      </div>
      {record.kind === 'node' && (
        <div className="sp-hint">{t('style.nodeTip')}</div>
      )}
    </div>
  );
}

/* Mermaid 表单：节点颜色（写回 style 行）与全局主题/方向/间距（写回 %%{init:…}%% 头）。
 * Mermaid 为 dagre 自动布局，节点坐标不可自由指定，布局维度为方向与间距。 */
function MermaidForm({ record, cm }) {
  const t = useT();
  const p = record.props;
  const formElRef = useRef(null);

  const apply = () => {
    const el = formElRef.current;
    if (!el) return;
    const g = name => el.querySelector('[name="' + name + '"]');
    const colorVal = (onName, hexName) => (g(onName) && g(onName).checked ? g(hexName).value : null);
    let code = record.code;
    if (record.kind === 'mermaidNode') {
      // 只写有变化或被取消勾选的键：勾选且未改动 = 维持现状，避免把主题默认值固化进 style 行
      const diff = (onName, hexName, key) => {
        if (!g(onName).checked) return [key, null];
        const v = g(hexName).value;
        return [key, v && v.toLowerCase() !== String(p[key] || '').toLowerCase() ? v : undefined];
      };
      const colors = {};
      [diff('fillOn', 'fill', 'fill'), diff('strokeOn', 'stroke', 'stroke'), diff('colorOn', 'color', 'color')]
        .forEach(([k, v]) => { colors[k] = v; });
      code = applyMermaidNodeStyle(code, record.id, colors);
      // 布局：输入有变才写；清空 = 删除该键回到 dagre 自动布局
      const numOrEmpty = n => { const v = String(g(n).value).trim(); return v === '' ? '' : parseFloat(v); };
      const geom = {};
      [['x', 'gx'], ['y', 'gy'], ['s', 'gs'], ['w', 'gw'], ['h', 'gh']].forEach(([k, name]) => {
        const v = numOrEmpty(name);
        const init = p[name];
        if (v === '') { if (init != null) geom[k] = null; }
        else if (!isNaN(v) && (init == null || Math.abs(v - init) > 0.011)) geom[k] = v;
      });
      if (Object.keys(geom).length) code = applyMermaidNodeGeom(code, record.id, geom);
    } else {
      code = applyMermaidDirection(code, g('dir').value);
      const vars = {};
      const put = (k, onName, hexName) => { const v = colorVal(onName, hexName); if (v) vars[k] = v; };
      put('primaryColor', 'pOn', 'primary');
      put('primaryBorderColor', 'bOn', 'border');
      put('primaryTextColor', 'tOn', 'text');
      put('lineColor', 'lOn', 'line');
      const flow = {};
      const num = (name, def) => { const v = parseFloat(g(name).value); return isNaN(v) || v < 4 ? def : Math.round(v); };
      flow.nodeSpacing = num('nodeSpacing', p.nodeSpacing);
      flow.rankSpacing = num('rankSpacing', p.rankSpacing);
      code = applyMermaidTheme(code, { themeVariables: vars, flowchart: flow });
    }
    // operation 包裹：整次应用合为单个撤销步骤，↶ 撤销一次即可完整恢复
    cm.operation(function () {
      cm.replaceRange(code, cm.posFromIndex(record.range.start), cm.posFromIndex(record.range.end));
    });
  };

  const colorRow = (label, onName, hexName, onInit, hexInit) => (
    <label className="sp-row">
      <span className="sp-lb">{label}</span>
      <span className="sp-cw">
        <input type="checkbox" name={onName} defaultChecked={onInit}
          onClick={e => { e.target.nextElementSibling.disabled = !e.target.checked; }} />
        <input type="color" name={hexName} defaultValue={hexInit || '#ffffff'} disabled={!onInit} />
      </span>
    </label>
  );

  const isNode = record.kind === 'mermaidNode';
  return (
    <div className="sp-form" ref={formElRef}>
      <div className="sp-form-h">{isNode ? 'Mermaid 节点 ' + record.id : 'Mermaid 全局样式'}</div>
      {isNode ? (
        <>
          {colorRow('填充色', 'fillOn', 'fill', !!p.fill, p.fill || '#ffffff')}
          {colorRow('边框色', 'strokeOn', 'stroke', !!p.stroke, p.stroke || '#333333')}
          {colorRow('文字色', 'colorOn', 'color', !!p.color, p.color || '#333333')}
          <div className="sp-geo-h">布局</div>
          <div className="sp-geo-grid">
            <label className="sp-row">
              <span className="sp-lb">位置 X</span>
              <input type="number" name="gx" step="1" defaultValue={p.gx != null ? p.gx : ''} placeholder="自动" />
              <span className="sp-unit">px</span>
            </label>
            <label className="sp-row">
              <span className="sp-lb">位置 Y</span>
              <input type="number" name="gy" step="1" defaultValue={p.gy != null ? p.gy : ''} placeholder="自动" />
              <span className="sp-unit">px</span>
            </label>
          </div>
          <SliderRow label="缩放" numName="gs" min={0.5} max={2} step={0.1} init={p.gs != null ? p.gs : 1} unit="×" />
          <SliderRow label="宽度" numName="gw" min={20} max={400} step={4} init={p.gw} unit="px" />
          <SliderRow label="高度" numName="gh" min={16} max={300} step={4} init={p.gh} unit="px" />
          <div className="sp-hint">取消勾选颜色项即回到主题默认；位置/大小清空恢复自动布局。覆盖值写为源码注释行（%% pl … %%），导出不受影响。</div>
        </>
      ) : (
        <>
          <label className="sp-row">
            <span className="sp-lb">方向</span>
            <select name="dir" defaultValue={p.dir || 'TB'}>
              <option value="TB">竖排 ↓（TB）</option>
              <option value="LR">横排 →（LR）</option>
              <option value="RL">横排 ←（RL）</option>
              <option value="BT">竖排 ↑（BT）</option>
            </select>
          </label>
          <label className="sp-row">
            <span className="sp-lb">节点间距</span>
            <input type="number" name="nodeSpacing" min="4" step="2" style={{ width: 70 }} defaultValue={p.nodeSpacing} />
            <span className="sp-unit">px</span>
          </label>
          <label className="sp-row">
            <span className="sp-lb">层级间距</span>
            <input type="number" name="rankSpacing" min="4" step="2" style={{ width: 70 }} defaultValue={p.rankSpacing} />
            <span className="sp-unit">px</span>
          </label>
          <div className="sp-geo-h">主题色</div>
          {colorRow('节点填充', 'pOn', 'primary', true, p.primary || '#ececff')}
          {colorRow('节点边框', 'bOn', 'border', true, p.border || '#9370db')}
          {colorRow('文字', 'tOn', 'text', true, p.text || '#333333')}
          {colorRow('连线', 'lOn', 'line', true, p.line || '#333333')}
          <div className="sp-hint">写回为代码块头部的 {'%%{init: …}%%'} 配置；点击图中空白处进入这里。</div>
        </>
      )}
      <div className="sp-apply-row">
        <button className="sp-apply" onClick={apply}>✓ {t('style.apply')}</button>
        <button className="sp-undo" title={t('style.undoTip')} onClick={() => { cm.undo(); cm.focus(); }}>↶ {t('style.undo')}</button>
      </div>
    </div>
  );
}

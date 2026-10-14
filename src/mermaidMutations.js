/* PaperLite · Mermaid 样式回写纯逻辑（与 styleMutations.js 同层，无 DOM/React 依赖，可单测）
 * 定位文档中第 N 个 mermaid 代码块（兼容 \begin{mermaid} 与 ```mermaid），
 * 主题/方向/间距写回 %%{init:…}%% 头，节点颜色写回 style <id> fill:… 行。 */

// 文档中所有 mermaid 代码块的内容区间（按出现顺序）
export function findMermaidBlocks(src) {
  const out = [];
  let m;
  const reEnv = /\\begin\{mermaid\}([\s\S]*?)\\end\{mermaid\}/g;
  while ((m = reEnv.exec(src))) {
    out.push({ start: m.index + m[0].length - m[1].length - 13, end: m.index + m[0].length - 13 });
  }
  const reFence = /```mermaid[^\n]*\n([\s\S]*?)```/g;
  while ((m = reFence.exec(src))) {
    out.push({ start: m.index + m[0].length - m[1].length - 3, end: m.index + m[0].length - 3 });
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---- %%{init: …}%% 头 ----
export function readMermaidInit(code) {
  const i = code.indexOf('%%{init:');
  if (i < 0) return null;
  const brace = code.indexOf('{', code.indexOf(':', i)); // 跳过 %%{init: 的外壳，定位 JSON 的 {
  if (brace < 0) return null;
  // 花括号配平找 JSON 结束（%%{init: {json}}%% 里外壳 } 会让 "}%%" 的朴素查找切错位置）
  let depth = 0, j = brace;
  for (; j < code.length; j++) {
    if (code.charAt(j) === '{') depth++;
    else if (code.charAt(j) === '}') { depth--; if (depth === 0) break; }
  }
  if (j >= code.length || depth !== 0) return null;
  const tail = code.slice(j + 1, j + 4);
  let json = {};
  try { json = JSON.parse(code.slice(brace, j + 1)); } catch (e) { /* 宽松降级为空配置 */ }
  return { start: i, end: j + 1 + (tail === '}%%' ? 3 : tail === '%%' ? 2 : 0), json: (json && typeof json === 'object') ? json : {} };
}

function deepMerge(target, patch) {
  Object.keys(patch).forEach(k => {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) deepMerge(target[k], v);
    else target[k] = v;
  });
  return target;
}

// 合并写回 init 头（themeVariables / flowchart 等），无则插到首行
export function applyMermaidTheme(code, patch) {
  const cur = readMermaidInit(code);
  const dir = '%%{init: ' + JSON.stringify(patch) + '}%%\n';
  if (!cur) return (code.startsWith('\n') ? '' : '\n') + dir + code;
  const cfg = deepMerge(cur.json, patch);
  return code.slice(0, cur.start) + '%%{init: ' + JSON.stringify(cfg) + '}%%' + code.slice(cur.end);
}

// ---- 方向（flowchart LR / graph TB …）----
export function readMermaidDirection(code) {
  const m = code.match(/\b(?:flowchart|graph)\s+(TB|TD|BD|LR|RL)\b/);
  return m ? (m[1] === 'TD' ? 'TB' : m[1]) : null;
}

export function applyMermaidDirection(code, dir) {
  return code.replace(/\b(flowchart|graph)\s+(TB|TD|BD|LR|RL)\b/, (all, kw) => kw + ' ' + dir);
}

// ---- 节点 style 行 ----
function parseStyleLine(line, id) {
  const opts = {};
  const body = line.replace(/^style\s+\S+\s*/, '');
  body.split(',').forEach(kv => {
    const i = kv.indexOf(':');
    if (i > 0) opts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  });
  return opts;
}

export function readMermaidNodeStyle(code, id) {
  const re = new RegExp('^style\\s+' + id + '\\s+([^\\n]*)$', 'm');
  const m = code.match(re);
  if (!m) return null;
  const opts = parseStyleLine(m[0], id);
  return { fill: opts.fill || null, stroke: opts.stroke || null, color: opts.color || null };
}

// colors: {fill, stroke, color}，null = 删除该键（回到主题默认），undefined = 不动
export function applyMermaidNodeStyle(code, id, colors) {
  const lines = code.split('\n');
  const re = new RegExp('^style\\s+' + id + '\\s');
  const build = (existing) => {
    const opts = existing ? parseStyleLine(existing, id) : {};
    ['fill', 'stroke', 'color'].forEach(k => {
      if (colors[k] === null) delete opts[k];
      else if (colors[k] !== undefined && colors[k] !== '') opts[k] = colors[k];
    });
    const parts = Object.keys(opts).map(k => k + ':' + opts[k]).join(', ');
    return parts ? 'style ' + id + ' ' + parts : null; // null = 该行已无内容，删除
  };

  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    const next = build(lines[i]);
    if (next === null) lines.splice(i, 1);
    else lines[i] = next;
    return lines.join('\n');
  }
  const next = build('');
  if (next === null) return code;
  const appended = lines.concat(next).join('\n');
  // 追加到末行后补一个换行，避免与后续的 \end{mermaid} / ``` 粘在同一行
  return appended.endsWith('\n') ? appended : appended + '\n';
}

// ---- 自定义布局（%% pl <id> x=.. y=.. s=.. w=.. h=.. %%）----
// mermaid 为 dagre 自动布局，无逐节点坐标语法；这里用注释行承载 PaperLite 的
// 布局覆盖（真实 mermaid 编译时注释被忽略，不影响导出）。渲染后由 PreviewPane
// 解析并应用到 SVG：x/y/s 写 g.node 的 transform，w/h 改 rect 尺寸（中心定位）。
export function readMermaidGeoms(code) {
  const out = {};
  const re = /^%%\s*pl\s+([A-Za-z][A-Za-z0-9_]*)\s+([^%\n]*?)\s*%%\s*$/gm;
  let m;
  while ((m = re.exec(String(code || '')))) {
    const g = {};
    m[2].split(/\s+/).forEach(kv => {
      const e = kv.indexOf('=');
      if (e > 0) { const v = parseFloat(kv.slice(e + 1)); if (!isNaN(v)) g[kv.slice(0, e)] = v; }
    });
    out[m[1]] = g;
  }
  return out;
}

// patch: {x,y,s,w,h}；值为 null 删除该键（回到自动布局），全部删空则移除整行
export function applyMermaidNodeGeom(code, id, patch) {
  const lines = String(code || '').split('\n');
  const re = new RegExp('^%%\\s*pl\\s+' + id + '\\s+([^%\\n]*?)\\s*%%\\s*$');
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    const opts = {};
    (lines[i].match(re)[1] || '').split(/\s+/).forEach(kv => {
      const e = kv.indexOf('=');
      if (e > 0) opts[kv.slice(0, e)] = kv.slice(e + 1);
    });
    Object.keys(patch).forEach(k => {
      if (patch[k] === null || patch[k] === undefined || patch[k] === '') delete opts[k];
      else opts[k] = String(patch[k]);
    });
    const body = Object.keys(opts).map(k => k + '=' + opts[k]).join(' ');
    if (!body) lines.splice(i, 1);
    else lines[i] = '%% pl ' + id + ' ' + body + ' %%';
    return lines.join('\n');
  }
  const body = Object.keys(patch)
    .filter(k => patch[k] !== null && patch[k] !== undefined && patch[k] !== '')
    .map(k => k + '=' + patch[k]).join(' ');
  if (!body) return code;
  lines.push('%% pl ' + id + ' ' + body + ' %%');
  // 追加到末行后补一个换行，避免与后续的 \end{mermaid} / ``` 粘在同一行
  const appended = lines.join('\n');
  return appended.endsWith('\n') ? appended : appended + '\n';
}

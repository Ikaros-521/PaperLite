/**
 * AI Agent 工具注册表（框架侧的唯一事实来源）。
 *
 * 为什么要从 agentTools.js 的散文清单里拆出来：原先工具定义只有一段给人看的中文
 * 说明，参数对不对要等工具真的跑起来才知道——非法调用照样进执行器，错误信息还散在
 * 九个工具函数里各写一套。注册表把这些收在一处：
 *   1) 入参 schema（类型/必填/长度上限/枚举/别名）→ 框架在执行前拦截；
 *   2) 是否改盘、是否只读 → 权限档与配额按此判断；
 *   3) 失败降级建议 → 同一个错误码在任何工具里给出同一条纠正指引；
 *   4) 给模型看的工具清单 → 由定义生成，不再手写第二份（手写必然与实现漂移）。
 * 纯逻辑模块：不 import React、不碰浏览器 API，Node 单测直接跑。
 */
import { tr, getLang } from '../i18n.js';

/* ---- 参数规格 ----
 * type: 'string' | 'bool' | 'int'
 * required / max（string 长度上限、int 取值上限）/ min（int 下限）/ enum
 * alias: 模型常写驼峰，与下划线名视为同一个参数（只认注册表列出的别名，不做模糊匹配）
 */
const S = (opts = {}) => ({ type: 'string', ...opts });
const B = (opts = {}) => ({ type: 'bool', ...opts });
const N = (opts = {}) => ({ type: 'int', ...opts });

// 路径与文本块的长度上限：这些串会进 prompt 或进文件系统调用，不设上限等于
// 让一次畸形输出吃掉整轮预算（工具结果另有 TOOL_RESULT_MAX_CHARS 截断，那是出口侧）
const PATH_MAX = 400;
const QUERY_MAX = 200;
const TEXT_MAX = 200_000;
const CONTENT_MAX = 2_000_000;
const LINES_MAX = 400;

/**
 * 工具定义。domain='fs' 落到执行器；domain='task' 由运行循环就地处理（状态所有权
 * 属于框架，计划类动作校验通过就直接写任务状态，不进文件执行器）。
 * readOnly 决定调用台账能否命中缓存；codes 列出该工具会返回的错误码，供降级表校验。
 */
export const TOOL_DEFS = [
  {
    name: 'list_files', domain: 'fs', readOnly: true, mutates: false,
    descKey: 'agent.tListFiles', args: {},
  },
  {
    name: 'read_file', domain: 'fs', readOnly: true, mutates: false,
    descKey: 'agent.tReadFile',
    args: {
      path: S({ required: true, max: PATH_MAX }),
      // 局部读取：长文档整篇读进来会挤爆预算，给了行区间模型才会分批看
      from_line: N({ min: 1, max: 100000, alias: ['fromLine'] }),
      max_lines: N({ min: 1, max: LINES_MAX, alias: ['maxLines'] }),
    },
  },
  {
    name: 'open_file', domain: 'fs', readOnly: true, mutates: false,
    descKey: 'agent.tOpenFile',
    args: { path: S({ required: true, max: PATH_MAX }) },
  },
  {
    name: 'search_files', domain: 'fs', readOnly: true, mutates: false,
    descKey: 'agent.tSearch',
    args: {
      query: S({ required: true, max: QUERY_MAX }),
      regex: B({ alias: ['useRegex'] }),
      match_case: B({ alias: ['matchCase'] }),
      whole_word: B({ alias: ['wholeWord'] }),
    },
  },
  {
    name: 'read_selection', domain: 'fs', readOnly: true, mutates: false,
    descKey: 'agent.tReadSel', args: {},
  },
  {
    name: 'get_diagnostics', domain: 'fs', readOnly: true, mutates: false,
    descKey: 'agent.tDiag', args: {},
  },
  {
    name: 'edit_file', domain: 'fs', readOnly: false, mutates: true,
    descKey: 'agent.tEditFile',
    args: {
      old_text: S({ required: true, max: TEXT_MAX, alias: ['oldText'] }),
      new_text: S({ required: true, max: TEXT_MAX, alias: ['newText'] }),
      path: S({ max: PATH_MAX }),
    },
  },
  {
    name: 'insert_text', domain: 'fs', readOnly: false, mutates: true,
    descKey: 'agent.tInsert',
    args: {
      text: S({ required: true, max: TEXT_MAX }),
      path: S({ max: PATH_MAX }),
    },
  },
  {
    name: 'create_file', domain: 'fs', readOnly: false, mutates: true,
    descKey: 'agent.tCreateFile',
    args: {
      path: S({ required: true, max: PATH_MAX }),
      content: S({ required: true, max: CONTENT_MAX }),
    },
  },
  /* ---- 计划类动作（阶段二）：只改任务状态，不碰文件 ---- */
  {
    name: 'set_plan', domain: 'task', readOnly: true, mutates: false,
    descKey: 'agent.tSetPlan',
    args: {
      goal: S({ required: true, max: 600 }),
      steps: { type: 'json', required: true, max: 24 },
    },
  },
  {
    name: 'update_plan', domain: 'task', readOnly: true, mutates: false,
    descKey: 'agent.tUpdatePlan',
    args: {
      step: N({ required: true, min: 1, max: 200 }),
      status: { type: 'enum', required: true, enum: ['doing', 'done', 'blocked', 'skipped'] },
      note: S({ max: 400 }),
    },
  },
];

const DEFS = new Map(TOOL_DEFS.map(d => [d.name, d]));
export function toolDef(name) { return DEFS.get(String(name)) || null; }
export const MUTATING_TOOLS = new Set(TOOL_DEFS.filter(d => d.mutates).map(d => d.name));
export const TASK_TOOLS = new Set(TOOL_DEFS.filter(d => d.domain === 'task').map(d => d.name));

/* ---- 参数校验 ---- */

function typeName(t) {
  const L = getLang();
  return t === 'string' ? tr(L, 'agent.typeString') : t === 'int' ? tr(L, 'agent.typeInt')
    : t === 'bool' ? tr(L, 'agent.typeBool') : t === 'json' ? tr(L, 'agent.typeJson') : t;
}

// 别名归一：先把模型写的驼峰收到规范名下，再逐条按规格校验
function canonicalArgs(def, raw) {
  const out = {};
  const spec = def.args || {};
  for (const [k, v] of Object.entries(raw || {})) {
    const key = spec[k] ? k : Object.keys(spec).find(name => (spec[name].alias || []).includes(k));
    if (!key) continue;               // 未登记的参数直接丢弃：不是错误，不值得为它烧一轮
    // 同一参数写了两种拼法（path 与 Path 之类）时以规范名先出现的那个为准
    if (out[key] === undefined) out[key] = v;
  }
  return out;
}

/**
 * 校验一次工具调用。@returns {{ok:true, args:object}|{ok:false, code:string, error:string}}
 * code 是给台账/审计用的稳定标识，error 是回给模型的话。
 */
export function validateCall(name, raw) {
  const L = getLang();
  const def = DEFS.get(String(name));
  if (!def) return { ok: false, code: 'unknown_tool', error: tr(L, 'agent.errUnknownTool', { name: String(name) }) };
  if (raw !== null && raw !== undefined && typeof raw !== 'object') {
    return { ok: false, code: 'bad_args', error: tr(L, 'agent.errArgsNotObject') };
  }
  const args = canonicalArgs(def, raw);
  for (const [key, spec] of Object.entries(def.args || {})) {
    const v = args[key];
    if (v === undefined || v === null || v === '') {
      if (spec.required) return { ok: false, code: 'missing_arg', error: tr(L, 'agent.errMissingArg', { name: key }) };
      delete args[key];
      continue;
    }
    if (spec.type === 'string') {
      if (typeof v !== 'string') return { ok: false, code: 'bad_type', error: tr(L, 'agent.errArgType', { name: key, type: typeName('string') }) };
      if (spec.max && v.length > spec.max) return { ok: false, code: 'arg_too_long', error: tr(L, 'agent.errArgTooLong', { name: key, n: spec.max }) };
    } else if (spec.type === 'int') {
      const n = typeof v === 'string' && v.trim() ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) return { ok: false, code: 'bad_type', error: tr(L, 'agent.errArgType', { name: key, type: typeName('int') }) };
      const i = Math.round(n);
      if (spec.min != null && i < spec.min) return { ok: false, code: 'arg_out_of_range', error: tr(L, 'agent.errArgRange', { name: key, min: spec.min, max: spec.max == null ? '∞' : spec.max }) };
      if (spec.max != null && i > spec.max) return { ok: false, code: 'arg_out_of_range', error: tr(L, 'agent.errArgRange', { name: key, min: spec.min == null ? '-∞' : spec.min, max: spec.max }) };
      args[key] = i;
    } else if (spec.type === 'bool') {
      if (typeof v === 'string') {
        if (v === 'true' || v === 'false') args[key] = v === 'true';
        else return { ok: false, code: 'bad_type', error: tr(L, 'agent.errArgType', { name: key, type: typeName('bool') }) };
      } else if (typeof v !== 'boolean') {
        return { ok: false, code: 'bad_type', error: tr(L, 'agent.errArgType', { name: key, type: typeName('bool') }) };
      }
    } else if (spec.type === 'enum') {
      if (!(spec.enum || []).includes(v)) return { ok: false, code: 'bad_enum', error: tr(L, 'agent.errArgEnum', { name: key, values: (spec.enum || []).join(' / ') }) };
    } else if (spec.type === 'json') {
      if (!Array.isArray(v)) return { ok: false, code: 'bad_type', error: tr(L, 'agent.errArgType', { name: key, type: typeName('json') }) };
      if (spec.max && v.length > spec.max) return { ok: false, code: 'arg_out_of_range', error: tr(L, 'agent.errPlanTooLong', { n: spec.max }) };
    }
  }
  return { ok: true, args };
}

/* ---- 失败降级建议 ----
 * 错误码 → 下一步该怎么做。框架在失败回执后追加一行，等于把「重试 → 备选工具 →
 * 简化参数 → 换做法」写进代码而不是指望 prompt 里那句"请先读取再修改"被模型记住。
 */
const ADVICE = {
  old_not_found: 'agent.degOldNotFound',
  old_ambiguous: 'agent.degOldAmbiguous',
  not_open: 'agent.degNotOpen',
  bad_regex: 'agent.degBadRegex',
  regex_unsafe: 'agent.degBadRegex',
  hidden_path: 'agent.degHiddenPath',
  file_not_found: 'agent.degFileNotFound',
  too_large: 'agent.degTooLarge',
  file_exists: 'agent.degFileExists',
  no_editor: 'agent.degNoEditor',
  missing_arg: 'agent.degResendCall',
  bad_type: 'agent.degResendCall',
  arg_too_long: 'agent.degShorten',
  bad_args: 'agent.degResendCall',
};
export function adviceFor(code) {
  const key = ADVICE[code];
  return key ? tr(getLang(), key) : '';
}

/* ---- 调用台账（缓存 / 去重 / 重复失败熔断） ---- */

/** 参数规范化成 key 的一部分：键序不影响（模型两次输出同序概率不高） */
function stableArgs(a) {
  const out = {};
  for (const k of Object.keys(a || {}).sort()) out[k] = a[k];
  return JSON.stringify(out);
}

/**
 * 内容签名：长度 + 首尾各 64 字 + 全篇定步长抽样。整篇哈希在 200KB 文档上要逐字符
 * 走一遍，抽样把成本压到几百次迭代；只看抽样会漏掉「只改末尾」的情况（抽样步长
 * 落在末尾字符之后），所以首尾两段必须单独哈希。
 */
export function contentSig(text) {
  const s = String(text == null ? '' : text);
  const WIN = 64;
  const h = (str) => {
    let x = 2166136261;
    for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); }
    return (x >>> 0).toString(36);
  };
  if (s.length <= WIN * 2) return s.length + ':' + h(s);
  const step = Math.max(1, Math.floor(s.length / 256));
  let sampled = '';
  for (let i = 0; i < s.length; i += step) sampled += s[i];
  return s.length + ':' + h(s.slice(0, WIN)) + ':' + h(sampled) + ':' + h(s.slice(-WIN));
}

/**
 * 一轮 agent 内的调用台账。
 * - 只读工具：执行后比对内容签名，与本轮更早那次相同 → 回执换成「与第 N 步相同」的
 *   一行说明，正文不再重复进上下文。这里刻意不做「命中缓存就不执行」：文件内容会被
 *   用户手改或被别的工具改，跳过执行省的是几毫秒本地读，代价是可能把旧内容当成新的
 *   回给模型，方向不对。
 * - 所有工具：同一 (工具, 参数) 失败满 3 次 → 框架拒绝再执行（模型在跟自己绕圈）。
 * @returns {{keyOf, shouldBlock, observe, stats}}
 */
export function makeCallLedger() {
  const seenOk = new Map();     // key -> { step, sig }
  const failCount = new Map();  // key -> n
  let n = 0;
  const keyOf = (name, args) => name + ' ' + stableArgs(args);
  return {
    keyOf,
    /** 执行前判定：这条是否已被拦下（重复失败） */
    shouldBlock(name, args) {
      const k = keyOf(name, args);
      return (failCount.get(k) || 0) >= 3;
    },
    /** 执行后登记；只读工具带 sig 时返回可替换的短回执 */
    observe(name, args, res) {
      n++;
      const k = keyOf(name, args);
      if (!res || !res.ok) {
        failCount.set(k, (failCount.get(k) || 0) + 1);
        return null;
      }
      const def = DEFS.get(name);
      if (!def || !def.readOnly || !res.sig) return null;
      const prev = seenOk.get(k);
      seenOk.set(k, { step: n, sig: res.sig });
      if (prev && prev.sig === res.sig) return { dupOf: prev.step, key: k };
      return null;
    },
    stats() {
      let blocked = 0;
      for (const v of failCount.values()) if (v >= 3) blocked++;
      return { calls: n, repeats: seenOk.size, failKeys: blocked };
    },
  };
}

/* ---- 模型侧工具清单（由定义生成） ---- */

function argSignature(def) {
  const keys = Object.keys(def.args || {});
  if (!keys.length) return '';
  // 顺序按定义里声明的顺序（必填在前更自然，由定义本身保证）
  return ' {' + keys.map(k => {
    const spec = def.args[k];
    const opt = spec.type === 'bool' || !spec.required;
    return k + (opt ? '?' : '');
  }).join(', ') + '}';
}

/** 只列本轮真的可用的工具：任务类动作要开着计划才告诉模型，否则等于白送一轮幻觉 */
export function toolsSchema(opts = {}) {
  const L = getLang();
  const withTask = opts.withTaskTools === true;
  return TOOL_DEFS
    .filter(d => withTask || d.domain === 'fs')
    .map(d => '- ' + d.name + argSignature(d) + '：' + tr(L, d.descKey))
    .join('\n');
}

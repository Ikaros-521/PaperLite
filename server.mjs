/* PaperLite 伴随服务器：
 *   1) 静态托管 dist/（构建产物）
 *   2) /api/health    —— 检测本机可用 TeX 引擎（pdflatex / latex / xelatex / lualatex）
 *   3) /api/compile   —— 调用本机 TeX 引擎编译，返回 PDF(base64) + 日志 + 错误行
 *   4) /v1/*          —— OpenAI 兼容 Mock（离线体验 AI 修复/对话；接入真实渠道后无需它）
 *
 * 用法：npm run build && node server.mjs [端口]  →  http://localhost:端口
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] || 8788);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.json': 'application/json'
};

// ---------------- 引擎检测 ----------------
const ENGINE_CMDS = { pdflatex: 'pdflatex', latex: 'latex', xelatex: 'xelatex', lualatex: 'lualatex' };
// 结果缓存 30s：where/which 是子进程调用，/api/health 与每次 /api/compile 各探测
// 5 个引擎，频繁编译时白白拖慢响应；装新发行版后最多半分钟生效
let enginesCache = null, enginesAt = 0;
function which(cmd) {
  try { execSync(`${process.platform === 'win32' ? 'where' : 'which'} ${cmd}`, { stdio: 'ignore' }); return true; }
  catch (e) { return false; }
}
function availableEngines() {
  const now = Date.now();
  if (enginesCache && now - enginesAt < 30000) return enginesCache;
  const out = {};
  for (const [name, cmd] of Object.entries(ENGINE_CMDS)) out[name] = which(cmd);
  out['dvipdfmx'] = which('dvipdfmx'); // latex(DVI) 转 PDF
  enginesCache = out; enginesAt = now;
  return out;
}

// ---------------- 编译 ----------------
function runCmd(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, shell: process.platform === 'win32' });
    let out = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, timeoutMs || 90000);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('error', e => { clearTimeout(t); resolve({ code: -1, out: String(e) }); });
    p.on('close', code => { clearTimeout(t); resolve({ code, out }); });
  });
}

function parseLog(log) {
  const errors = [];
  const lines = log.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const em = lines[i].match(/^!\s*(.*)/);
    if (em) {
      let line = null;
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const lm = lines[j].match(/^l\.(\d+)/);
        if (lm) { line = +lm[1] - 1; break; }
      }
      errors.push({ line, msg: em[1].trim() });
    }
  }
  return errors.slice(0, 30);
}

async function compile(body) {
  const { engine, source } = body;
  // 必须查 own property：ENGINE_CMDS[engine] 对 'constructor'/'__proto__'/'toString'
  // 都能从原型链上取到真值，等于绕过白名单（后面 spawn 收到一个 Function，
  // 报出来的内部错误文本还会原样回显给页面）
  const cmd = Object.hasOwn(ENGINE_CMDS, engine) ? ENGINE_CMDS[engine] : null;
  if (!cmd) return { ok: false, error: '未知引擎：' + String(engine).slice(0, 40) };
  const avail = availableEngines();
  if (!Object.hasOwn(avail, engine) || !avail[engine]) return { ok: false, error: `本机未安装 ${engine}（请安装 MiKTeX 或 TeX Live 并加入 PATH）` };

  const dir = path.join(os.tmpdir(), 'paperlite-' + crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, 'main.tex'), String(source || ''), 'utf8');
    const args = ['-interaction=nonstopmode', '-halt-on-error', 'main.tex'];
    // 跑两遍以解析目录/交叉引用
    let r1 = await runCmd(cmd, args, dir);
    if (r1.code === 0) r1 = await runCmd(cmd, args, dir);
    let log = '';
    try { log = fs.readFileSync(path.join(dir, 'main.log'), 'utf8'); } catch (e) { log = r1.out; }

    if (engine === 'latex') {
      if (r1.code !== 0) return { ok: false, log, errors: parseLog(log) };
      if (!avail.dvipdfmx) return { ok: false, log, errors: parseLog(log), error: '已生成 DVI，但未找到 dvipdfmx，无法转 PDF' };
      const r2 = await runCmd('dvipdfmx', ['main.dvi'], dir);
      if (r2.code !== 0) return { ok: false, log: log + '\n' + r2.out, errors: parseLog(log) };
    } else if (r1.code !== 0) {
      return { ok: false, log, errors: parseLog(log) };
    }

    const pdfPath = path.join(dir, 'main.pdf');
    if (!fs.existsSync(pdfPath)) return { ok: false, log, errors: parseLog(log), error: '未生成 PDF（查看日志）' };
    const pdf = fs.readFileSync(pdfPath).toString('base64');
    return { ok: true, pdf, log, errors: [], engine };
  } finally {
    // Windows 上 TeX 与杀软常常还攥着 main.log，空回调等于把错误咽掉、目录就地僵尸。
    // 给重试并把失败说出来，配合启动时的清扫，%TEMP% 才不会只增不减
    fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }, (err) => {
      if (err) console.warn('[paperlite] 临时目录没清掉：', path.basename(dir), err.code || err.message);
    });
  }
}

/** 崩溃或 Ctrl+C 时 finally 跑不到，%TEMP% 里会攒下 paperlite-* 目录（TeX 中间产物）。
 *  启动时扫一遍，只动一小时前的——更早的不可能是另一个实例正在用的。 */
function sweepStaleTempDirs() {
  const base = os.tmpdir(), cutoff = Date.now() - 3600e3;
  let names;
  try { names = fs.readdirSync(base); } catch (e) { return; }
  let swept = 0;
  for (const n of names) {
    if (!n.startsWith('paperlite-')) continue;
    const p = path.join(base, n);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); swept++; }
    } catch (e) { /* 没权限或正好被占用，下一轮再说 */ }
  }
  if (swept) console.log(`已回收 ${swept} 个残留的临时编译目录`);
}

// ---------------- HTTP ----------------

// 本机开发源：vite dev（任意端口）与自身（127.0.0.1:PORT）。
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

// CORS：仅放行本机开发源（vite dev server 等任意端口的 localhost/127.0.0.1）。
// 不再回 *：任意网页都能跨源 POST /api/compile 驱动本机 TeX，等于把本机算力与
// 文件系统暴露给访问的每个站点；同源页面（localhost:8788 自己）无 Origin 头，不受影响。
function corsHeaders(req) {
  const o = String(req.headers.origin || '');
  if (!o) return {};
  return LOCAL_ORIGIN.test(o)
    ? { 'Access-Control-Allow-Origin': o, Vary: 'Origin' }
    : {};
}

// CORS 头只决定「响应能不能被读走」，请求照发不误；而且 GET/无预检的 text/plain POST
// 根本不看 CORS。本机服务没有网页访客：浏览器发起的跨站请求一定带 Origin，
// 非浏览器（curl / 本机脚本）不带，所以直接按 Origin 拒，外部站点就驱动不了本机 TeX。
function forbiddenOrigin(req) {
  const o = String(req.headers.origin || '');
  return !!o && !LOCAL_ORIGIN.test(o);
}

function json(res, code, obj, extra) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...(extra || {}) });
  res.end(JSON.stringify(obj));
}
// 统一成 { ok, value } / { ok:false, code, error }：解析失败与超限要分开回 400 / 413，
// 把坏 JSON 当空对象交给 compile 只会得到一句莫名其妙的编译错误
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    // 超限时 destroy 后不会再有 'end' 事件：立即 resolve
    req.on('data', c => {
      bytes += c.length;   // 按字节限：UTF-8 一个汉字三字节，按字符数限等于把预算放大三倍
      if (bytes > 20e6) { try { req.destroy(); } catch (e) {} finish({ ok: false, code: 413, error: 'payload too large' }); return; }
      // 必须攒够 Buffer 再整体解码：`data += chunk` 会让每个分块单独 toString，
      // 跨 TCP 包的 UTF-8 序列断成 U+FFFD —— 中文文稿带着坏字符交给 TeX，
      // 用户只会看到一句莫名其妙的编译错误
      chunks.push(c);
    });
    req.on('error', () => finish({ ok: false, code: 400, error: 'request stream error' }));
    req.on('end', () => {
      try { finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
      catch (e) { finish({ ok: false, code: 400, error: 'invalid JSON body' }); }
    });
  });
}

// 一次 TeX 编译能吃掉几十秒 CPU：并发上限挡住「同一页面连点编译」把本机打成排队机房
const MAX_COMPILE = 2;
let compiling = 0;

/** SSE 的推送跑在 timer 回调里：那里抛出的错误 route().catch 看不见，客户端断开后
 *  继续 res.write 就是 ERR_STREAM_WRITE_AFTER_END，而本进程没有异常兜底 —— 一个请求
 *  就能把伴随服务打死。这个壳把「断开」变成停表 + 静默写，并给个错误出口。 */
function sseGuard(res) {
  const timers = new Set();
  let alive = true;
  const stop = () => { alive = false; for (const t of timers) clearInterval(t); timers.clear(); };
  res.on('close', stop);
  res.on('error', stop);
  return {
    get alive() { return alive; },
    write(s) { if (!alive) return; try { res.write(s); } catch (e) { stop(); } },
    end() { if (!alive) return; alive = false; try { res.end(); } catch (e) { /* 已断开 */ } },
    every(fn, ms) {
      const t = setInterval(() => { if (!alive) { clearInterval(t); timers.delete(t); return; } fn(t); }, ms);
      timers.add(t);
      return t;
    },
    clear(t) { clearInterval(t); timers.delete(t); },
  };
}

// 包一层：处理器里任何抛出（含 decodeURIComponent 的 URIError）都必须回响应，
// 否则 async 回调的 rejection 会变成 unhandledRejection，Node 15+ 默认直接结束进程
const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (!res.headersSent) json(res, 500, { ok: false, error: String((e && e.message) || e) });
    else { try { res.end(); } catch (e2) { /* 已经断开就别再折腾 */ } }
  });
});

async function route(req, res) {
  const url = (req.url || '/').split('?')[0];
  const cors = corsHeaders(req);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...cors,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access'
    });
    return res.end();
  }

  if (forbiddenOrigin(req)) return json(res, 403, { ok: false, error: 'forbidden origin' }, cors);

  // ---- API ----
  if (url === '/api/health' && req.method === 'GET') {
    const engines = availableEngines();
    const list = Object.keys(ENGINE_CMDS).filter(k => engines[k]);
    return json(res, 200, { ok: true, engines: list, dvi2pdf: !!engines.dvipdfmx }, cors);
  }
  if (url === '/api/compile' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.ok) return json(res, b.code, { ok: false, error: b.error }, cors);
    if (compiling >= MAX_COMPILE) {
      res.writeHead(429, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '2' });
      return res.end(JSON.stringify({ ok: false, error: '本机编译队列已满，请稍候再试' }));
    }
    compiling++;
    try { return json(res, 200, await compile(b.value), cors); }
    catch (e) { return json(res, 200, { ok: false, error: String(e && e.message || e) }, cors); }
    finally { compiling--; }
  }

  // ---- LLM Mock（仅离线演示用，含 OpenAI 兼容与 Anthropic 协议）----
  if (url === '/v1/models' && req.method === 'GET') {
    return json(res, 200, {
      object: 'list',
      data: [
        { id: 'paperlite-mock' },
        { id: 'paperlite-mock-pro' },
        { id: 'paperlite-mock-embed' }
      ]
    }, cors);
  }
  if (url === '/v1/chat/completions' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.ok) return json(res, b.code, { ok: false, error: b.error }, cors);
    const body = b.value;
    const last = (body.messages || []).filter(m => m.role === 'user').pop();
    const q = String(last && last.content || '');
    const reply = mockReply(q);
    const pt = reqTokens(body), ct = estTok(reply);
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...cors });
      const g = sseGuard(res);
      const deltas = reply.match(/[\s\S]{1,12}/g) || [];
      let i = 0;
      g.every((t) => {
        if (i >= deltas.length) {
          // OpenAI 约定：开启 include_usage 后，末尾以空 choices 的块回传计量
          g.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct } }) + '\n\n');
          g.write('data: [DONE]\n\n'); g.end(); g.clear(t); return;
        }
        g.write('data: ' + JSON.stringify({ choices: [{ delta: { content: deltas[i++] } }] }) + '\n\n');
      }, 30);
      return;
    }
    return json(res, 200, {
      choices: [{ message: { content: reply } }],
      usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct }
    }, cors);
  }

  // ---- Anthropic 协议 Mock（/v1/messages，供「Anthropic (Claude)」协议离线体验）----
  if (url === '/v1/messages' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.ok) return json(res, b.code, { ok: false, error: b.error }, cors);
    const body = b.value;
    const last = [...(body.messages || [])].reverse().find(m => m.role === 'user');
    const q = typeof (last && last.content) === 'string'
      ? last.content
      : Array.isArray(last && last.content) ? last.content.map(b => (b && b.text) || '').join('') : '';
    const thinking = body.thinking && body.thinking.type === 'enabled'
      ? '（Mock 思维链演示）收到问题，无需复杂推理，直接给出演示回复。'
      : '';
    const reply = mockReply(q);
    const pt = reqTokens(body) + estTok(thinking), ct = estTok(reply);
    const blocks = [];
    if (thinking) blocks.push({ type: 'thinking', text: thinking });
    blocks.push({ type: 'text', text: reply });

    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...cors });
      const g = sseGuard(res);
      g.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model || 'claude-mock', content: [], usage: { input_tokens: pt, output_tokens: 1 } } })}\n\n`);
      let bi = 0;
      const nextBlock = () => {
        if (!g.alive) return;
        if (bi >= blocks.length) {
          g.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: ct } })}\n\n`);
          g.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
          g.end();
          return;
        }
        const b = blocks[bi], idx = bi;
        g.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: idx, content_block: b.type === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' } })}\n\n`);
        const pieces = (b.text || '').match(/[\s\S]{1,12}/g) || [];
        let pi = 0;
        g.every((t) => {
          if (pi >= pieces.length) {
            g.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`);
            g.clear(t); bi++; nextBlock();
            return;
          }
          const piece = pieces[pi++];
          const delta = b.type === 'thinking' ? { type: 'thinking_delta', thinking: piece } : { type: 'text_delta', text: piece };
          g.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta })}\n\n`);
        }, 20);
      };
      nextBlock();
      return;
    }
    return json(res, 200, {
      id: 'msg_mock', type: 'message', role: 'assistant', model: body.model || 'claude-mock',
      content: blocks.map(b => b.type === 'thinking' ? { type: 'thinking', thinking: b.text } : { type: 'text', text: b.text }),
      stop_reason: 'end_turn', usage: { input_tokens: pt, output_tokens: ct }
    }, cors);
  }

  if (url === '/v1/embeddings' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.ok) return json(res, b.code, { ok: false, error: b.error }, cors);
    const body = b.value;
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const data = inputs.map((t, i) => ({
      index: i,
      embedding: simpleVec(String(t))
    }));
    return json(res, 200, { object: 'list', data }, cors);
  }

  // ---- 静态文件 ----
  // 非法 % 序列（GET /%）会抛 URIError：在 async 处理器里就是 unhandledRejection，
  // Node 15+ 默认直接结束进程 —— 一个 <img src="http://127.0.0.1:8788/%"> 就能打死本机服务
  let decoded;
  try { decoded = decodeURIComponent(url); } catch (e) { res.writeHead(400); return res.end('Bad request'); }
  if (decoded.includes('\0')) { res.writeHead(400); return res.end('Bad request'); }
  let file = decoded === '/' ? '/index.html' : decoded;
  file = path.normalize(path.join(ROOT, file));
  // 前缀必须对齐目录边界：startsWith(ROOT) 会让 normalize 出的 /dist-x 同级目录钻空子
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA 兜底
      fs.readFile(path.join(ROOT, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); return res.end('Not Found（请先 npm run build）'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
        res.end(d2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
}

// 确定性伪向量（供 Mock 检索）
function simpleVec(text) {
  const dim = 64, v = new Array(dim).fill(0);
  for (let i = 0; i < text.length; i++) v[text.charCodeAt(i) % dim] += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / norm);
}

// Mock 回复生成（OpenAI 兼容与 Anthropic 协议共用）
// Mock 的 token 计数：与前端 context.js 同口径的粗略估算，让用量条能演示「实测」
function estTok(s) {
  const str = String(s || '');
  const cjk = (str.match(/[぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/g) || []).length;
  return Math.max(1, Math.round(cjk * 1.1 + (str.length - cjk) / 4));
}
function reqTokens(body) {
  return estTok(JSON.stringify(body.messages || '')) + estTok(body.system || '') + estTok(body.model || '');
}

function mockReply(q) {
  if (/压缩成要点摘要|Compact the following conversation/i.test(q)) {
    return '- 目标：润色引言与相关工作，统一术语 BiLSTM-Att。\n' +
      '- 已确认：保留三线表与流程图，长公式改用 align 环境。\n' +
      '- 待办：补充第 2 章相关工作引用、实验小节的数据集说明。\n' +
      '- 约束：中文输出，不改动作者与日期字段。\n' +
      '（Mock 摘要：接入真实渠道后为模型生成内容）';
  }
  if (/修复|fix|语法|错误/i.test(q)) {
    return '已分析并修复语法问题：补全未闭合的环境/花括号。\n\n```latex\n\\section{引言}\n这是修复后的段落，公式 $E=mc^2$ 正常。\n\\end{document}\n```\n\n说明：以上代码块可直接「替换全文」。';
  }
  if (q.length > 400) {
    return '以下是改写后的版本：\n\n```latex\n' + q.slice(0, 200).replace(/^[#>\s]*/, '') + '\n```\n\n（Mock 渠道返回的演示改写，接入真实 LLM 渠道后为模型生成内容。）';
  }
  return '收到：' + q.slice(0, 80) + '\n\n我是 **Mock 渠道**（离线演示）。请在「AI 设置」中添加真实渠道（Base URL + Key + 模型）。回复中如包含代码块，可直接应用：\n\n```latex\n% 演示代码块\n\\textbf{应用我试试}\n```';
}

// timer 回调与 fs 异步回调里的抛出，route().catch 是看不到的；没有这层兜底时
// 一次写坏流就足以把整个伴随服务带走（编译与 AI 全断），所以记录后继续活着
process.on('uncaughtException', (e) => console.error('[paperlite] 未捕获异常，服务继续运行：', (e && e.stack) || e));
process.on('unhandledRejection', (e) => console.error('[paperlite] 未处理的 rejection：', (e && e.stack) || e));

sweepStaleTempDirs();

// 端口被占时默认抛一整段栈然后退出；给一句能照着做的提示
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') console.error(`端口 ${PORT} 已被占用（可能已有一个 server.mjs 在跑）。换个端口：node server.mjs 8790`);
  else console.error('[paperlite] 服务启动失败：', (e && e.message) || e);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const eng = availableEngines();
  const list = Object.keys(ENGINE_CMDS).filter(k => eng[k]);
  console.log(`PaperLite → http://127.0.0.1:${PORT}/`);
  console.log(`TeX 引擎：${list.length ? list.join(', ') : '未检测到（编译功能需安装 MiKTeX / TeX Live）'}`);
  console.log('LLM Mock：/v1/chat/completions（离线演示渠道）');
});

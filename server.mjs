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
  if (!ENGINE_CMDS[engine]) return { ok: false, error: '未知引擎：' + engine };
  const avail = availableEngines();
  if (!avail[engine]) return { ok: false, error: `本机未安装 ${engine}（请安装 MiKTeX 或 TeX Live 并加入 PATH）` };

  const dir = path.join(os.tmpdir(), 'paperlite-' + crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, 'main.tex'), String(source || ''), 'utf8');
    const args = ['-interaction=nonstopmode', '-halt-on-error', 'main.tex'];
    // 跑两遍以解析目录/交叉引用
    let r1 = await runCmd(ENGINE_CMDS[engine], args, dir);
    if (r1.code === 0) r1 = await runCmd(ENGINE_CMDS[engine], args, dir);
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
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
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
    let data = '';
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    // 超限时 destroy 后不会再有 'end' 事件：立即 resolve
    req.on('data', c => {
      data += c;
      if (data.length > 20e6) { try { req.destroy(); } catch (e) {} finish({ ok: false, code: 413, error: 'payload too large' }); }
    });
    req.on('error', () => finish({ ok: false, code: 400, error: 'request stream error' }));
    req.on('end', () => {
      try { finish({ ok: true, value: JSON.parse(data) }); }
      catch (e) { finish({ ok: false, code: 400, error: 'invalid JSON body' }); }
    });
  });
}

// 一次 TeX 编译能吃掉几十秒 CPU：并发上限挡住「同一页面连点编译」把本机打成排队机房
const MAX_COMPILE = 2;
let compiling = 0;

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
      const deltas = reply.match(/[\s\S]{1,12}/g) || [];
      let i = 0;
      const t = setInterval(() => {
        if (i >= deltas.length) {
          // OpenAI 约定：开启 include_usage 后，末尾以空 choices 的块回传计量
          res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct } }) + '\n\n');
          res.write('data: [DONE]\n\n'); res.end(); clearInterval(t); return;
        }
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: deltas[i++] } }] }) + '\n\n');
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
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model || 'claude-mock', content: [], usage: { input_tokens: pt, output_tokens: 1 } } })}\n\n`);
      let bi = 0;
      const nextBlock = () => {
        if (bi >= blocks.length) {
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: ct } })}\n\n`);
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
          res.end();
          return;
        }
        const b = blocks[bi], idx = bi;
        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: idx, content_block: b.type === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' } })}\n\n`);
        const pieces = (b.text || '').match(/[\s\S]{1,12}/g) || [];
        let pi = 0;
        const t = setInterval(() => {
          if (pi >= pieces.length) {
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`);
            clearInterval(t); bi++; nextBlock();
            return;
          }
          const piece = pieces[pi++];
          const delta = b.type === 'thinking' ? { type: 'thinking_delta', thinking: piece } : { type: 'text_delta', text: piece };
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta })}\n\n`);
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

server.listen(PORT, '127.0.0.1', () => {
  const eng = availableEngines();
  const list = Object.keys(ENGINE_CMDS).filter(k => eng[k]);
  console.log(`PaperLite → http://127.0.0.1:${PORT}/`);
  console.log(`TeX 引擎：${list.length ? list.join(', ') : '未检测到（编译功能需安装 MiKTeX / TeX Live）'}`);
  console.log('LLM Mock：/v1/chat/completions（离线演示渠道）');
});

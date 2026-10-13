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
function which(cmd) {
  try { execSync(`${process.platform === 'win32' ? 'where' : 'which'} ${cmd}`, { stdio: 'ignore' }); return true; }
  catch (e) { return false; }
}
function availableEngines() {
  const out = {};
  for (const [name, cmd] of Object.entries(ENGINE_CMDS)) out[name] = which(cmd);
  out['dvipdfmx'] = which('dvipdfmx'); // latex(DVI) 转 PDF
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
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 20e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access'
    });
    return res.end();
  }

  // ---- API ----
  if (url === '/api/health' && req.method === 'GET') {
    const engines = availableEngines();
    const list = Object.keys(ENGINE_CMDS).filter(k => engines[k]);
    return json(res, 200, { ok: true, engines: list, dvi2pdf: !!engines.dvipdfmx });
  }
  if (url === '/api/compile' && req.method === 'POST') {
    const body = await readBody(req);
    try { return json(res, 200, await compile(body)); }
    catch (e) { return json(res, 200, { ok: false, error: String(e && e.message || e) }); }
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
    });
  }
  if (url === '/v1/chat/completions' && req.method === 'POST') {
    const body = await readBody(req);
    const last = (body.messages || []).filter(m => m.role === 'user').pop();
    const q = String(last && last.content || '');
    const reply = mockReply(q);
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      const deltas = reply.match(/[\s\S]{1,12}/g) || [];
      let i = 0;
      const t = setInterval(() => {
        if (i >= deltas.length) {
          res.write('data: [DONE]\n\n'); res.end(); clearInterval(t); return;
        }
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: deltas[i++] } }] }) + '\n\n');
      }, 30);
      return;
    }
    return json(res, 200, { choices: [{ message: { content: reply } }], usage: {} });
  }

  // ---- Anthropic 协议 Mock（/v1/messages，供「Anthropic (Claude)」协议离线体验）----
  if (url === '/v1/messages' && req.method === 'POST') {
    const body = await readBody(req);
    const last = [...(body.messages || [])].reverse().find(m => m.role === 'user');
    const q = typeof (last && last.content) === 'string'
      ? last.content
      : Array.isArray(last && last.content) ? last.content.map(b => (b && b.text) || '').join('') : '';
    const thinking = body.thinking && body.thinking.type === 'enabled'
      ? '（Mock 思维链演示）收到问题，无需复杂推理，直接给出演示回复。'
      : '';
    const reply = mockReply(q);
    const blocks = [];
    if (thinking) blocks.push({ type: 'thinking', text: thinking });
    blocks.push({ type: 'text', text: reply });

    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model || 'claude-mock', content: [], usage: {} } })}\n\n`);
      let bi = 0;
      const nextBlock = () => {
        if (bi >= blocks.length) {
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } })}\n\n`);
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
      stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 10 }
    });
  }

  if (url === '/v1/embeddings' && req.method === 'POST') {
    const body = await readBody(req);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const data = inputs.map((t, i) => ({
      index: i,
      embedding: simpleVec(String(t))
    }));
    return json(res, 200, { object: 'list', data });
  }

  // ---- 静态文件 ----
  let file = url === '/' ? '/index.html' : decodeURIComponent(url);
  file = path.normalize(path.join(ROOT, file));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA 兜底
      fs.readFile(path.join(ROOT, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); return res.end('Not Found（请先 npm run build）'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

// 确定性伪向量（供 Mock 检索）
function simpleVec(text) {
  const dim = 64, v = new Array(dim).fill(0);
  for (let i = 0; i < text.length; i++) v[text.charCodeAt(i) % dim] += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / norm);
}

// Mock 回复生成（OpenAI 兼容与 Anthropic 协议共用）
function mockReply(q) {
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

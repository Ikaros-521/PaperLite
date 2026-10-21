/* PaperLite 极简静态服务器（可选）：node server.js [端口] 后访问 http://127.0.0.1:端口 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] || 8765;
const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.tex': 'text/plain; charset=utf-8'
};

http.createServer(function (req, res) {
  // decodeURIComponent 对坏百分号编码（GET /%）抛 URIError：这个进程没有
  // uncaughtException 兜底，一个坏请求就能把它带走
  var url;
  try { url = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch (e) { res.writeHead(400); return res.end('Bad request'); }
  if (url === '/') url = '/index.html';
  var file = path.normalize(path.join(ROOT, url));
  // 前缀要对齐到目录边界：只 startsWith(ROOT) 时，同级的 legacy_backup 也能钻进来
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', function () {
  console.log('PaperLite → http://127.0.0.1:' + PORT + '/index.html');
});

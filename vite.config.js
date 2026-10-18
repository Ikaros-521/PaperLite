import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pdfRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
// cm5-vim 的 UMD 头按「codemirror 包内相对路径」require（../lib/codemirror 等），
// 作为独立包安装后无法解析（esbuild 也不接受相对路径别名）。加载时把 UMD 头剥成
// ESM import：直接喂给它本项目正在用的同一个 CodeMirror 实例。
const cmVimBridge = () => ({
  name: 'cm5-vim-bridge',
  enforce: 'pre',
  load(id) {
    // dev 下 id 可能带 ?v= 依赖版本查询串，先剥掉再匹配/读盘
    const norm = String(id).split('?')[0].replace(/\\/g, '/');
    if (!/\/node_modules\/cm5-vim\/vim\.js$/.test(norm)) return null;
    let src;
    try { src = readFileSync(norm, 'utf8'); } catch (e) { return null; }
    const marker = '})(function(CodeMirror) {';
    const at = src.indexOf(marker);
    if (at < 0) return null; // 头部结构变了就退回原样（会构建报错，不会被静默吞掉）
    const body = src.slice(at + marker.length).replace(/\}\);\s*$/, '');
    return [
      "import CodeMirror from 'codemirror';",
      "import 'codemirror/addon/search/searchcursor';",
      "import 'codemirror/addon/dialog/dialog';",
      "import 'codemirror/addon/edit/matchbrackets';",
      '(function(CodeMirror) {',
      body,
      '})(CodeMirror);',
      'export default CodeMirror;',
      '',
    ].join('\n');
  },
});
// Keep optional PDF font resources local, in development and subpath deployments.
const pdfResources = () => ({
  name: 'pdf-resources',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const match = req.url?.split('?')[0].match(/^\/pdfjs\/(cmaps|standard_fonts)\/([\w.-]+)$/);
      if (!match) return next();
      try { res.end(readFileSync(join(pdfRoot, match[1], match[2]))); }
      catch { res.statusCode = 404; res.end(); }
    });
  },
  generateBundle() {
    for (const dir of ['cmaps', 'standard_fonts']) {
      for (const file of readdirSync(join(pdfRoot, dir))) {
        this.emitFile({ type: 'asset', fileName: `pdfjs/${dir}/${file}`, source: readFileSync(join(pdfRoot, dir, file)) });
      }
    }
  }
});

// base: './' 使构建产物为相对路径 —— 既可 dist/index.html 双击打开，也为 Electron(file://) 打包预留
export default defineConfig({
  base: './',
  plugins: [cmVimBridge(), react(), pdfResources()],
  // dev 预打包走 esbuild、不吃上面的插件改写 —— 排除后由插件在普通管线里接管；
  // vim 依赖的两个 addon 只有转换产物引用到，扫描器看不见，须显式收录
  optimizeDeps: {
    exclude: ['cm5-vim'],
    include: ['codemirror/addon/search/searchcursor', 'codemirror/addon/dialog/dialog'],
  },
  // dev 下禁用一切 HTTP 缓存：多实例/频繁重启时避免浏览器拿旧模块（缓存腐坏排查成本高）
  server: { headers: { 'Cache-Control': 'no-store' } },
  build: {
    target: 'es2018',
    chunkSizeWarningLimit: 4000
  }
});

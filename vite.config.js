import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const pdfRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
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
  plugins: [react(), pdfResources()],
  // dev 下禁用一切 HTTP 缓存：多实例/频繁重启时避免浏览器拿旧模块（缓存腐坏排查成本高）
  server: { headers: { 'Cache-Control': 'no-store' } },
  build: {
    target: 'es2018',
    chunkSizeWarningLimit: 4000
  }
});

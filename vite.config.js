import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' 使构建产物为相对路径 —— 既可 dist/index.html 双击打开，也为 Electron(file://) 打包预留
export default defineConfig({
  base: './',
  plugins: [react()],
  // dev 下禁用一切 HTTP 缓存：多实例/频繁重启时避免浏览器拿旧模块（缓存腐坏排查成本高）
  server: { headers: { 'Cache-Control': 'no-store' } },
  build: {
    target: 'es2018',
    chunkSizeWarningLimit: 4000
  }
});

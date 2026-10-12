import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' 使构建产物为相对路径 —— 既可 dist/index.html 双击打开，也为 Electron(file://) 打包预留
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2018',
    chunkSizeWarningLimit: 4000
  }
});

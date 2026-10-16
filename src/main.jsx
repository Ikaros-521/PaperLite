import React from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import 'codemirror/lib/codemirror.css';
import './app.css';
import './themes.css';
import App from './App.jsx';
import { applyTheme, detectTheme } from './theme.js';

// 懒加载：移动端壳与 antd-mobile 必须单独成 chunk，否则桌面首屏 bundle 被拖大（实测 +147KB gzip）
const PaperLiteMobile = React.lazy(() => import('./flows/mobile/paperlite-mobile.tsx'));

// 渲染前先把上次选择的皮肤涂到 <html>，否则深色皮肤会先闪一帧默认暖白
applyTheme(detectTheme());

// 移动端壳走 hash 路由 #/m，与桌面三栏互不干扰：一套 900px 断点补丁同时服务两端是 audit-3 的根因
const mobileRoute = window.location.hash.startsWith('#/m');

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <React.Suspense fallback={null}>{mobileRoute ? <PaperLiteMobile /> : <App />}</React.Suspense>
  </React.StrictMode>
);

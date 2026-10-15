import React from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import 'codemirror/lib/codemirror.css';
import './app.css';
import './themes.css';
import App from './App.jsx';
import { applyTheme, detectTheme } from './theme.js';

// 渲染前先把上次选择的皮肤涂到 <html>，否则深色皮肤会先闪一帧默认暖白
applyTheme(detectTheme());

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

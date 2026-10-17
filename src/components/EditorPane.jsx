import { useEffect, useRef, useState } from 'react';
import { tr, getLang } from '../i18n.js';
import CodeMirror from 'codemirror';
import 'codemirror/mode/stex/stex';
import 'codemirror/mode/markdown/markdown';
import 'codemirror/mode/javascript/javascript';
import 'codemirror/mode/python/python';
import 'codemirror/mode/clike/clike';
import 'codemirror/mode/xml/xml';
import 'codemirror/mode/htmlmixed/htmlmixed';
import 'codemirror/mode/css/css';
import 'codemirror/mode/shell/shell';
import 'codemirror/mode/sql/sql';
import 'codemirror/mode/yaml/yaml';
import 'codemirror/mode/go/go';
import 'codemirror/mode/rust/rust';
import 'codemirror/mode/ruby/ruby';
import 'codemirror/mode/lua/lua';
import 'codemirror/mode/dockerfile/dockerfile';
import 'codemirror/addon/edit/closebrackets';
import 'codemirror/addon/edit/matchbrackets';
import 'codemirror/addon/selection/active-line';
import FindReplace from './FindReplace.jsx';

/* CodeMirror 5 封装：单一编辑器实例 + 每 Tab 一个 CodeMirror.Doc（swapDoc 切换，
 * 各文件独立撤销历史与光标）。mode 由 Doc 创建时指定。
 * 查找/替换用自带的 FindReplace 面板（addon 的对话框没有跳转按钮与匹配计数）。
 * 诊断：行号左侧 gutter 红橙点（点击触发 AI 修复）+ 行内波浪线（VSCode 风格）。 */
export default function EditorPane({ doc, onChange, onInit, onScrollRatio, onSave, diagnostics, onFixIssue, findReq }) {
  const hostRef = useRef(null);
  const cmRef = useRef(null);
  const marksRef = useRef([]);
  const [cmInst, setCmInst] = useState(null);
  const [findOpen, setFindOpen] = useState(false);
  const cb = useRef({});
  cb.current = { onChange, onInit, onScrollRatio, onSave, onFixIssue };

  useEffect(() => {
    const cm = CodeMirror(hostRef.current, {
      value: '',
      lineNumbers: true,
      gutters: ['CodeMirror-linenumbers', 'pl-diag-gutter'],
      lineWrapping: true,
      autoCloseBrackets: true,
      matchBrackets: true,
      styleActiveLine: true,
      extraKeys: {
        'Ctrl-S': () => { cb.current.onSave && cb.current.onSave(); return false; },
        'Cmd-S': () => { cb.current.onSave && cb.current.onSave(); return false; }
      }
    });
    cmRef.current = cm;
    setCmInst(cm);
    // 关闭隐藏 textarea 的拼写检查：Chromium 会把拼写红线“透”到可见行上，造成假报错
    const inp = cm.getInputField();
    inp.setAttribute('spellcheck', 'false');
    inp.setAttribute('autocorrect', 'off');
    inp.setAttribute('autocapitalize', 'off');
    cm.on('change', () => cb.current.onChange && cb.current.onChange(cm.getDoc(), cm.getValue()));
    cm.on('scroll', () => {
      const si = cm.getScrollInfo();
      const ratio = si.top / Math.max(1, si.height - si.clientHeight);
      cb.current.onScrollRatio && cb.current.onScrollRatio(ratio, 'edit');
    });
    cb.current.onInit && cb.current.onInit(cm);
    setTimeout(() => cm.refresh(), 50);
    return () => {
      // 先脱开共享 Doc（避免 StrictMode 双挂载时 "document is already in use"）
      try { cm.swapDoc(new CodeMirror.Doc('', 'stex')); } catch (e) { /* ignore */ }
      const el = cm.getWrapperElement();
      if (el && el.parentNode) el.parentNode.removeChild(el);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const cm = cmRef.current;
    if (cm && doc && cm.getDoc() !== doc) {
      cm.swapDoc(doc);
      cm.refresh();
      cm.focus();
    }
  }, [doc]);

  // App 的 Ctrl+F / Ctrl+Shift+F 与「编辑 → 查找替换」都通过 findReq 递增来唤起面板
  useEffect(() => { if (findReq) setFindOpen(true); }, [findReq]);

  // 诊断标记：按行分组（错误优先），gutter 圆点可点击触发 AI 修复，行内画波浪线
  useEffect(() => {
    const cm = cmRef.current;
    if (!cm) return;
    marksRef.current.forEach(m => { try { m.clear(); } catch (e) { /* ignore */ } });
    marksRef.current = [];
    cm.clearGutter && cm.clearGutter('pl-diag-gutter');

    const markedDoc = cm.getDoc();
    const issues = (diagnostics || []).filter(d => Number.isInteger(d.line) && d.line >= 0 && d.line < cm.lineCount());
    if (!issues.length) return;

    const byLine = new Map();
    for (const d of issues) {
      if (!byLine.has(d.line)) byLine.set(d.line, []);
      byLine.get(d.line).push(d);
    }

    for (const [ln, list] of byLine) {
      const isErr = list.some(d => d.severity === 'error');
      const tip = tr(getLang(), isErr ? 'ed.error' : 'ed.warning') + ': ' + list.map(d => d.msg).join('\n') + '\n' + tr(getLang(), 'ed.clickFix');

      const dot = document.createElement('div');
      dot.className = 'pl-diag-dot ' + (isErr ? 'err' : 'warn');
      dot.title = tip;
      dot.addEventListener('click', ev => {
        ev.preventDefault();
        // 同一行多个问题一并发给 AI，主问题放最前
        cb.current.onFixIssue && cb.current.onFixIssue(list[0], list);
      });

      const wrap = document.createElement('div');
      wrap.style.cssText = 'width:100%;text-align:center;';
      wrap.appendChild(dot);
      cm.setGutterMarker(ln, 'pl-diag-gutter', wrap);

      // 波浪线：行首非空白到行尾（去尾空白），hover 提示问题详情
      const text = cm.getLine(ln) || '';
      const from = (text.match(/^\s*/) || [''])[0].length;
      const to = Math.max(from + 1, text.replace(/\s+$/, '').length);
      try {
        marksRef.current.push(cm.markText(
          { line: ln, ch: from }, { line: ln, ch: to },
          { className: 'pl-diag-' + (isErr ? 'err' : 'warn') + '-text', title: tip }
        ));
      } catch (e) { /* 跨行等边界忽略 */ }
    }
    // Gutter markers belong to the Doc; clear that Doc even after swapDoc has run.
    return () => {
      marksRef.current.forEach(m => m.clear());
      marksRef.current = [];
      markedDoc.clearGutter('pl-diag-gutter');
    };
  }, [diagnostics, doc]);

  return (
    <div id="editorPane">
      <div id="editorHost" ref={hostRef} />
      {cmInst && doc && (
        <FindReplace cm={cmInst} doc={doc} open={findOpen} request={findReq}
          onClose={() => { setFindOpen(false); cmInst.focus(); }} />
      )}
    </div>
  );
}

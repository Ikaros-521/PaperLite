/* PaperLite · 编辑器封装（CodeMirror 优先，纯 textarea 兜底） */
(function (global) {
'use strict';

function init(container, onChange) {
  var api = { kind: 'cm', cm: null, ta: null };

  if (global.CodeMirror) {
    var cm = global.CodeMirror(container, {
      value: '',
      mode: 'stex',
      lineNumbers: true,
      lineWrapping: true,
      autoCloseBrackets: true,
      matchBrackets: true,
      styleActiveLine: true,
      tabindex: 2,
      extraKeys: {
        'Ctrl-S': function () { if (api.onSave) api.onSave(); return false; },
        'Cmd-S': function () { if (api.onSave) api.onSave(); return false; }
      }
    });
    cm.on('change', function () { onChange && onChange(); });
    api.cm = cm;
    api.getValue = function () { return cm.getValue(); };
    api.setValue = function (v, keepCursor) {
      var cur = keepCursor ? cm.getCursor() : null;
      cm.setValue(v);
      if (cur) cm.setCursor(cur);
    };
    api.replaceRange = function (text, from, to) { cm.replaceRange(text, from, to); };
    api.posFromIndex = function (i) { return cm.posFromIndex(i); };
    api.getRange = function (from, to) { return cm.getRange(from, to); };
    api.getCursor = function () { return cm.getCursor(); };
    api.setCursor = function (p) { cm.setCursor(p); };
    api.focus = function () { cm.focus(); };
    api.scrollInfo = function () { return cm.getScrollInfo(); };
    api.scrollTo = function (x, y) { cm.scrollTo(x, y); };
  } else {
    // 兜底 textarea
    var wrap = document.createElement('div');
    wrap.className = 'ta-fallback';
    var ta = document.createElement('textarea');
    ta.spellcheck = false;
    wrap.appendChild(ta);
    container.appendChild(wrap);
    ta.addEventListener('input', function () { onChange && onChange(); });
    api.kind = 'ta'; api.ta = ta;
    api.getValue = function () { return ta.value; };
    api.setValue = function (v) { ta.value = v; };
    api.replaceRange = function (text, from, to) {
      var s = from.index, e = to.index;
      ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    };
    api.posFromIndex = function (i) { return { index: i }; };
    api.getRange = function (from, to) { return ta.value.slice(from.index, to.index); };
    var selStart = function () { return ta.selectionStart; };
    api.getCursor = function () { return { index: ta.selectionStart }; };
    api.setCursor = function (p) { if (p && p.index != null) { ta.selectionStart = ta.selectionEnd = p.index; } };
    api.focus = function () { ta.focus(); };
    api.scrollInfo = function () { return { top: ta.scrollTop, height: ta.scrollHeight, clientHeight: ta.clientHeight }; };
    api.scrollTo = function (x, y) { ta.scrollTop = y; };
  }

  // 在光标处插入文本（选中替换）
  api.insert = function (text) {
    if (api.kind === 'cm') {
      var c = api.cm;
      c.replaceSelection(text, 'around');
      c.focus();
    } else {
      var s = api.ta.selectionStart, e = api.ta.selectionEnd;
      api.ta.value = api.ta.value.slice(0, s) + text + api.ta.value.slice(e);
      api.ta.selectionStart = api.ta.selectionEnd = s + text.length;
      onChange && onChange();
      api.ta.focus();
    }
  };
  // 包裹选中文本
  api.wrap = function (pre, post) {
    if (api.kind === 'cm') {
      var c = api.cm;
      c.replaceSelection(pre + (c.getSelection() || '') + post, 'around');
      var cur = c.getCursor();
      c.setSelection({ line: cur.line, ch: cur.ch - post.length }, cur);
      c.focus();
    } else {
      var s = api.ta.selectionStart, e = api.ta.selectionEnd;
      var mid = api.ta.value.slice(s, e);
      api.ta.value = api.ta.value.slice(0, s) + pre + mid + post + api.ta.value.slice(e);
      onChange && onChange();
      api.ta.focus();
    }
  };
  api.getLineIndent = function () {
    if (api.kind === 'cm') {
      var cur = api.cm.getCursor();
      var line = api.cm.getLine(cur.line) || '';
      return (line.match(/^\s*/) || [''])[0];
    }
    return '';
  };
  return api;
}

global.PaperLite = global.PaperLite || {};
global.PaperLite.editor = { init: init };

})(typeof window !== 'undefined' ? window : globalThis);

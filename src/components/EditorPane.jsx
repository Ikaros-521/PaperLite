import { useEffect, useRef } from 'react';
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

/* CodeMirror 5 封装：单一编辑器实例 + 每 Tab 一个 CodeMirror.Doc（swapDoc 切换，
 * 各文件独立撤销历史与光标）。mode 由 Doc 创建时指定。 */
export default function EditorPane({ doc, onChange, onInit, onScrollRatio, onSave }) {
  const hostRef = useRef(null);
  const cmRef = useRef(null);
  const cb = useRef({});
  cb.current = { onChange, onInit, onScrollRatio, onSave };

  useEffect(() => {
    const cm = CodeMirror(hostRef.current, {
      value: '',
      lineNumbers: true,
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
    cm.on('change', () => cb.current.onChange && cb.current.onChange(cm.getDoc(), cm.getValue()));
    cm.on('scroll', () => {
      const si = cm.getScrollInfo();
      const ratio = si.top / Math.max(1, si.height - si.clientHeight);
      cb.current.onScrollRatio && cb.current.onScrollRatio(ratio, 'edit');
    });
    cb.current.onInit && cb.current.onInit(cm);
    setTimeout(() => cm.refresh(), 50);
    return () => {
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

  return <div id="editorPane"><div id="editorHost" ref={hostRef} /></div>;
}

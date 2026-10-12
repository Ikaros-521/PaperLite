import { useEffect, useRef } from 'react';
import CodeMirror from 'codemirror';
import 'codemirror/mode/stex/stex';
import 'codemirror/addon/edit/closebrackets';
import 'codemirror/addon/edit/matchbrackets';
import 'codemirror/addon/selection/active-line';

/* CodeMirror 5 封装：仅挂载一次；外部 setValue 通过 App 持有的实例调用 */
export default function EditorPane({ initial, onChange, onInit, onScrollRatio, onSave }) {
  const hostRef = useRef(null);
  const initialRef = useRef(initial);
  const cb = useRef({});
  cb.current = { onChange, onInit, onScrollRatio, onSave };

  useEffect(() => {
    const cm = CodeMirror(hostRef.current, {
      value: initialRef.current,
      mode: 'stex',
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
    cm.on('change', () => cb.current.onChange && cb.current.onChange(cm.getValue()));
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

  return <div id="editorPane"><div id="editorHost" ref={hostRef} /></div>;
}

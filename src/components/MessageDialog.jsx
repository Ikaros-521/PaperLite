import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { currentDialog, subscribeDialogs, finishDialog } from '../dialogs.js';
import { useT } from '../useI18n.js';

function MessageDialog({ request }) {
  const t = useT();
  const ref = useRef(null), focusRef = useRef(null);
  const [value, setValue] = useState(request.value || '');
  const isPrompt = request.type === 'prompt';
  const cancel = () => finishDialog(request, isPrompt ? null : false);
  useLayoutEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    focusRef.current?.focus();
    if (isPrompt) focusRef.current?.select();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className="modal message-dialog" aria-labelledby="message-dialog-title"
    aria-describedby="message-dialog-body" onCancel={event => { event.preventDefault(); cancel(); }}>
    <form onSubmit={event => { event.preventDefault(); finishDialog(request, isPrompt ? value.trim() : true); }}>
      <div className="modal-h">
        <span id="message-dialog-title">{request.title || t('dialog.' + request.type)}</span>
        <button type="button" className="btn sm" aria-label={t('file.close')} onClick={cancel}>✕</button>
      </div>
      <div className="modal-body">
        <p id="message-dialog-body">{request.message}</p>
        {isPrompt && <input ref={focusRef} value={value} onChange={event => setValue(event.target.value)}
          aria-labelledby="message-dialog-body" required autoComplete="off" />}
      </div>
      <div className="modal-f">
        {request.type !== 'alert' && <button ref={isPrompt ? undefined : focusRef} type="button" className="btn" onClick={cancel}>{t('dialog.cancel')}</button>}
        <button ref={request.type === 'alert' ? focusRef : undefined} type="submit"
          className={'btn primary' + (request.danger ? ' danger' : '')} disabled={isPrompt && !value.trim()}>
          {request.confirmLabel || t('dialog.ok')}
        </button>
      </div>
    </form>
  </dialog>;
}

export default function DialogHost() {
  const request = useSyncExternalStore(subscribeDialogs, currentDialog, () => null);
  return request ? <MessageDialog key={requestsKey(request)} request={request} /> : null;
}

let nextKey = 0;
const keys = new WeakMap();
function requestsKey(request) {
  if (!keys.has(request)) keys.set(request, ++nextKey);
  return keys.get(request);
}

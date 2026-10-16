// Promise-based dialogs share one queue, including callers outside React.
let queue = [];
const listeners = new Set();
const publish = () => listeners.forEach(listener => listener());
export const subscribeDialogs = listener => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const currentDialog = () => queue[0] || null;
function open(type, message, options = {}) {
  return new Promise(resolve => {
    queue.push({ ...options, type, message: String(message), resolve });
    publish();
  });
}
export const showAlert = (message, options) => open('alert', message, options);
export const showConfirm = (message, options) => open('confirm', message, options);
export const showPrompt = (message, value = '', options) => open('prompt', message, { ...options, value });
export function finishDialog(dialog, value) {
  if (queue[0] !== dialog) return;
  queue.shift();
  dialog.resolve(value);
  publish();
}

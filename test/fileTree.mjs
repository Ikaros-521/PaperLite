import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { listDir, renameEntry } from '../src/fs.js';
import { extOf, infoFor, isTextEditable } from '../src/fileTypes.js';
import { showAlert, showConfirm, showPrompt, currentDialog, finishDialog, subscribeDialogs } from '../src/dialogs.js';
import { validName } from '../src/fileActions.js';

// Execute the component's hooks and handlers against an in-memory filesystem.
const source = readFileSync(new URL('../src/components/FileTree.jsx', import.meta.url), 'utf8');
const hooks = [], effects = [], reads = [];
let cursor = 0, promptValue = '', current, renameFails = false;
const renames = [];
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const translate = key => key;
const component = source.slice(source.indexOf('export default function'), source.indexOf('  const renderNodes'))
  .replace('export default ', '') + '\nreturn { children, expanded, loading, selDir, toggle, refreshTree, doNewFile, doNewDir, doRename };\n}\nFileTree';
const FileTree = vm.runInNewContext(component, {
  useState(initial) {
    const i = cursor++;
    if (!(i in hooks)) hooks[i] = initial;
    return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }];
  },
  useRef(initial) { const i = cursor++; return hooks[i] ||= { current: initial }; },
  useCallback(fn, deps) {
    const i = cursor++;
    if (!same(hooks[i]?.deps, deps)) hooks[i] = { deps, fn };
    return hooks[i].fn;
  },
  useEffect(fn, deps) {
    const i = cursor++;
    if (!same(hooks[i]?.deps, deps)) effects.push(() => {
      hooks[i]?.cleanup?.(); hooks[i] = { deps, cleanup: fn() };
    });
  },
  useT: () => translate, useLang: () => 'zh',
  validName,
  listDir: async handle => { reads.push(handle.name); return listDir(handle); },
  createFile: (dir, name) => dir.getFileHandle(name, { create: true }),
  createDirectory: (dir, name) => dir.getDirectoryHandle(name, { create: true }),
  // 真实实现会 move 后按新名字重取句柄；这里照做，让标签与刷新后的树拿到同一个对象
  renameEntry: async (handle, name, parentDir) => {
    if (renameFails) throw new Error('disk busy');
    parentDir.items.delete(handle.name);
    const moved = { name, kind: 'file' };
    parentDir.items.set(name, moved);
    return moved;
  },
  showPrompt: async () => promptValue, alert: message => { throw new Error(message); },
});
function directory(name) {
  const items = new Map();
  return { name, kind: 'directory', items,
    async *entries() { yield* items; },
    async getFileHandle(name, { create = false } = {}) {
      if (create) items.set(name, { name, kind: 'file' });
      if (!items.has(name)) throw new Error('NotFoundError');
      return items.get(name);
    },
    async getDirectoryHandle(name) {
      if (!items.has(name)) items.set(name, directory(name));
      return items.get(name);
    },
  };
}
let root = directory('project'), refreshKey = 0;
const folder = await root.getDirectoryHandle('figures');
const nested = await folder.getDirectoryHandle('nested');
function render() {
  cursor = 0;
  current = FileTree({ root, refreshKey, onOpenFile() {}, onRenamed: (oldPath, handle, name) => renames.push([oldPath, name, handle]) });
  effects.splice(0).forEach(effect => effect());
}
async function settle() { await new Promise(resolve => setImmediate(resolve)); render(); }
render(); await settle();
await current.toggle(current.children[''][0]); await settle();
await current.toggle(current.children.figures[0]); await settle();
assert.equal(current.expanded['figures/nested'], true);

promptValue = 'drawing.svg';
await current.doNewFile('figures/nested'); await settle();
assert.ok(current.children['figures/nested'].some(entry => entry.name === 'drawing.svg'));
assert.equal(reads.at(-1), 'nested', 'New files refresh their actual parent');
promptValue = 'assets';
await current.doNewDir('figures/nested'); await settle();
assert.ok(current.children['figures/nested'].some(entry => entry.name === 'assets'));
const itemCount = nested.items.size;
promptValue = null;
await current.doNewFile('figures/nested');
await current.doNewDir('figures/nested');
assert.equal(nested.items.size, itemCount, 'Canceling a name dialog must not create an entry');

await nested.getFileHandle('external.svg', { create: true });
refreshKey++; render(); await settle();
assert.equal(current.expanded.figures, true);
assert.equal(current.expanded['figures/nested'], true);
assert.equal(current.selDir, 'figures/nested');
assert.ok(current.children['figures/nested'].some(entry => entry.name === 'external.svg'));
await nested.getFileHandle('manual.svg', { create: true });
current.refreshTree(); await settle();
assert.ok(current.children['figures/nested'].some(entry => entry.name === 'manual.svg'));

// A pending read from the previous root must not overwrite the new tree.
let finishOldRead;
nested.entries = async function* () {
  await new Promise(resolve => { finishOldRead = resolve; });
  yield* nested.items;
};
current.refreshTree();
await new Promise(resolve => setImmediate(resolve));
root = directory('other');
await root.getFileHandle('main.tex', { create: true });
render(); await settle();
finishOldRead(); await settle();
assert.equal(Object.keys(current.expanded).length, 0);
assert.equal(current.children[''][0].name, 'main.tex');
assert.equal(current.children['figures/nested'], undefined);

// Renaming a tree entry retargets the open tab before the repaint.
promptValue = 'paper.tex';
await current.doRename(current.children[''][0]); await settle();
assert.equal(renames.length, 1, 'A rename notifies open tabs exactly once');
assert.deepEqual(renames[0].slice(0, 2), ['main.tex', 'paper.tex'], 'Old path and new name reach the workspace');
assert.equal(renames[0][2].name, 'paper.tex', 'Tabs receive the post-rename handle');
assert.equal(current.children[''][0].name, 'paper.tex', 'The tree repaints the new name');
assert.equal(current.children[''][0].handle, renames[0][2], 'Tree row and tab share one handle, so reopening dedupes');
const notified = renames.length;
renameFails = true; promptValue = 'broken.tex';
let renameAlert = '';
try { await current.doRename(current.children[''][0]); } catch (error) { renameAlert = error.message; }
renameFails = false;
assert.equal(renames.length, notified, 'A failed disk rename must not retarget open tabs');
assert.match(renameAlert, /ft\.renameFailed/);
promptValue = null;
await current.doRename(current.children[''][0]); await settle();
assert.equal(renames.length, notified, 'Canceling the rename dialog leaves the entry untouched');
assert.equal(current.children[''][0].name, 'paper.tex');
assert.ok(root.items.has('paper.tex'), 'Renamed entry stays under its new name');

// renameEntry hands back the handle looked up by the new name, and falls back to the live one.
const fsDir = directory('rename-source');
const oldHandle = await fsDir.getFileHandle('old.tex', { create: true });
let moves = 0;
oldHandle.move = async name => { moves++; fsDir.items.delete('old.tex'); fsDir.items.set(name, { name, kind: 'file' }); };
const resolved = await renameEntry(oldHandle, 'new.tex', fsDir);
assert.equal(moves, 1);
assert.equal(resolved.name, 'new.tex');
assert.notEqual(resolved, oldHandle, 'The refreshed tree hands out a different wrapper object');
const vanished = { name: 'gone.tex', kind: 'file', move: async () => {} };
assert.equal(await renameEntry(vanished, 'elsewhere.tex', directory('rename-lookup-fails')), vanished,
  'An unreadable new name keeps the live handle instead of reporting failure');
const immovable = { name: 'static.tex', kind: 'file' };
await assert.rejects(() => renameEntry(immovable, 'moved.tex', null));
assert.equal(immovable.name, 'static.tex', 'Without move() nothing is renamed');

// SVG remains editable XML, and its preview URL uses the current source.
assert.equal(isTextEditable('drawing.SVG'), true);
assert.equal(infoFor('drawing.SVG').mode, 'xml');
const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const svgCode = app.slice(app.indexOf('  const isSvg ='), app.indexOf('  // 编译链与移动端共用同一份'));
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>图 #1 &amp; 2</text></svg>';
for (const text of [svg, svg.replace('图 #1', '已修改')]) {
  const url = vm.runInNewContext(svgCode + '\nsvgPreviewUrl', {
    extOf, activeTab: { name: 'drawing.SVG', doc: {} }, activeValue: text, useMemo: fn => fn(),
  });
  assert.equal(decodeURIComponent(url.split(',')[1]), text);
  assert.ok(url.startsWith('data:image/svg+xml;'));
}
// Dialogs queue concurrent calls; cancel resolves without permitting mutations.
let notifications = 0;
const unsubscribe = subscribeDialogs(() => notifications++);
const confirmation = showConfirm('Delete file?');
const confirmRequest = currentDialog();
const prompt = showPrompt('File name', 'main.tex');
assert.equal(currentDialog(), confirmRequest, 'A second request does not replace an active confirmation');
finishDialog(confirmRequest, false);
assert.equal(await confirmation, false);
const promptRequest = currentDialog();
assert.equal(promptRequest.value, 'main.tex');
finishDialog(confirmRequest, true);
assert.equal(currentDialog(), promptRequest, 'Repeated dismissal cannot close the next dialog');
finishDialog(promptRequest, null);
assert.equal(await prompt, null);
const notice = showAlert('Could not open folder');
finishDialog(currentDialog(), true);
await notice;
assert.equal(currentDialog(), null);
assert.equal(notifications, 6);
unsubscribe();
console.log('File tree: nested creation/cancel, refresh state, root switch races, rename notification/handle resolution; SVG live preview; dialog queue/cancel passed.');

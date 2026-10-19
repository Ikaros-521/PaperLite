import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { validName } from '../src/fileActions.js';

// 磁盘改名与打开标签的同步：切 useWorkspace 里两份真实实现（重命名入口 + 标签路径对齐），
// 标签形状与 historyKey 规则用 tabModel 的真实实现造，免得测试自己发明一种键格式。
const workspaceSrc = readFileSync(new URL('../src/workspace/useWorkspace.js', import.meta.url), 'utf8');
const begin = workspaceSrc.indexOf('  const renameTabPath = useCallback(');
const endMarker = '  }, [alertBox, t, onTreeChanged, renameTabPath]);';
const renameSrc = workspaceSrc.slice(begin, workspaceSrc.indexOf(endMarker, begin) + endMarker.length);
assert.ok(begin > 0 && renameSrc.includes('const renameTab = useCallback(async ('), 'Both rename entry points are extracted');

const tabModelBody = readFileSync(new URL('../src/workspace/tabModel.js', import.meta.url), 'utf8')
  .split('\n').filter(line => !line.startsWith('import ')).join('\n').replace(/^export /gm, '');
const model = vm.runInNewContext(tabModelBody + '\n({ makeTab, renameHistoryKey, mergeRemoteDrafts })', {
  crypto: { randomUUID }, CodeMirror: { Doc: function (text) { this.getValue = () => text; } },
  tr: (_, k) => k, getLang: () => 'zh',
});

const root = { name: 'project' };
const diskTab = (name, path, handle, text = 'body') =>
  model.makeTab({ name, path, kind: 'tex', handle, parentDir: root, text, saved: text, historyScope: 'project' });

function build(initial, opts = {}) {
  let tabs = initial;
  const calls = { copy: [], alerts: [], errors: [], renamed: [], tree: 0, persisted: 0, paths: [] };
  const api = vm.runInNewContext(renameSrc + '\n({ renameTab, renameTabPath })', {
    useCallback: fn => fn,
    tabsRef: { get current() { return tabs; } },
    setTabs: fn => { tabs = fn(tabs); },
    copyHistory: (from, to, { move } = {}) => { calls.copy.push([from, to, move]); return !opts.copyFails; },
    setHistoryError: message => calls.errors.push(message),
    renameHistoryKey: model.renameHistoryKey,
    tr: (lang, key) => key, getLang: () => 'zh', t: key => key,
    alertBox: message => calls.alerts.push(message),
    validName,
    onTreeChanged: () => { calls.tree++; },
    // 主文档 pin 这类「按路径存的别的设置」要收到顶层改名（哪怕没有任何标签命中）
    onPathsRenamed: (from, to) => { calls.paths.push([from, to]); },
    persistDrafts: () => { calls.persisted++; },
    fs: { renameEntry: async (handle, name, parentDir) => {
      if (opts.renameFails) throw new Error('disk busy');
      calls.renamed.push([handle, name, parentDir]);
      return opts.nextHandle || handle;
    } },
  });
  return { api, calls, tabs: () => tabs };
}

// ---- 文件改名：句柄身份或旧路径命中的标签全部跟上 ----
const treeHandle = { name: 'a.tex' };
const searchHandle = { name: 'a.tex' };      // 同一文件从项目搜索打开：包装对象不相等
const siblingHandle = { name: 'b.tex' };
const renamedHandle = { name: 'a2.tex' };
const first = diskTab('a.tex', 'chapters/a.tex', treeHandle);
const twin = diskTab('a.tex', 'chapters/a.tex', searchHandle);
const sibling = diskTab('b.tex', 'chapters/b.tex', siblingHandle);
const draft = model.makeTab({ name: 'note.tex', kind: 'draft', text: 'draft body' });
const inMemory = model.makeTab({ name: 'a.tex', path: 'chapters/a.tex', kind: 'tex', text: 'no disk backing' });

let fixture = build([first, twin, sibling, draft, inMemory]);
assert.equal(fixture.api.renameTabPath('chapters/a.tex', renamedHandle, 'a2.tex'), true);
assert.deepEqual(fixture.tabs().map(tab => [tab.name, tab.path]), [
  ['a2.tex', 'chapters/a2.tex'], ['a2.tex', 'chapters/a2.tex'], ['b.tex', 'chapters/b.tex'],
  ['note.tex', 'note.tex'], ['a.tex', 'chapters/a.tex'],
], 'Only disk-backed tabs of the renamed file move; the draft and the unbacked tab stay put');
assert.ok(fixture.tabs()[0].handle === renamedHandle && fixture.tabs()[1].handle === renamedHandle,
  'Both open tabs retarget to the post-rename handle the tree now hands out');
assert.equal(fixture.tabs()[0].doc, first.doc, 'Renaming never touches the document');
assert.equal(fixture.tabs()[0].saved, 'body');
assert.equal(JSON.parse(fixture.tabs()[0].historyKey)[1], 'chapters/a2.tex', 'Version history follows the new path');
assert.deepEqual(fixture.calls.copy, [
  [first.historyKey, fixture.tabs()[0].historyKey, true],
  [twin.historyKey, fixture.tabs()[1].historyKey, true],
], 'Old history keys are merged into the new path key and recycled (both tabs share one old key)');
assert.equal(fixture.calls.tree, 0, 'renameTabPath itself does not refresh the tree');
assert.deepEqual(fixture.calls.paths, [['chapters/a.tex', 'chapters/a2.tex']],
  'The top-level path move is published once for other path-keyed settings (main-doc pin)');

fixture = build([first]);
assert.equal(fixture.api.renameTabPath('chapters/zzz.tex', { name: 'x' }, 'other.tex'), false);
assert.deepEqual(fixture.calls.copy, [], 'A rename with no open tab notifies nothing');
assert.deepEqual(fixture.calls.paths, [['chapters/zzz.tex', 'chapters/other.tex']],
  'No open tab still has to migrate the pinned main doc, or the pin silently stops working');

// ---- 文件夹改名：整棵子树换前缀，标签名不动 ----
const nested = diskTab('c.tex', 'chapters/deep/c.tex', { name: 'c.tex' });
fixture = build([first, sibling, nested]);
assert.equal(fixture.api.renameTabPath('chapters', { name: 'sections' }, 'sections'), true);
assert.deepEqual(fixture.tabs().map(tab => tab.path),
  ['sections/a.tex', 'sections/b.tex', 'sections/deep/c.tex']);
assert.deepEqual(fixture.tabs().map(tab => tab.name), ['a.tex', 'b.tex', 'c.tex'], 'Only the prefix changes');
assert.equal(JSON.parse(fixture.tabs()[2].historyKey)[1], 'sections/deep/c.tex');
assert.deepEqual(fixture.calls.copy.map(x => x[2]), [true, true, true], 'Every old prefix key is recycled');

// ---- 历史迁移失败：保留旧键并说明，不把版本静默丢掉 ----
fixture = build([first], { copyFails: true });
fixture.api.renameTabPath('chapters/a.tex', renamedHandle, 'a2.tex');
assert.equal(fixture.tabs()[0].path, 'chapters/a2.tex', 'Path still follows the disk');
assert.equal(fixture.tabs()[0].historyKey, first.historyKey, 'Unmigrated history keeps its key');
assert.deepEqual(fixture.calls.errors, ['hist.storageError']);

// ---- historyKey 形状守卫 ----
assert.equal(model.renameHistoryKey(draft.historyKey, 'note.tex', 'renamed.tex'), null,
  'Draft keys are indexed by draftId, not path');
assert.equal(model.renameHistoryKey(JSON.stringify(['project', 'other.tex']), 'chapters/a.tex', 'chapters/b.tex'), null);
assert.equal(model.renameHistoryKey(JSON.stringify(['project', 'a.tex']), 'a.tex', 'a.tex'), null);
assert.equal(model.renameHistoryKey('not json', 'a.tex', 'b.tex'), null);
assert.equal(model.renameHistoryKey(JSON.stringify(['', 'a.tex']), 'a.tex', 'b.tex'), JSON.stringify(['', 'b.tex']));

// ---- 移动端唯一的重命名通道：磁盘标签先改盘，成功后才同步元数据 ----
const disk = diskTab('intro.tex', 'chapters/intro.tex', treeHandle);
fixture = build([disk]);
assert.equal(await fixture.api.renameTab(disk.id, 'open.tex'), true);
assert.deepEqual(fixture.calls.renamed, [[treeHandle, 'open.tex', root]], 'Rename goes to the disk first');
assert.deepEqual([fixture.tabs()[0].name, fixture.tabs()[0].path], ['open.tex', 'chapters/open.tex'],
  'The subdirectory prefix survives the rename');
assert.equal(fixture.calls.tree, 1, 'The folder scan is told about the rename');
assert.equal(JSON.parse(fixture.tabs()[0].historyKey)[1], 'chapters/open.tex');

fixture = build([disk], { renameFails: true });
assert.equal(await fixture.api.renameTab(disk.id, 'open.tex'), false);
assert.deepEqual([fixture.tabs()[0].name, fixture.tabs()[0].path], ['intro.tex', 'chapters/intro.tex'],
  'A failed disk rename must not leave the label ahead of the file');
assert.deepEqual(fixture.calls.alerts, ['ft.renameFailed']);
assert.equal(fixture.calls.tree, 0);

// ---- 草稿与未落盘标签不碰磁盘；同名、空名、非法名提前收口 ----
const localDraft = model.makeTab({ name: 'note.tex', path: '浏览器草稿', kind: 'draft', text: 'draft body' });
fixture = build([localDraft]);
assert.equal(await fixture.api.renameTab(localDraft.id, 'idea.tex'), true);
assert.deepEqual([fixture.tabs()[0].name, fixture.tabs()[0].path], ['idea.tex', '浏览器草稿'],
  'A draft only relabels; its pseudo-path stays');
assert.equal(fixture.calls.renamed.length, 0, 'A browser draft has no file to rename');
assert.equal(fixture.calls.persisted, 1, 'Draft renames are stored immediately');

const unsaved = model.makeTab({ name: 'draft.tex', path: 'unsaved/draft.tex', kind: 'tex', text: 'x' });
fixture = build([unsaved]);
assert.equal(await fixture.api.renameTab(unsaved.id, 'paper.tex'), true);
assert.deepEqual([fixture.tabs()[0].name, fixture.tabs()[0].path], ['paper.tex', 'unsaved/paper.tex']);
assert.equal(fixture.calls.renamed.length, 0);

fixture = build([disk]);
assert.equal(await fixture.api.renameTab(disk.id, ' intro.tex '), true);
assert.equal(fixture.calls.renamed.length, 0, 'The same name is not a disk rename');
assert.equal(await fixture.api.renameTab(disk.id, '   '), false);
assert.equal(await fixture.api.renameTab(9999, 'other.tex'), false);
fixture = build([disk]);
assert.equal(await fixture.api.renameTab(disk.id, 'bad/name.tex'), false);
assert.deepEqual(fixture.calls.alerts, ['app.badFileName']);
assert.equal(fixture.calls.renamed.length, 0);

console.log('Rename sync: tree notification, handle/path/history migration, folder prefix moves, disk-first mobile rename and failure paths passed.');

// ---- 跨窗口草稿合并（storage 事件整库写回的应答方）----
// 逐条比时钟：本地这条还有没落盘的字节才保留本地；远端是旧快照时按兵不动。
// 时钟用可比较的小整数，别让 makeTab 的 Date.now() 参与判断（那会把远端永远判成旧的）。
const T_OLD = 1000, T_NEW = 2000, T_LATE = 3000;
const mkDraft = (name, text, o = {}) => {
  const t = model.makeTab({ name, kind: 'draft', text, saved: o.saved !== undefined ? o.saved : text, updatedAt: o.updatedAt !== undefined ? o.updatedAt : T_OLD });
  return { ...t, dirty: !!o.dirty };
};
const remoteOf = tabs => JSON.stringify(tabs.map(x => ({ id: x.draftId, name: x.name, text: x.doc.getValue(), updated: x.updatedAt })));

let locals = [
  mkDraft('a.tex', 'local v1'),                                   // 干净、旧 → 跟随远端
  mkDraft('b.tex', 'local v1'),                                   // 干净 → 跟随远端改名
  mkDraft('c.tex', 'dirty body', { saved: '' }),                  // 有未落盘字节 → 保留
  mkDraft('d.tex', 'newer here', { updatedAt: T_NEW }),            // 远端这份更旧 → 按兵不动
  mkDraft('e.tex', 'only mine', { updatedAt: T_LATE }),            // 远端没有且整库时钟更旧 → 不跟着删
];
let remote = JSON.stringify([
  { id: locals[0].draftId, name: 'a.tex', text: 'remote v2', updated: T_NEW },
  { id: locals[1].draftId, name: 'b-renamed.tex', text: 'local v1', updated: T_NEW },
  { id: locals[3].draftId, name: 'd.tex', text: 'stale from old window', updated: T_OLD },
  { id: 'new-1', name: 'f.tex', text: 'from other window', updated: T_NEW },
]);
let merged = model.mergeRemoteDrafts(locals, remote);
assert.equal(merged.length, 6, `保留 c/d/e、跟随 a/b、追加 f（得到 ${merged.length}）`);
assert.equal(merged[0].doc.getValue(), 'remote v2', '干净的草稿跟随更新的远端文本');
assert.equal(merged[0].saved, 'remote v2', 'saved 一并推进，避免 beforeunload 误报');
assert.equal(merged[0].updatedAt, T_NEW, '时钟随远端推进，来回合并不再重复触发');
assert.notEqual(merged[0].doc, locals[0].doc, '换新 Doc，不在更新器里原地改');
assert.equal(merged[1].name, 'b-renamed.tex', '远端改名跟随');
assert.equal(merged[2].name, 'c.tex', '本地有未落盘内容的即使被远端删除也保留');
assert.equal(merged[3].doc.getValue(), 'newer here', '远端这份是旧快照时不覆盖本地已落盘的新内容');
assert.equal(merged[4].name, 'e.tex', '远端时钟早于本地这条 = 它没见过这条，不按删除处理');
assert.equal(merged[5].draftId, 'new-1', '远端新增草稿按原 draftId 追加');
assert.equal(merged[5].doc.getValue(), 'from other window');

// 无变化必须返回原数组引用，让 setTabs 的 bail-out 生效
let same = model.mergeRemoteDrafts(locals, remoteOf(locals));
assert.equal(same, locals, '完全一致时返回原引用');
same = model.mergeRemoteDrafts(locals, 'not json');
assert.equal(same, locals, '远端载荷坏掉时按兵不动');
same = model.mergeRemoteDrafts(locals, JSON.stringify([{ id: 'x', text: 42 }]));
assert.equal(same, locals, '形状不对（text 非字符串）的条目忽略');

// dirty 恒为 true 但内容已落盘（● 表示「没落到磁盘文件」的既有语义）：
// 合并不能因此永久失效，否则两个窗口各写整库，后写的连坐覆盖先写的字节
const storedButMarked = mkDraft('g.tex', 'both edited', { dirty: true });
merged = model.mergeRemoteDrafts([storedButMarked], JSON.stringify([{ id: storedButMarked.draftId, name: 'g.tex', text: 'other window won', updated: T_NEW }]));
assert.equal(merged[0].doc.getValue(), 'other window won', '已落盘的草稿照常跟随远端');
assert.equal(merged[0].dirty, true, '● 的语义不受合并影响');

// 本地确有未落盘字节 + 远端有更新：本地赢，远端文本在本地落盘后的下一轮合并再进来
const dirtyLocal = mkDraft('h.tex', 'typing...', { saved: '' });
merged = model.mergeRemoteDrafts([dirtyLocal], JSON.stringify([{ id: dirtyLocal.draftId, name: 'h.tex', text: 'remote wins?', updated: T_NEW }]));
assert.equal(merged[0].doc.getValue(), 'typing...', '本地未保存内容优先');
assert.equal(merged.length, 1, '不重复、不丢失');

console.log('Draft multi-window merge: per-draft clock, clean-follows-newer-remote, stale-remote-ignored, dirty-badge merge, delete/new/bad-payload semantics passed.');

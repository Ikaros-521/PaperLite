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
const model = vm.runInNewContext(tabModelBody + '\n({ makeTab, renameHistoryKey })', {
  crypto: { randomUUID }, CodeMirror: { Doc: function (text) { this.getValue = () => text; } },
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

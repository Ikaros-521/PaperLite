import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { saveState } from '../src/saveState.js';
import { infoFor } from '../src/fileTypes.js';
import { tourStepsFor, shouldWelcome, dismissWelcome } from '../src/tour.js';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const extract = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
// 标签/草稿数据层已抽到 src/workspace/tabModel.js，测试直接切那份真实实现（去掉 import 行后可在 vm 里跑）
const tabModelBody = readFileSync(new URL('../src/workspace/tabModel.js', import.meta.url), 'utf8')
  .split('\n').filter(line => !line.startsWith('import ')).join('\n').replace(/^export /gm, '');
const modelWith = sandbox => vm.runInNewContext(
  tabModelBody + '\n({ makeTab, readDrafts, draftsOf, persistDrafts, markDraftsStored, hasUnsavedWork })', sandbox);
// 自动保存 effect 已从 App.jsx 抽到 useWorkspace，测试改切这份真实实现
const workspaceSrc = readFileSync(new URL('../src/workspace/useWorkspace.js', import.meta.url), 'utf8');
let value = 'A', disk = '', finish, fail = false;
let tabs = [{ id: 1, kind: 'tex', name: 'paper.tex', handle: {}, historyKey: 'h', saved: 'old', dirty: true,
  doc: { getValue: () => value, setValue: text => { value = text; } } }];
const common = {
  useCallback: fn => fn, activeId: 1, rootDir: null, flash() {},
  tabsRef: { get current() { return tabs; } }, setTabs: fn => { tabs = fn(tabs); },
  recordVersion: () => ({ ok: true }), setHistoryError() {}, setHistoryTick() {},
  getLang: () => 'zh', tr: (_, key) => key, t: key => key, alert() {}, infoFor,
};
const writeFileText = async (_, text) => {
  await new Promise(resolve => { finish = resolve; });
  if (fail) throw new Error('write failed');
  disk = text;
};
const SAVE_DEPS = '  }, [activeId, rootDir, saveTabAs, alertBox]);';
const saveBegin = workspaceSrc.indexOf('  const saveActive = useCallback(');
const saveSource = workspaceSrc.slice(saveBegin, workspaceSrc.indexOf(SAVE_DEPS, saveBegin) + SAVE_DEPS.length);
const save = vm.runInNewContext(saveSource + '\nsaveActive', {
  ...common, fs: { writeFileText }, flashRef: { current: () => {} }, alertBox: () => {}, saveTabAs: async () => false,
});
let pending = save(); assert.equal(saveState(tabs[0]), 'saving'); value = 'B'; finish(); await pending;
assert.equal(disk, 'A'); assert.equal(tabs[0].saved, 'A'); assert.equal(tabs[0].dirty, true);
pending = save(); finish(); await pending;
assert.equal(disk, 'B'); assert.equal(tabs[0].saved, 'B'); assert.equal(tabs[0].dirty, false);
value = 'C'; tabs[0].dirty = true; fail = true;
pending = save(); finish(); await pending;
assert.equal(tabs[0].saved, 'B'); assert.equal(tabs[0].dirty, true); fail = false;
assert.equal(saveState(tabs[0]), 'failed');

// Both Save As paths must preserve changes typed while the picker/write waits.
for (const kind of ['tex', 'draft']) for (const inFolder of [true, false]) {
  value = 'save-as A';
  tabs[0] = { ...tabs[0], kind, handle: null, saved: '', dirty: true };
  const asBegin = workspaceSrc.indexOf('  const saveTabAs = useCallback(');
  const asDeps = '  }, [t, rootDir, confirm, alertBox, onTreeChanged]);';
  const asSource = workspaceSrc.slice(asBegin, workspaceSrc.indexOf(asDeps, asBegin) + asDeps.length);
  const saveAs = vm.runInNewContext(asSource + '\nsaveTabAs', {
    ...common, rootDir: inFolder ? { name: 'project', getFileHandle: async () => { throw new Error('missing'); } } : null,
    window: { showSaveFilePicker: async () => ({ name: 'paper.tex' }) },
    fs: { createFile: async () => ({}), writeFileText }, copyHistory: () => true,
    confirm: async () => true, alertBox: () => {}, flashRef: { current: () => {} },
    onTreeChanged() {}, downloadFile() {},
  });
  pending = saveAs(tabs[0]);
  // Advance the picker and file-creation awaits before resolving the write.
  await new Promise(resolve => setImmediate(resolve));
  value = 'save-as B'; finish(); await pending;
  assert.equal(disk, 'save-as A'); assert.equal(tabs[0].saved, 'save-as A'); assert.equal(tabs[0].dirty, true);
  assert.equal(tabs[0].kind, 'tex', 'Saving a browser draft to disk turns it into a file-backed tab');
  assert.equal(saveState(tabs[0]), 'diskUnsaved');
}

const template = vm.runInNewContext(extract('  const loadTemplate = async', '\n  // ---- 编译') + '\nloadTemplate', {
  ...common, showConfirm: async () => true, samples: { blank: 'template content' }, setActiveValue() {},
});
const before = tabs[0].saved;
await template('blank');
assert.equal(value, 'template content'); assert.equal(tabs[0].saved, before); assert.equal(tabs[0].dirty, true);

const { makeTab } = modelWith({
  crypto: { randomUUID }, CodeMirror: { Doc: function(text) { this.getValue = () => text; } },
});
const first = makeTab({ name: 'same.tex', kind: 'draft', text: 'first' });
const second = makeTab({ name: 'same.tex', kind: 'draft', text: 'second' });
assert.notEqual(first.historyKey, second.historyKey);
const restored = makeTab({ name: 'same.tex', kind: 'draft', draftId: first.draftId });
assert.equal(restored.historyKey, first.historyKey);
const { makeTab: makeFallbackTab } = modelWith({});
assert.notEqual(makeFallbackTab({ kind: 'draft' }).historyKey, makeFallbackTab({ kind: 'draft' }).historyKey);
const inputDrafts = [{ id: first.draftId, name: first.name, text: 'first' }, { id: second.draftId, name: second.name, text: 'second' }];
const { readDrafts } = modelWith({
  // 模块内部自己 const 了键名，注入别名会被遮蔽，这里用真实键
  localStorage: { getItem: key => key === 'paperlite.drafts.v1' ? JSON.stringify(inputDrafts) : null },
  samples: { demo: 'demo' },
});
assert.deepEqual(JSON.parse(JSON.stringify(readDrafts())), inputDrafts);

// Resource URLs must honor GitHub Pages subpaths for URL and byte-backed PDFs.
const pdfSource = readFileSync(new URL('../src/pdf.js', import.meta.url), 'utf8');
const options = vm.runInNewContext(pdfSource.slice(pdfSource.indexOf('export function pdfOptions'), pdfSource.indexOf('export function loadPdfLibrary')).replace('export ', '') + '\npdfOptions', {
  URL, document: { baseURI: 'https://example.test/PaperLite/' },
});
const bytes = new Uint8Array([1]);
assert.equal(options({ data: bytes }).data, bytes);
assert.equal(options({ url: 'blob:test' }).url, 'blob:test');
assert.equal(options({}).cMapUrl, 'https://example.test/PaperLite/pdfjs/cmaps/');
assert.equal(options({}).standardFontDataUrl, 'https://example.test/PaperLite/pdfjs/standard_fonts/');
assert.equal(options({}).cMapPacked, true);
console.log('Document safety: delayed save/retry/failure, both Save As paths, template dirty state, persistent draft identity and PDF subpath resources passed.');

// Every compiled-PDF entry point shares the stale-source guard, reading the live Doc.
let confirmations = 0, downloads = 0;
for (const [source, current, tabId, confirm, expected] of [
  ['A', 'A', 1, false, 1], ['A', 'B', 1, false, 0], ['A', 'B', 1, true, 1], ['A', 'A', 2, true, 0],
]) {
  confirmations = 0; downloads = 0;
  const download = vm.runInNewContext(extract('  const downloadCurrentPdf = async', '\n  const SNIP') + '\ndownloadCurrentPdf', {
    compileResult: { ok: true, source, tabId }, activeTab: { id: 1, doc: { getValue: () => current } },
    t: key => key, showConfirm: async () => { confirmations++; return confirm; },
    downloadCompiled: () => { downloads++; },
  });
  await download(); assert.equal(downloads, expected);
  assert.equal(confirmations, source !== current && tabId === 1 ? 1 : 0);
}
console.log('PDF exports: matching source, stale rejection/acceptance and document isolation passed.');

// Autosave failure remains visible, retries clear it, and disk saves leave the draft set.
const autoBegin = workspaceSrc.indexOf('  useEffect(() => {', workspaceSrc.indexOf('  const draftMembership'));
const autoEndMarker = '  }, [activeValue, tabs.length, draftMembership]);';
const autoSource = workspaceSrc.slice(autoBegin, workspaceSrc.indexOf(autoEndMarker, autoBegin) + autoEndMarker.length);
let autosave, rejectAuto = false, storedDrafts;
const autoStorage = { setItem: (_, text) => { if (rejectAuto) throw new Error('quota'); storedDrafts = JSON.parse(text); } };
const autoModel = modelWith({
  localStorage: autoStorage, LS_DRAFTS: 'drafts', LS_DOC: 'legacy', samples: { demo: 'demo' },
  CodeMirror: { Doc: function (text) { this.getValue = () => text; } },
});
value = 'browser draft';
tabs = [{ id: 1, kind: 'draft', saved: '', doc: { getValue: () => value } }];
vm.runInNewContext(autoSource, {
  ...common, tabs, activeValue: value, draftMembership: '1', draftsWarnedRef: { current: false },
  flashRef: { current: () => {} },
  persistDrafts: autoModel.persistDrafts, markDraftsStored: autoModel.markDraftsStored,
  useEffect: fn => fn(), setTimeout: fn => { autosave = fn; return 1; }, clearTimeout() {},
});
assert.equal(saveState(tabs[0]), 'browserPending');
autosave(); assert.equal(saveState(tabs[0]), 'browserSaved');
value = 'new text'; assert.equal(saveState(tabs[0]), 'browserPending');
rejectAuto = true; autosave(); assert.equal(saveState(tabs[0]), 'failed');
rejectAuto = false; autosave(); assert.equal(saveState(tabs[0]), 'browserSaved');
tabs[0] = { ...tabs[0], kind: 'tex', handle: {} }; autosave(); assert.deepEqual(storedDrafts, []);
assert.equal(saveState(tabs[0]), 'diskSaved');
assert.equal(saveState({ ...tabs[0], handle: null }), 'unsaved');
assert.equal(saveState({ kind: 'image' }), null);

const mobileTour = tourStepsFor({ compact: true, viewMode: 'edit', hasEditor: true, richPreview: true, texDocument: true });
assert.equal(mobileTour.find(step => step.key === 'menus').target, '#compactMenuToggle');
assert.equal(mobileTour.find(step => step.key === 'sidebar').target, '#sidebarToggle');
assert.equal(mobileTour.some(step => ['paper', 'previewbar'].includes(step.key)), false);
const pdfTour = tourStepsFor({ compact: false, viewMode: 'preview', hasEditor: true, richPreview: false, texDocument: true });
assert.equal(pdfTour.some(step => ['editor', 'tabs', 'sidebar', 'paper', 'previewbar'].includes(step.key)), false);
const codeTour = tourStepsFor({ compact: true, viewMode: 'edit', hasEditor: true, richPreview: false, texDocument: false });
assert.equal(codeTour.some(step => ['quicktools', 'insert', 'tex'].includes(step.key)), false);
const tourStorage = new Map();
globalThis.localStorage = { getItem: key => tourStorage.get(key), setItem: (key, text) => tourStorage.set(key, text) };
assert.equal(shouldWelcome(), true); dismissWelcome(true); assert.equal(shouldWelcome(), false);
delete globalThis.localStorage;
console.log('Onboarding and save status: persistent autosave errors/retry, draft-to-file transition, context-aware tours and welcome dismissal passed.');

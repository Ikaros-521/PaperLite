import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const extract = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
let value = 'A', disk = '', finish, fail = false;
let tabs = [{ id: 1, kind: 'tex', name: 'paper.tex', handle: {}, historyKey: 'h', saved: 'old', dirty: true,
  doc: { getValue: () => value, setValue: text => { value = text; } } }];
const common = {
  useCallback: fn => fn, activeId: 1, rootDir: null, flash() {},
  tabsRef: { get current() { return tabs; } }, setTabs: fn => { tabs = fn(tabs); },
  recordVersion: () => ({ ok: true }), setHistoryError() {}, setHistoryTick() {},
  getLang: () => 'zh', tr: (_, key) => key, t: key => key, alert() {},
};
const writeFileText = async (_, text) => {
  await new Promise(resolve => { finish = resolve; });
  if (fail) throw new Error('write failed');
  disk = text;
};
const save = vm.runInNewContext(extract('  const saveActive = useCallback(', '\n  // ---- 关闭标签') + '\nsaveActive', {
  ...common, fs: { writeFileText },
});
let pending = save(); value = 'B'; finish(); await pending;
assert.equal(disk, 'A'); assert.equal(tabs[0].saved, 'A'); assert.equal(tabs[0].dirty, true);
pending = save(); finish(); await pending;
assert.equal(disk, 'B'); assert.equal(tabs[0].saved, 'B'); assert.equal(tabs[0].dirty, false);
value = 'C'; tabs[0].dirty = true; fail = true;
pending = save(); finish(); await pending;
assert.equal(tabs[0].saved, 'B'); assert.equal(tabs[0].dirty, true); fail = false;

// Both Save As paths must preserve changes typed while the picker/write waits.
for (const inFolder of [true, false]) {
  value = 'save-as A';
  tabs[0] = { ...tabs[0], handle: null, saved: '', dirty: true };
  const saveAs = vm.runInNewContext(extract('  const saveTabAs = async', '\n  // ---- 保存') + '\nsaveTabAs', {
    ...common, rootDir: inFolder ? { name: 'project', getFileHandle: async () => { throw new Error('missing'); } } : null,
    window: { showSaveFilePicker: async () => ({ name: 'paper.tex' }) },
    fs: { createFile: async () => ({}), writeFileText }, copyHistory: () => true, setTreeKey() {},
  });
  pending = saveAs(tabs[0]);
  // Advance the picker and file-creation awaits before resolving the write.
  await new Promise(resolve => setImmediate(resolve));
  value = 'save-as B'; finish(); await pending;
  assert.equal(disk, 'save-as A'); assert.equal(tabs[0].saved, 'save-as A'); assert.equal(tabs[0].dirty, true);
}

const template = vm.runInNewContext(extract('  const loadTemplate = async', '\n  // ---- 编译') + '\nloadTemplate', {
  ...common, showConfirm: async () => true, samples: { blank: 'template content' }, setActiveValue() {},
});
const before = tabs[0].saved;
await template('blank');
assert.equal(value, 'template content'); assert.equal(tabs[0].saved, before); assert.equal(tabs[0].dirty, true);

const makeTab = vm.runInNewContext(extract('function makeTab(', '\nexport default function App') + '\nmakeTab', {
  tabSeq: 0, crypto: { randomUUID }, CodeMirror: { Doc: function(text) { this.getValue = () => text; } },
});
const first = makeTab({ name: 'same.tex', kind: 'draft', text: 'first' });
const second = makeTab({ name: 'same.tex', kind: 'draft', text: 'second' });
assert.notEqual(first.historyKey, second.historyKey);
const restored = makeTab({ name: 'same.tex', kind: 'draft', draftId: first.draftId });
assert.equal(restored.historyKey, first.historyKey);
const makeFallbackTab = vm.runInNewContext(extract('function makeTab(', '\nexport default function App') + '\nmakeTab', { tabSeq: 0 });
assert.notEqual(makeFallbackTab({ kind: 'draft' }).historyKey, makeFallbackTab({ kind: 'draft' }).historyKey);
const inputDrafts = [{ id: first.draftId, name: first.name, text: 'first' }, { id: second.draftId, name: second.name, text: 'second' }];
const readDrafts = vm.runInNewContext(app.slice(app.indexOf('function readDrafts()'), app.indexOf('\nfunction rangeText')) + '\nreadDrafts', {
  localStorage: { getItem: key => key === 'drafts' ? JSON.stringify(inputDrafts) : null }, LS_DRAFTS: 'drafts', LS_KEY: 'legacy',
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

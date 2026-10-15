import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import katex from 'katex';

const source = name => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

// Inherited trust must not enable javascript links (GHSA-238p-pmpm-9mq7).
const inheritedOptions = Object.assign(Object.create({ trust: true }), { throwOnError: false });
assert.doesNotMatch(katex.renderToString(String.raw`\href{javascript:alert(1)}{click}`, inheritedOptions),
  /href=["']javascript:/i);
async function settles(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Operation did not settle after cancellation')), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

// Exercise the actual persistence handlers without mounting CodeMirror/React.
const app = source('App.jsx');
const drafts = Array.from({ length: 24 }, (_, i) => ({ name: 'draft ' + i, text: 'content ' + i }));
const stored = new Map([['drafts', JSON.stringify(drafts)]]);
let failWrites = false;
const storage = {
  getItem: key => stored.get(key) || null,
  setItem: (key, value) => { if (failWrites) throw new Error('QuotaExceededError'); stored.set(key, value); },
};
const readDrafts = vm.runInNewContext(app.slice(app.indexOf('function readDrafts()'), app.indexOf('\nfunction rangeText'))
  + '\nreadDrafts', { localStorage: storage, LS_DRAFTS: 'drafts', LS_KEY: 'legacy', samples: { demo: 'demo' } });
assert.equal(JSON.stringify(readDrafts()), JSON.stringify(drafts), 'All persisted drafts must survive reload');
storage.setItem('drafts', JSON.stringify(readDrafts()));
assert.equal(JSON.parse(stored.get('drafts')).length, 24, 'Subsequent autosave must not discard older drafts');

let tabs = [{ id: 1, kind: 'draft', name: 'draft', dirty: true, saved: 'old', historyKey: 'h',
  doc: { getValue: () => 'new content' } }];
const flashes = [];
const saveBegin = app.indexOf('  const saveActive = useCallback(');
const saveEnd = app.indexOf('  }, [activeId, rootDir, flash]);', saveBegin) + '  }, [activeId, rootDir, flash]);'.length;
const saveActive = vm.runInNewContext(app.slice(saveBegin, saveEnd) + '\nsaveActive', {
  useCallback: fn => fn, activeId: 1, rootDir: null, flash: msg => flashes.push(msg),
  tabsRef: { get current() { return tabs; } }, localStorage: storage, LS_DRAFTS: 'drafts',
  recordVersion: () => ({ ok: true }), setHistoryError() {}, setHistoryTick() {},
  getLang: () => 'zh', tr: (_, key) => key, setTabs: update => { tabs = update(tabs); },
});
failWrites = true;
await saveActive();
assert.equal(tabs[0].dirty, true, 'Failed save preserves unsaved state');
assert.equal(tabs[0].saved, 'old', 'Failed save preserves the last durable contents');
assert.deepEqual(flashes, ['app.draftSaveFailed'], 'Failed save never reports success');
failWrites = false;
await saveActive();
assert.equal(tabs[0].dirty, false);
assert.equal(tabs[0].saved, 'new content');
assert.equal(JSON.parse(stored.get('drafts'))[0].text, 'new content');
assert.equal(flashes.at(-1), 'app.draftSaved', 'Retry can persist and acknowledge a successful save');

// Run the graphics effect against persistent DOM nodes, as React does when only
// assetTabs changes. A second run must resolve the original path, not a dead Blob.
const preview = source('components/PreviewPane.jsx');
const effectBegin = preview.indexOf('  useEffect(() => {');
const effectEnd = preview.indexOf('  }, [result, assetDir, assetTabs]);', effectBegin)
  + '  }, [result, assetDir, assetTabs]);'.length;
let graphicsEffect, nextUrl = 0;
const revoked = new Set();
function image(src) {
  const attrs = new Map([['src', src]]);
  return { get src() { return attrs.get('src'); }, set src(value) { attrs.set('src', value); },
    getAttribute: name => attrs.get(name) || null, setAttribute: (name, value) => attrs.set(name, value) };
}
const localImage = image('figure.png'), remoteImage = image('https://example.test/figure.png');
const graphicsContext = {
  useEffect: callback => { graphicsEffect = callback; }, result: {}, assetDir: null,
  paperRef: { current: { querySelectorAll: () => [localImage, remoteImage] } },
  assetTabs: [{ name: 'figure.png', uploadedFile: { name: 'figure.png' } }],
  URL: { createObjectURL: () => 'blob:figure-' + ++nextUrl, revokeObjectURL: url => revoked.add(url) },
};
vm.runInNewContext(preview.slice(effectBegin, effectEnd), graphicsContext);
let cleanup = graphicsEffect();
await tick();
const firstUrl = localImage.src;
assert.match(firstUrl, /^blob:/);
cleanup();
assert.ok(revoked.has(firstUrl));
cleanup = graphicsEffect();
await tick();
assert.notEqual(localImage.src, firstUrl);
assert.equal(revoked.has(localImage.src), false, 'Effect restart installs a live URL');
assert.equal(remoteImage.src, 'https://example.test/figure.png');
cleanup();
assert.ok(revoked.has(localImage.src), 'Unmount releases the final URL');

// Mock only browser transports; execute the engine module and lifecycle logic.
function engineHarness({ manifestPending = false, prepareGraphics } = {}) {
  const workers = [], timers = new Map();
  let timerId = 0;
  class Worker {
    constructor() { this.listeners = new Map(); this.messages = []; this.terminated = false; workers.push(this); }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    emit(data) { for (const fn of [...(this.listeners.get('message') || [])]) fn({ data }); }
    postMessage(data) {
      assert.equal(this.terminated, false, 'Never send work to a terminated worker');
      this.messages.push(data);
      if (data.cmd === 'writeproject') queueMicrotask(() => this.emit({ cmd: data.cmd, result: 'ok' }));
    }
    terminate() { this.terminated = true; }
  }
  const code = source('engines/xelatex.js').replace(/^import .*;\r?\n/gm, '')
    .replace(/export /g, '').replace(/import.meta.env/g, '({})');
  const engine = vm.runInNewContext(code + '\n({compileXeLaTeX, cancelCompile, preloadEngine, warmEngine, engineStatus})', {
    document: { baseURI: 'https://paperlite.test/' }, URL, Worker, AbortController,
    setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    prepareXeLaTeXSource: text => text,
    prepareCompileGraphics: prepareGraphics || (async (source, files) => ({ source, files })),
    fetch: async (_url, { signal }) => {
      if (manifestPending) return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return { ok: true, json: async () => ({ version: 1, files: [] }) };
    },
  });
  const ready = () => workers.filter(w => !w.terminated).forEach(w => w.emit({ result: 'ok' }));
  const clean = () => {
    assert.equal(timers.size, 0, 'Cancellation clears all worker wait timers');
    for (const w of workers) for (const list of w.listeners.values()) assert.equal(list.size, 0);
  };
  return { ...engine, workers, timers, ready, clean };
}

// Cancellation must be immediate even if workers never become ready.
let engine = engineHarness();
let compiling = engine.compileXeLaTeX('source');
engine.cancelCompile();
assert.equal((await settles(compiling)).cancelled, true);
assert.equal(engine.engineStatus(), 'idle');
engine.clean();

// Start a replacement before the cancelled load's catch/finally callbacks run.
engine = engineHarness();
compiling = engine.compileXeLaTeX('source');
engine.cancelCompile();
let replacement = engine.preloadEngine();
engine.ready();
assert.equal((await settles(compiling)).cancelled, true);
await settles(replacement);
assert.equal(engine.engineStatus(), 'ready');
assert.equal(engine.workers.filter(w => !w.terminated).length, 2, 'Stale load cleanup cannot kill the replacement');
engine.cancelCompile();
engine.clean();

// Ready workers are insufficient if manifest fetching stalls.
engine = engineHarness({ manifestPending: true });
compiling = engine.compileXeLaTeX('source');
engine.ready();
await tick();
engine.cancelCompile();
assert.equal((await settles(compiling)).cancelled, true);
engine.clean();

// Cancel a running XeTeX pass and verify its listeners and timer are removed.
engine = engineHarness();
compiling = engine.compileXeLaTeX('source');
engine.ready();
await tick();
assert.ok(engine.workers[0].messages.some(m => m.cmd === 'compilelatex'));
engine.cancelCompile();
assert.equal((await settles(compiling)).cancelled, true);
engine.clean();

// An SVG conversion that completes after cancellation cannot write into new workers.
let finishGraphics;
engine = engineHarness({ prepareGraphics: (source, files) => new Promise(resolve => {
  finishGraphics = () => resolve({ source, files });
}) });
compiling = engine.compileXeLaTeX('source');
engine.ready();
await tick();
engine.cancelCompile();
replacement = engine.preloadEngine();
engine.ready();
await settles(replacement);
finishGraphics();
assert.equal((await settles(compiling)).cancelled, true);
assert.equal(engine.engineStatus(), 'ready');
assert.equal(engine.workers.at(-1).messages.some(m => m.cmd === 'writeproject' || m.cmd === 'flushcache'), false);
engine.cancelCompile();
engine.clean();

// Warm-up cancellation must not reset the replacement's promise/status.
engine = engineHarness();
const warming = engine.warmEngine('\\documentclass{article}');
engine.ready();
await tick();
engine.cancelCompile();
replacement = engine.preloadEngine();
engine.ready();
await assert.rejects(settles(warming), /cancelled/);
await settles(replacement);
assert.equal(engine.engineStatus(), 'ready');
engine.cancelCompile();
engine.clean();

console.log('Review regressions: draft quota failure/retry, 24-draft restore, image URL lifecycle, cancellation and replacement races passed.');

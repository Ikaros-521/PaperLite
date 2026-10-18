/* citationSearch.mjs — 共享检索网络层（桌面 CiteDialog 与移动端 CiteSheet 同一入口）
 * fetch 用全局注入的假实现覆盖，不碰网络；断言 URL 构造、信号透传、解析归一化与错误路径。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchCitations } from '../src/citationSearch.js';
import { PROVIDERS } from '../src/citation.js';

const CROSSREF_FIXTURE = {
  message: {
    items: [{
      title: ['Attention Is All You Need'],
      author: [{ family: 'Vaswani', given: 'Ashish' }, { family: 'Shazeer', given: 'Noam' }],
      'container-title': ['Advances in Neural Information Processing Systems'],
      issued: { 'date-parts': [[2017]] },
      type: 'journal-article',
      DOI: '10.5555/3295222',
    }],
  },
};

function withFetch(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = orig; });
}

test('searchCitations 用 provider 的 URL 请求并透传取消信号', async () => {
  let calledUrl = '', calledSignal = null;
  await withFetch(
    async (url, opts) => {
      calledUrl = url;
      calledSignal = opts && opts.signal;
      return { ok: true, json: async () => CROSSREF_FIXTURE };
    },
    () => searchCitations('crossref', 'attention', new AbortController().signal),
  );
  assert.equal(calledUrl, PROVIDERS.crossref.url('attention'));
  assert.ok(calledSignal instanceof AbortSignal, '取消信号必须透传给 fetch');
});

test('searchCitations 返回归一化条目（parse 的产出原样上抛）', async () => {
  const list = await withFetch(
    async () => ({ ok: true, json: async () => CROSSREF_FIXTURE }),
    () => searchCitations('crossref', 'x'),
  );
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Attention Is All You Need');
  assert.equal(list[0].source, 'Crossref');
  assert.equal(list[0].year, 2017);
  assert.equal(list[0].type, 'article');
});

test('searchCitations：HTTP 非 2xx 抛 Error("HTTP xxx")，由界面决定文案', async () => {
  await assert.rejects(
    withFetch(async () => ({ ok: false, status: 429 }), () => searchCitations('crossref', 'x')),
    /HTTP 429/,
  );
});

test('searchCitations：未知 provider 拒绝且不发起请求', async () => {
  let fetched = false;
  await assert.rejects(
    withFetch(async () => { fetched = true; return { ok: true, json: async () => ({}) }; },
      () => searchCitations('nope', 'x')),
    /unknown provider/,
  );
  assert.equal(fetched, false);
});

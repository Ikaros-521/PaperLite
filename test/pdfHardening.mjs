/* PDF 侧硬配置的钉子（Node）
 *
 * src/pdf.js 顶部有 `import workerUrl from 'pdfjs-dist/…?url'`——那是 Vite 专用的
 * 资源查询串，Node 里 import 这个模块必炸，所以这里钉的是「源码里确实这么写了、
 * 且写在 ...source 之后（调用方传什么都不可能把闸松开）」，而不是跑一次 getDocument。
 * 三个参数名都不是猜的：与 node_modules/pdfjs-dist/types/src/display/api.d.ts 对过。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const log = (s) => console.log('  ' + s);
const pdfSrc = readFileSync('src/pdf.js', 'utf8');
const spreadAt = pdfSrc.indexOf('...source');
assert.ok(spreadAt >= 0, 'pdfOptions 仍要先展开调用方传的参数');

// ---- 1. 关掉「把字符串当 JavaScript 执行」 ----
// isEvalSupported 默认 true：PDF 里的 Type 4 PostScript 函数会被编译成 new Function，
// 于是「打开一个 PDF」变成「执行文稿带来的代码」。生产 CSP 没有 unsafe-eval 能挡，
// 但 dev 不装 CSP（vite.config.js 里 apply:'build'），worker 里也不该指望页面策略。
const evalAt = pdfSrc.search(/isEvalSupported:\s*false\b/);
assert.ok(evalAt > spreadAt, 'isEvalSupported:false 必须写在 ...source 之后，调用方覆盖不掉');

// ---- 2. 内嵌图尺寸上限（默认 -1 = 不限总像素）----
const mImg = pdfSrc.match(/maxImageSize:\s*([0-9*\s]+)[,\n]/);
assert.ok(mImg, 'maxImageSize 要设成正数上限');
const factors = mImg[1].trim().split('*').map(s => Number(s.trim()));
assert.ok(factors.every(Number.isFinite), '上限要写成纯数字乘积，实测 "' + mImg[1].trim() + '"');
const cap = factors.reduce((a, b) => a * b, 1);
assert.ok(cap >= 8 * 1024 * 1024 && cap <= 64 * 1024 * 1024,
  '上限要挡得住畸形巨图、又别夹掉 600dpi 的扫描页（约 35M 像素），实测 ' + cap);
assert.ok(!/maxImageSize:\s*-1/.test(pdfSrc), '-1 就是「不限」，等于没设');

// ---- 3. 默认关着的能力不许被打开 ----
['enableScripting', 'enableXfa', 'enableFormFeedback', 'isEvalSupported'].forEach(k => {
  const on = new RegExp(k + ':\\s*true\\b');
  assert.ok(!on.test(pdfSrc), k + ' 不该在任何地方被设成 true');
});
assert.ok(!/workerSrc\s*=\s*['"]https?:/.test(pdfSrc), 'worker 必须是随包的同源文件，不能从远端取');

// ---- 4. 两条 getDocument 都得过 pdfOptions，不能有绕过去的路 ----
const consumers = ['src/components/PdfViewer.jsx', 'src/components/PreviewPane.jsx'];
consumers.forEach(f => {
  const s = readFileSync(f, 'utf8');
  assert.ok(/getDocument\(pdfOptions\(/.test(s), f + ' 的 getDocument 必须包 pdfOptions');
});
const all = [readFileSync('src/App.jsx', 'utf8'), ...readdirSync('src/components').map(f => readFileSync('src/components/' + f, 'utf8'))]
  .filter(s => /getDocument\(/.test(s));
assert.equal(all.length, consumers.length, '出现没包 pdfOptions 的 getDocument 调用点，需要一并纳入本钉子');

// ---- 5. 拿真实 PDF 验一遍：这几个参数不是「写了但 pdf.js 不认」，且关掉 eval 不伤正常文稿 ----
// 用仓库里现成的 XeLaTeX 产物（与 test/fixtures 的 .tex 同一篇），走 Node 安全的 legacy 构建。
// 传的就是上面从源码里解析出来的那两个值——测的正是文件里那份配置。
const FIXTURE = '.zcode/compile-check/elegantpaper.pdf';
if (existsSync(FIXTURE)) {
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = new Uint8Array(readFileSync(FIXTURE));
  const doc = await lib.getDocument({ data: pdf, isEvalSupported: false, maxImageSize: cap }).promise;
  assert.ok(doc.numPages >= 1, '正常文稿必须还能打开，实测页数 ' + doc.numPages);
  const page = await doc.getPage(1);
  const text = (await page.getTextContent()).items.map(i => String(i.str || '')).join(' ').trim();
  assert.ok(text.length > 20, '第一页要能抽出文字，实测 "' + text.slice(0, 40) + '"');
  const meta = await doc.getMetadata();
  log('真实 PDF：' + doc.numPages + ' 页，首页前 24 字 "' + text.slice(0, 24) + '"，isEvalSupported=false 下照常解析');
  await doc.destroy();
  assert.ok(!meta.info || meta.info.Producer, 'PDF 元信息读得到（说明不是空跑）');
} else {
  log('跳过真实 PDF 一档：' + FIXTURE + ' 不在（那是 XeLaTeX 编译检查的产物）');
}

console.log('pdfHardening: all tests passed');

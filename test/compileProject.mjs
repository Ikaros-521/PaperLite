import assert from 'node:assert/strict';
import { collectCompileFiles } from '../src/compileProject.js';
import { infoFor, isTextEditable } from '../src/fileTypes.js';
import { prepareCompileGraphics } from '../src/compileGraphics.js';

const encoder = new TextEncoder();
const file = (name, value) => ({ name, kind: 'file', getFile: async () => ({
  size: value.length, arrayBuffer: async () => encoder.encode(value).buffer,
}) });
const figure = file('中文 (1).pdf', '%PDF-binary\0\xff');
const section = file('section.tex', 'saved text');
const nested = { name: 'figures', kind: 'directory', async *entries() { yield [figure.name, figure]; } };
const root = { async *entries() { yield ['figures', nested]; yield [section.name, section];
  yield ['main.tex', file('main.tex', 'saved entry')];
  yield ['node_modules', { kind: 'directory', entries() { throw new Error('Skipped'); } }];
}, resolve: async handle => handle === section ? ['section.tex'] : null };
const files = await collectCompileFiles({ parentDir: root }, [{ name: 'section.tex', handle: section,
  doc: { getValue: () => 'unsaved text' } }]);
const map = new Map(files.map(({ name, bytes }) => [name, new TextDecoder().decode(bytes)]));
assert.equal(map.get('figures/中文 (1).pdf'), '%PDF-binary\0\xff');
assert.equal(map.get('section.tex'), 'unsaved text');
assert.equal(map.has('main.tex'), false);
const memory = await collectCompileFiles({}, [{ name: 'figure.pdf', uploadedFile: {
  arrayBuffer: async () => new Uint8Array([0, 255, 42]).buffer,
} }]);
assert.deepEqual([...memory[0].bytes], [0, 255, 42]);
assert.equal(infoFor('图.PDF').kind, 'pdf');
assert.equal(isTextEditable('图.pdf'), false);
const svgSource = '\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n\\includegraphics[width=0.6\\textwidth]{figures/中文 (1).svg}\n\\end{document}';
const svg = { name: 'figures/中文 (1).svg', bytes: encoder.encode('<svg/>') };
const originalSvg = svg.bytes.slice();
const preparedGraphics = await prepareCompileGraphics(svgSource, [svg, memory[0]], async () => new Uint8Array([137, 80, 78, 71]));
assert.equal(preparedGraphics.files[0].name, svg.name, 'SVG paths stay unchanged');
assert.match(preparedGraphics.source, /\\DeclareGraphicsRule\{\.svg\}\{bmp\}\{\.xbb\}\{\}/);
assert.equal(preparedGraphics.source.split('\n').length, svgSource.split('\n').length, 'Error line numbers stay unchanged');
assert.deepEqual(svg.bytes, originalSvg, 'Original SVG is unchanged');
assert.equal(preparedGraphics.files[1], memory[0], 'Native image/PDF bytes pass through');
await assert.rejects(prepareCompileGraphics(svgSource, [svg], async () => { throw new Error('bad SVG'); }), /中文 \(1\)\.svg: bad SVG/);
console.log('Compile project: nested binary assets, Unicode/spaces, unsaved buffers, memory uploads and PDF type passed.');

import assert from 'node:assert/strict';
import { inMath, quickInsert } from '../src/editorTools.js';
import { renderLatex } from '../src/engines/latex.js';

// A small document adapter exercises edits at real line/character boundaries.
function document(source, start = 0, end = start) {
  return {
    source, start, end,
    getValue() { return this.source; },
    indexFromPos({ line, ch }) { return this.source.split('\n').slice(0, line).reduce((n, s) => n + s.length + 1, 0) + ch; },
    posFromIndex(index) { const lines = this.source.slice(0, index).split('\n'); return { line: lines.length - 1, ch: lines.at(-1).length }; },
    getCursor(which) { return this.posFromIndex(which === 'to' ? this.end : this.start); },
    getSelection() { return this.source.slice(this.start, this.end); },
    getLine(line) { return this.source.split('\n')[line]; },
    setSelection(from, to) { this.start = this.indexFromPos(from); this.end = this.indexFromPos(to); },
    replaceRange(text, from, to = from) {
      const a = this.indexFromPos(from), b = this.indexFromPos(to);
      this.source = this.source.slice(0, a) + text + this.source.slice(b);
      const shift = text.length - (b - a);
      if (a <= this.start) { this.start += shift; this.end += shift; }
    },
    replaceSelection(text) { const from = this.posFromIndex(this.start), to = this.posFromIndex(this.end); this.replaceRange(text, from, to); },
    operation(fn) { fn(); }, focus() {}
  };
}

for (const source of ['$x', '$$x', '\\[x', '\\(x', '\\begin{align*}\nx &= y', '$x % $ ignored\ny']) assert.equal(inMath(source), true, source);
for (const source of ['text', '\\$5', '% $ ignored\ntext', '$x$ text', '$$x$$', '\\[x\\]', '\\begin{align}x\\end{align}']) assert.equal(inMath(source), false, source);

let doc = document('before one\ntwo after', 7, 14);
quickInsert(doc, 'tB');
assert.equal(doc.source, 'before \\textbf{one\ntwo} after');
assert.equal(doc.getSelection(), 'one\ntwo');
doc = document('keep this line', 5);
quickInsert(doc, 'tSec');
assert.equal(doc.source, 'keep \n\\section{text}\nthis line');
assert.equal(doc.getSelection(), 'text');
doc = document('');
quickInsert(doc, 'tFrac');
assert.equal(doc.source, '$\\frac{a}{b}$');
assert.equal(doc.getSelection(), 'a');
quickInsert(doc, 'tSymbol', '\\alpha');
assert.equal(doc.source, '$\\frac{\\alpha}{b}$');
doc = document('old', 0, 3);
quickInsert(doc, 'tRef', 'eq:new');
assert.equal(doc.source, '\\ref{eq:new}');
doc = document('first\nsecond\nthird', 0, 13);
quickInsert(doc, 'tComment');
assert.equal(doc.source, '% first\n% second\nthird');
doc = document('% first\n% second\nthird', 0, 17);
quickInsert(doc, 'tComment');
assert.equal(doc.source, 'first\nsecond\nthird');
doc = document('中文', 0, 2);
quickInsert(doc, 'tB', null, { markdown: true });
assert.equal(doc.source, '**中文**');
doc = document('');
quickInsert(doc, 'tGridTable', { rows: 2, cols: 3 });
assert.equal((doc.source.match(/\\\\/g) || []).length, 2);
assert.equal(renderLatex(doc.source).html.match(/<td/g).length, 6);
const linkSource = '\\documentclass{article}\n\\begin{document}\nlink\n\\end{document}';
doc = document(linkSource, linkSource.indexOf('link'), linkSource.indexOf('link') + 4);
quickInsert(doc, 'tLink', 'https://example.com?a=1&b=2#part');
assert.ok(doc.source.includes('\\usepackage{hyperref}\n\\begin{document}'));
assert.ok(doc.source.includes('https://example.com?a=1\\&b=2\\#part'));
assert.equal(doc.getSelection(), 'link');
assert.ok(doc.source.endsWith('}{link}\n\\end{document}'));
assert.ok(renderLatex('\\href{https://example.com?a=1\\&b=2\\#part}{link}').html.includes('href="https://example.com?a=1&amp;b=2#part"'));
console.log('Quick tools: math context, multiline selections, headings, symbols, references, comments, Markdown, tables and links passed.');

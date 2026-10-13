/* PaperLite · 文件类型识别：扩展名 → 编辑器模式 / 预览类型 / 图标 */

// kind: tex | md | code | text | image
const MAP = {
  tex: { kind: 'tex', mode: 'stex', icon: '§' }, sty: { kind: 'tex', mode: 'stex', icon: '§' },
  cls: { kind: 'tex', mode: 'stex', icon: '§' }, bib: { kind: 'tex', mode: 'stex', icon: '§' },
  md: { kind: 'md', mode: 'markdown', icon: '¶' }, markdown: { kind: 'md', mode: 'markdown', icon: '¶' },
  js: { kind: 'code', mode: 'javascript', icon: '{}' }, mjs: { kind: 'code', mode: 'javascript', icon: '{}' },
  jsx: { kind: 'code', mode: 'jsx', icon: '{}' },
  ts: { kind: 'code', mode: { name: 'javascript', typescript: true }, icon: '{}' },
  tsx: { kind: 'code', mode: 'jsx', icon: '{}' },
  json: { kind: 'code', mode: { name: 'javascript', json: true }, icon: '{}' },
  py: { kind: 'code', mode: 'python', icon: '{}' },
  c: { kind: 'code', mode: 'clike', icon: '{}' }, h: { kind: 'code', mode: 'clike', icon: '{}' },
  cpp: { kind: 'code', mode: 'clike', icon: '{}' }, cc: { kind: 'code', mode: 'clike', icon: '{}' },
  hpp: { kind: 'code', mode: 'clike', icon: '{}' }, java: { kind: 'code', mode: 'clike', icon: '{}' },
  cs: { kind: 'code', mode: 'clike', icon: '{}' }, go: { kind: 'code', mode: 'go', icon: '{}' },
  rs: { kind: 'code', mode: 'rust', icon: '{}' }, rb: { kind: 'code', mode: 'ruby', icon: '{}' },
  lua: { kind: 'code', mode: 'lua', icon: '{}' },
  sh: { kind: 'code', mode: 'shell', icon: '{}' }, bash: { kind: 'code', mode: 'shell', icon: '{}' },
  ps1: { kind: 'code', mode: 'shell', icon: '{}' },
  sql: { kind: 'code', mode: 'sql', icon: '{}' },
  yaml: { kind: 'code', mode: 'yaml', icon: '≡' }, yml: { kind: 'code', mode: 'yaml', icon: '≡' },
  toml: { kind: 'text', mode: null, icon: '≡' }, ini: { kind: 'text', mode: null, icon: '≡' },
  xml: { kind: 'code', mode: 'xml', icon: '{}' }, svg: { kind: 'code', mode: 'xml', icon: '▣' },
  html: { kind: 'code', mode: 'htmlmixed', icon: '{}' }, htm: { kind: 'code', mode: 'htmlmixed', icon: '{}' },
  vue: { kind: 'code', mode: 'htmlmixed', icon: '{}' },
  css: { kind: 'code', mode: 'css', icon: '{}' }, scss: { kind: 'code', mode: 'css', icon: '{}' }, less: { kind: 'code', mode: 'css', icon: '{}' },
  dockerfile: { kind: 'code', mode: 'dockerfile', icon: '{}' },
  png: { kind: 'image', mode: null, icon: '▣' }, jpg: { kind: 'image', mode: null, icon: '▣' },
  jpeg: { kind: 'image', mode: null, icon: '▣' }, gif: { kind: 'image', mode: null, icon: '▣' },
  webp: { kind: 'image', mode: null, icon: '▣' }, bmp: { kind: 'image', mode: null, icon: '▣' },
  txt: { kind: 'text', mode: null, icon: '≡' }, log: { kind: 'text', mode: null, icon: '≡' },
  csv: { kind: 'text', mode: null, icon: '≡' }
};

export function extOf(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'dockerfile' || n === 'makefile' || n === 'cmakelists.txt') return n === 'dockerfile' ? 'dockerfile' : 'text';
  const i = n.lastIndexOf('.');
  return i >= 0 ? n.slice(i + 1) : '';
}

export function infoFor(name) {
  const ext = extOf(name);
  return MAP[ext] || { kind: 'text', mode: null, icon: '≡' };
}

export function isTextEditable(name) {
  return infoFor(name).kind !== 'image';
}

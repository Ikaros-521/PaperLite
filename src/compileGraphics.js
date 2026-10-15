// XeTeX/dvipdfmx read PDF, PNG and JPEG natively. SVG is rasterized in the
// browser, retaining its project path so graphicspath, macros and subfiles work.
export async function svgToPng(bytes) {
  const xml = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'image/svg+xml');
  if (xml.querySelector('parsererror') || xml.documentElement.localName !== 'svg') {
    throw new Error('Invalid SVG document');
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const width = image.naturalWidth, height = image.naturalHeight;
    if (!width || !height) throw new Error('SVG has no image dimensions');
    const scale = Math.min(4096 / width, 4096 / height, Math.max(3, 1600 / width));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('SVG conversion produced no image');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function prepareCompileGraphics(source, files, convert = svgToPng) {
  const extensions = new Set();
  const prepared = [];
  for (const file of files) {
    const match = file.name.match(/\.svg$/i);
    if (!match) { prepared.push(file); continue; }
    try {
      prepared.push({ ...file, bytes: await convert(file.bytes) });
      extensions.add(match[0]);
    } catch (error) {
      throw new Error(file.name + ': ' + error.message);
    }
  }
  if (extensions.size) {
    const rules = [...extensions].map(ext => '\\DeclareGraphicsRule{' + ext + '}{bmp}{.xbb}{}').join('');
    const active = source.replace(/(?<!\\)%[^\r\n]*/g, comment => ' '.repeat(comment.length));
    const begin = active.search(/\\begin\s*\{document\}/);
    if (begin >= 0) source = source.slice(0, begin) + '\\ifdefined\\DeclareGraphicsRule' + rules
      + '\\fi ' + source.slice(begin);
  }
  return { source, files: prepared };
}

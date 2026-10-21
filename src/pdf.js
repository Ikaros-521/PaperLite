import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

let library;
export function pdfOptions(source) {
  return {
    ...source,
    cMapUrl: new URL('pdfjs/cmaps/', document.baseURI).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('pdfjs/standard_fonts/', document.baseURI).href,
    // Type 4 PostScript 函数默认会被编译成 new Function 来加速（isEvalSupported 默认 true），
    // 于是「打开一个 PDF」变成「执行文稿里带来的代码」。生产环境的 CSP 没有 unsafe-eval
    // 能挡住这条，但 dev 根本没装 CSP（vite.config.js 里 apply:'build'），关掉只损失这类
    // 函数的渲染速度，正常论文排版不受影响。
    isEvalSupported: false,
    // maxImageSize 默认 -1 = 不限总像素：一张 3 万像素见方的内嵌图就是一次几百 MB 的解码分配。
    // 40M 像素（约 6300×6300）留够了余量——600dpi 的 A4 扫描约 35M 像素仍在范围内，
    // 超出的畸形图只是不画，不是整个文档打不开。
    // canvasMaxAreaInBytes 保持默认 -1：那不是「不限」，是自适应估算，写死反而可能误伤。
    maxImageSize: 40 * 1024 * 1024,
  };
}
export function loadPdfLibrary() {
  return library ||= import('pdfjs-dist').then(lib => {
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
    return lib;
  });
}

import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

let library;
export function pdfOptions(source) {
  return {
    ...source,
    cMapUrl: new URL('pdfjs/cmaps/', document.baseURI).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('pdfjs/standard_fonts/', document.baseURI).href,
  };
}
export function loadPdfLibrary() {
  return library ||= import('pdfjs-dist').then(lib => {
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
    return lib;
  });
}

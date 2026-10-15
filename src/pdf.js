import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

let library;
export function loadPdfLibrary() {
  return library ||= import('pdfjs-dist').then(lib => {
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
    return lib;
  });
}

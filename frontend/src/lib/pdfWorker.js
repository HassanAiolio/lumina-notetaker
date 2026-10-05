// Where pdf.js's worker is served from. Kept in its own module, loaded only
// when a PDF is opened: import.meta is fine for the bundler but not for the
// test runner, which never opens a PDF.
export const workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString();

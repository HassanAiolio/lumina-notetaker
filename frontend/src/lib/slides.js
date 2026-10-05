/**
 * Lecture slides (PDF), read in the browser.
 *
 * The file never leaves the device: its text goes along with the transcript
 * when notes are made, and later only pictures of the pages the notes cite are
 * uploaded. A 30 MB deck through the backend would cost metered bandwidth for
 * text that is a few kilobytes once extracted.
 *
 * pdf.js is loaded on first use; most sessions never need it.
 */

export const MAX_PAGES = 400;
const PAGE_TEXT_CHARS = 1500;
const RENDER_WIDTH = 1100;

let pdfjsLoading = null;
const loadPdfjs = () => {
  if (!pdfjsLoading) {
    pdfjsLoading = Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('./pdfWorker')])
      .then(([lib, { workerSrc }]) => {
        lib.GlobalWorkerOptions.workerSrc = workerSrc;
        return lib;
      })
      .catch((err) => {
        pdfjsLoading = null;
        throw err;
      });
  }
  return pdfjsLoading;
};

/** A short fingerprint of the file, so a stored page is never another deck's. */
async function fingerprint(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Page text as one line: pdf.js hands it over in positioned fragments. */
const pageText = (content) =>
  content.items
    .map((item) => `${item.str || ''}${item.hasEOL ? '\n' : ' '}`)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PAGE_TEXT_CHARS);

/**
 * Open a PDF and read its text, page by page.
 *
 * Returns { name, pageCount, hash, pages: [{page, text}], render(page) }, where
 * render resolves to a JPEG Blob of that page.
 */
export async function openDeck(file, { onProgress } = {}) {
  if (!file || !/pdf$/i.test(file.type || file.name || '')) {
    throw new Error('Slides need to be a PDF. Export them from PowerPoint or Keynote as PDF first.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await fingerprint(bytes);
  const pdfjs = await loadPdfjs();
  // isEvalSupported off: a PDF is untrusted input, and pdf.js otherwise
  // compiles font programs with eval.
  const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;

  const count = Math.min(doc.numPages, MAX_PAGES);
  const pages = [];
  for (let number = 1; number <= count; number += 1) {
    // eslint-disable-next-line no-await-in-loop
    const page = await doc.getPage(number);
    // eslint-disable-next-line no-await-in-loop
    pages.push({ page: number, text: pageText(await page.getTextContent()) });
    page.cleanup();
    onProgress?.(number, count);
  }

  const render = async (number, width = RENDER_WIDTH) => {
    const page = await doc.getPage(number);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext('2d');
    // Slides are designed on white; a transparent page would show the app's
    // near-black through it.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    page.cleanup();
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not draw that page'))), 'image/jpeg', 0.74);
    });
  };

  return {
    name: file.name,
    pageCount: doc.numPages,
    hash,
    pages,
    render,
    // Pages with no text at all are pictures or titles; the summary cannot use them.
    readable: pages.filter((p) => p.text.length > 20).length,
    close: () => doc.destroy(),
  };
}

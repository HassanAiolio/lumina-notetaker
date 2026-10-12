/** Downloading notes for an Obsidian vault: one note, or the whole library. */
import { getNotes, getSlidePage } from '../services/api';
import { downloadBlob } from './notes';
import { isoDay, noteBaseName, slideFileName, toObsidian, uniqueName } from './obsidian';
import { zipBlob } from './zip';

const LIBRARY_PAGE = 100; // the API's largest page

/**
 * The slide pages a note cites, as {page, file, bytes}. A page that cannot be
 * fetched is left out, and the note's citation of it stays plain text.
 */
const slideAttachments = async (note, baseName) => {
  const pages = note.id ? note.slides?.cited || [] : [];
  const found = [];
  for (const page of pages) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const url = await getSlidePage(note.id, page, note.slides?.hash);
      // eslint-disable-next-line no-await-in-loop
      const blob = await (await fetch(url)).blob();
      // eslint-disable-next-line no-await-in-loop
      found.push({ page, file: slideFileName(baseName, page), bytes: new Uint8Array(await blob.arrayBuffer()) });
    } catch (err) {
      /* not kept with the note, or offline: the note goes without it */
    }
  }
  return found;
};

/** One note's Markdown and attachments, as paths inside a zip. */
const noteFiles = async (note, baseName, folder = '') => {
  const attachments = await slideAttachments(note, baseName);
  const slides = new Map(attachments.map(({ page, file }) => [page, file]));
  return [
    { path: `${folder}${baseName}.md`, data: toObsidian(note, { slides }) },
    ...attachments.map(({ file, bytes }) => ({ path: `${folder}attachments/${file}`, data: bytes })),
  ];
};

/**
 * One note: a .md file, or a .zip with its slide pages when it cites any.
 * Unzipped into a vault, the pages land in attachments/ and show in the note.
 */
export const exportNote = async (note) => {
  const baseName = noteBaseName(note);
  const files = await noteFiles(note, baseName);
  if (files.length === 1) {
    downloadBlob(new Blob([files[0].data], { type: 'text/markdown;charset=utf-8' }), `${baseName}.md`);
  } else {
    downloadBlob(zipBlob(files), `${baseName}.zip`);
  }
};

/**
 * Every note matching the filters, in one zip with a "Lumina Notes" folder to
 * drop into a vault. `onProgress(done, total)` reports as notes are packed.
 */
export const exportLibrary = async ({ search, tag, type } = {}, onProgress) => {
  const notes = [];
  let total = Infinity;
  while (notes.length < total) {
    // eslint-disable-next-line no-await-in-loop
    const page = await getNotes({ search, tag, type, limit: LIBRARY_PAGE, offset: notes.length });
    total = page.total;
    notes.push(...page.items);
    if (!page.items.length) break;
  }
  if (!notes.length) return 0;

  const folder = 'Lumina Notes/';
  const taken = new Set();
  const files = [];
  onProgress?.(0, notes.length);
  for (const [index, note] of notes.entries()) {
    const baseName = uniqueName(noteBaseName(note), taken);
    // eslint-disable-next-line no-await-in-loop
    files.push(...(await noteFiles(note, baseName, folder)));
    onProgress?.(index + 1, notes.length);
  }
  downloadBlob(zipBlob(files), `Lumina Notes ${isoDay(new Date())}.zip`);
  return notes.length;
};

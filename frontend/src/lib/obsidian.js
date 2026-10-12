/**
 * Notes as Obsidian wants them: properties up top, real #tags, the slide pages
 * a note cites embedded as attachments, the transcript folded away in a
 * callout, and the revision deck as cards for the Spaced Repetition plugin.
 *
 * It stays plain Markdown with YAML front matter, so other editors read it too.
 */
import { buildDeck, isDisplayMath, sectionEntries, sectionLabel } from './notes';

// Obsidian refuses these in file names, and # ^ [ ] | break links to them.
const UNSAFE_NAME = /[\\/:*?"<>|#^[\]]/g;

/** A title as a file name Obsidian, Windows and macOS all accept. */
export const safeFileName = (text) =>
  String(text || '')
    .replace(UNSAFE_NAME, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();

const pad = (number) => String(number).padStart(2, '0');

/** The day a note was made, as YYYY-MM-DD in local time. */
export const isoDay = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** "2026-10-12 Thermodynamics L4": sorts by date in the vault's file list. */
export const noteBaseName = (note, now = new Date()) =>
  [isoDay(note?.created_at || now), safeFileName(note?.title) || 'Untitled note'].filter(Boolean).join(' ');

/** "Name", then "Name (2)", ... for the names already in `taken`. */
export const uniqueName = (name, taken) => {
  let candidate = name;
  for (let index = 2; taken.has(candidate.toLowerCase()); index += 1) candidate = `${name} (${index})`;
  taken.add(candidate.toLowerCase());
  return candidate;
};

export const slideFileName = (baseName, page) => `${baseName} p${page}.jpg`;

/**
 * A tag Obsidian will treat as one: letters, digits, _ - and / only, and not
 * all digits.
 */
export const obsidianTag = (tag) => {
  const cleaned = String(tag || '')
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_/-]/gu, '');
  return /^\d+$/.test(cleaned) ? `_${cleaned}` : cleaned;
};

// JSON strings are valid YAML double-quoted strings, escapes included.
// U+2028 and U+2029 are line breaks to YAML, though not to JSON.
const yamlString = (value) => JSON.stringify(String(value).replace(/\p{Zl}|\p{Zp}/gu, ' '));

const frontMatter = (fields) => {
  const lines = ['---'];
  Object.entries(fields).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      if (!value.length) return;
      lines.push(`${key}:`, ...value.map((item) => `  - ${yamlString(item)}`));
    } else if (value !== '' && value !== null && value !== undefined) {
      lines.push(`${key}: ${typeof value === 'string' ? yamlString(value) : value}`);
    }
  });
  lines.push('---');
  return lines.join('\n');
};

const CITATIONS = /\[p\. (\d{1,4})(?:–(\d{1,4}))?\]/g;

/** "[p. 12]" becomes a link to that page's picture further down, when there is one. */
const linkCitations = (text, pages) =>
  text.replace(CITATIONS, (match, first, last) => {
    const page = Number(first);
    if (!pages.has(page)) return match;
    const label = last ? `p. ${first}–${last}` : `p. ${first}`;
    return `[[#p. ${page}|${label}]]`;
  });

const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim();

/**
 * The note as an Obsidian Markdown file.
 *
 * `slides` maps a page number to its attachment's file name, for the slide
 * pages that are going into the vault alongside the note.
 */
export const toObsidian = (note, { slides = new Map(), now = new Date() } = {}) => {
  const cards = buildDeck(note);
  const tags = [...new Set((note.tags || []).map(obsidianTag).filter(Boolean))];
  if (cards.length) tags.push('flashcards');

  const head = frontMatter({
    aliases: note.title ? [note.title] : [],
    date: isoDay(note.created_at || now),
    type: (note.type || '').toLowerCase(),
    language: note.language && note.language !== 'auto' ? note.language : '',
    tags,
    slides: note.slides?.name || '',
    source: 'Lumina Note',
    lumina_id: note.id || '',
  });

  const pages = new Set(slides.keys());
  const blocks = sectionEntries(note).map(([key, items]) => {
    const lines = items.map((item) => {
      const text = linkCitations(String(item), pages);
      // A displayed equation is a block of its own, not a bullet.
      return isDisplayMath(text) ? `\n$$\n${text.trim().slice(2, -2).trim()}\n$$\n` : `- ${text}`;
    });
    return `## ${sectionLabel(key, note.labels)}\n\n${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}`;
  });

  if (cards.length) {
    blocks.push(
      `## Flashcards\n\n${cards
        .map((card) => linkCitations(`${oneLine(card.front)}::${oneLine(card.back)}`, pages))
        .join('\n')}`,
    );
  }

  if (slides.size) {
    const shown = [...slides.entries()]
      .sort(([a], [b]) => a - b)
      .map(([page, file]) => `### p. ${page}\n\n![[${file}]]`);
    blocks.push(`## Slides\n\n${shown.join('\n\n')}`);
  }

  const transcript = (note.raw_transcript || '').trim();
  if (transcript) {
    const quoted = transcript
      .split('\n')
      .map((line) => (line.trim() ? `> ${line}` : '>'))
      .join('\n');
    blocks.push(`> [!quote]- Transcript\n${quoted}`);
  }

  return `${[head, ...blocks].join('\n\n')}\n`;
};

// Port of backend/loops.py and the reply parsing in backend/transcription.py.
// Kept behaviour-identical: the same inputs are tested against the same
// outputs in test/text.test.js, so the two paths cannot drift apart silently.

// Longest phrase, in words, checked for back-to-back repeats.
const MAX_PHRASE_WORDS = 8;
// A run this long is the model stuck, not a speaker ("euh euh euh" is real).
const MIN_RUN = 4;
// Copies kept of a collapsed run, so the text still reads as spoken.
const KEEP = 2;

const NOT_WORD = /[^\p{L}\p{N}_']+/gu;

/**
 * Cut every phrase repeated MIN_RUN+ times in a row down to KEEP copies.
 * Returns [text, wordsRemoved]; text with no loop comes back unchanged.
 */
export function collapseRepeats(text) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < MIN_RUN) return [text, 0];

  const keys = words.map((w) => w.toLowerCase().replace(NOT_WORD, ''));
  const same = (i, j, size) => {
    for (let k = 0; k < size; k += 1) if (keys[i + k] !== keys[j + k]) return false;
    return true;
  };

  const kept = [];
  let removed = 0;
  let i = 0;
  while (i < words.length) {
    let skipped = 0;
    for (let size = 1; size <= MAX_PHRASE_WORDS; size += 1) {
      if (i + size * MIN_RUN > words.length) break;
      let meaningful = false;
      for (let k = 0; k < size; k += 1) if (keys[i + k]) meaningful = true;
      if (!meaningful) continue; // punctuation on its own is not a phrase
      let runs = 1;
      while (i + (runs + 1) * size <= words.length && same(i, i + runs * size, size)) runs += 1;
      if (runs >= MIN_RUN) {
        kept.push(...words.slice(i, i + size * KEEP));
        skipped = runs * size;
        removed += (runs - KEEP) * size;
        break;
      }
    }
    if (skipped) {
      i += skipped;
    } else {
      kept.push(words[i]);
      i += 1;
    }
  }
  return removed ? [kept.join(' '), removed] : [text, 0];
}

/** Did a reply spend a real part of itself repeating one phrase? */
export function isLooping(text, removed) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return removed >= 30 || (removed >= 10 && removed * 5 >= words + removed);
}

// Things models say instead of admitting the clip is silent.
const NO_SPEECH = new RegExp(
  String.raw`^\s*[\[("']?\s*(no\s+(?:speech|audio|sound|discernible\s+speech)` +
    String.raw`|silence|inaudible|unintelligible|empty\s+audio|aucun\s+(?:son|discours|audio)` +
    String.raw`|pas\s+de\s+(?:parole|son))\b[\s\S]{0,40}$`,
  'i',
);
export const isNoSpeech = (text) => NO_SPEECH.test(text);

const REPLY_HEAD = /^\s*\[?\s*\{\s*"text"\s*:\s*"/;
const REPLY_TAIL = /"\s*(?:,\s*"language"\s*:\s*"[^"]*"\s*)?\}\s*\]?\s*$/;
const REPLY_LANGUAGE = /"language"\s*:\s*"([^"]+)"/;

/** The transcript out of a JSON-shaped reply that will not parse. */
export function salvageText(raw) {
  const head = raw.match(REPLY_HEAD);
  if (!head) return raw;
  return raw
    .slice(head[0].length)
    .replace(REPLY_TAIL, '')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, ' ')
    .replace(/\\\\/g, '\\');
}

const tryParse = (text) => {
  try {
    return JSON.parse(text);
  } catch (err) {
    return undefined;
  }
};

/** [text, language|null] from a transcription reply, in any shape it arrives. */
export function readReply(raw) {
  const unfenced = raw.trim().replace(/^```[a-zA-Z]*\s*|\s*```$/g, '').trim();
  let parsed = tryParse(unfenced);
  if (parsed === undefined) {
    parsed = tryParse(unfenced.replace(/,(\s*[}\]])/g, '$1'));
  }
  if (parsed === undefined) {
    // Prose around the object: slice out the outermost {...} and try that.
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start !== -1 && end > start) {
      parsed = tryParse(unfenced.slice(start, end + 1).replace(/,(\s*[}\]])/g, '$1'));
    }
  }

  if (typeof parsed === 'string') return [parsed, null];

  if (Array.isArray(parsed)) {
    // JSON mode sometimes answers with a list of segments; keep all of them.
    const items = parsed.filter((item) => item && typeof item === 'object');
    const text = items
      .filter((item) => typeof item.text === 'string')
      .map((item) => item.text.trim())
      .join(' ');
    const language = items.find((item) => item.language)?.language || null;
    return [text, language];
  }

  if (parsed && typeof parsed === 'object') {
    return [typeof parsed.text === 'string' ? parsed.text : '', parsed.language || null];
  }

  const found = raw.match(REPLY_LANGUAGE);
  return [salvageText(raw), found ? found[1] : null];
}

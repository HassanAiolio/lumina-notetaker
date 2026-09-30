// Port of backend/languages.py: the codes the app speaks, and a cheap detector
// for when a model does not say which language it heard.

export const AUTO = 'auto';

// BCP-47 code -> [English name, native name]
export const LANGUAGES = {
  en: ['English', 'English'],
  fr: ['French', 'Français'],
  es: ['Spanish', 'Español'],
  de: ['German', 'Deutsch'],
  it: ['Italian', 'Italiano'],
  pt: ['Portuguese', 'Português'],
  nl: ['Dutch', 'Nederlands'],
  ar: ['Arabic', 'العربية'],
  zh: ['Chinese', '中文'],
  ja: ['Japanese', '日本語'],
  ko: ['Korean', '한국어'],
  ru: ['Russian', 'Русский'],
  hi: ['Hindi', 'हिन्दी'],
  tr: ['Turkish', 'Türkçe'],
  pl: ['Polish', 'Polski'],
  sv: ['Swedish', 'Svenska'],
};

// Both spellings of every language, so "french" from Whisper lands on "fr".
const BY_NAME = Object.fromEntries(
  Object.entries(LANGUAGES).flatMap(([code, names]) => names.map((n) => [n.toLowerCase(), code])),
);

export function normalize(code) {
  if (!code) return AUTO;
  const clean = String(code).trim().toLowerCase().replace(/_/g, '-');
  if (clean === AUTO || clean === '') return AUTO;
  const base = clean.split('-')[0];
  if (LANGUAGES[base]) return base;
  return BY_NAME[clean] || AUTO;
}

export function englishName(code) {
  const entry = LANGUAGES[normalize(code)];
  return entry ? entry[0] : 'the same language as the transcript';
}

const MARKERS = {
  fr: 'le la les des une est que qui pour pas nous vous avec dans sur mais plus être faire donc cette',
  en: 'the and is are that this with for you have was will not they from what about would there',
  es: 'el la los las una que para con por pero como está son muy hay este todo porque',
  de: 'der die das und ist nicht mit auch für von sich ein eine aber wir wenn dass haben',
  it: 'il la che di per con non una sono come questo anche più essere della nella',
  pt: 'o a os as que para com não uma por mais como está muito isso também',
  nl: 'de het een en van is dat niet voor met ook maar worden zijn',
};
const MARKER_SETS = Object.fromEntries(
  Object.entries(MARKERS).map(([code, words]) => [code, new Set(words.split(' '))]),
);

// Kana before Han: Japanese mixes kanji with kana.
const SCRIPTS = [
  ['ja', /[぀-ヿ]/g],
  ['zh', /[一-鿿]/g],
  ['ko', /[가-힯]/g],
  ['ar', /[؀-ۿ]/g],
  ['ru', /[Ѐ-ӿ]/g],
  ['hi', /[ऀ-ॿ]/g],
];

/** Rough language guess from script and stop words. 'auto' when unsure. */
export function detect(text) {
  if (!text || !text.trim()) return AUTO;
  const sample = text.slice(0, 4000);

  for (const [code, pattern] of SCRIPTS) {
    if ((sample.match(pattern) || []).length >= 4) return code;
  }

  const words = (sample.match(/\p{L}+/gu) || []).map((w) => w.toLowerCase());
  if (words.length < 8) return AUTO;

  const scores = Object.entries(MARKER_SETS).map(([code, set]) => [
    code,
    words.filter((w) => set.has(w)).length,
  ]);
  scores.sort((a, b) => b[1] - a[1]);
  const [[best, top], [, runnerUp]] = scores;
  return top >= 3 && top > runnerUp ? best : AUTO;
}

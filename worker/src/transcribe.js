// One audio chunk in, one transcript out, across every free quota available.
//
// Port of backend/transcription.py, reorganised around the thing that actually
// breaks in practice: quotas. The free Gemini 3.5 Flash allows 20 requests a
// day and a two hour lecture is thirty chunks, so the chain is walked in order
// - Gemini models while they have quota, then Groq Whisper (hours of audio a
// day) - and a model that has run out is remembered and skipped for later
// chunks instead of being asked, and refusing, thirty times.

import { AUTO, detect, englishName, normalize } from './languages.js';
import { geminiDelete, geminiTranscribe, geminiUpload, groqTranscribe, ProviderError } from './providers.js';
import { collapseRepeats, isLooping, isNoSpeech, readReply } from './text.js';

// Browser container types onto the ones Gemini documents (see transcription.py).
export const MIME_ALIASES = {
  'audio/mpeg': 'audio/mp3',
  'audio/mp3': 'audio/mp3',
  'audio/wav': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/aac': 'audio/aac',
  'audio/flac': 'audio/flac',
  'audio/x-flac': 'audio/flac',
  'audio/ogg': 'audio/ogg',
  'audio/opus': 'audio/ogg',
  'audio/aiff': 'audio/aiff',
  'audio/x-aiff': 'audio/aiff',
  'audio/webm': 'audio/ogg',
  'audio/mp4': 'audio/aac',
  'audio/x-m4a': 'audio/aac',
};

export const csv = (value, fallback) =>
  (value || fallback)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

// Models that refused for quota, and until when. Lives as long as the Worker
// isolate does - minutes to hours - which is exactly the span of one lecture.
// Losing it only costs one wasted request.
const exhausted = new Map();
export const resetExhausted = () => exhausted.clear();

const HOUR = 3600_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class TranscriptionFailed extends Error {
  constructor(errors) {
    const quota = errors.length > 0 && errors.every((e) => e.quota);
    super(
      quota
        ? 'Every transcription service is out of free quota for now. Please try again later.'
        : 'Transcription failed on every service. Your recording was not lost - please try again.',
    );
    this.quota = quota;
    this.errors = errors;
  }
}

export function buildPrompt(language, context) {
  const languageClause =
    language === AUTO
      ? 'Detect the spoken language yourself and transcribe in that language, ' +
        'using its own script. Do not translate.'
      : `The audio is expected to be in ${englishName(language)}. ` +
        'Transcribe in that language, using its own script. Do not translate. ' +
        'If the speaker is clearly using another language, transcribe what you ' +
        'actually hear and report that language instead.';

  const contextClause = context
    ? '\n\nThis clip continues an earlier one. Use the tail of the previous ' +
      'transcript only to keep spelling and names consistent - do not repeat ' +
      `any of it in your output:\n"""\n${context.slice(-1200)}\n"""`
    : '';

  return `Transcribe this audio recording verbatim.

${languageClause}

Rules:
- Write what is said, with sentence punctuation and capitalisation.
- Keep names, numbers, dates and amounts exactly as spoken.
- Do not summarise, translate, comment or add speaker labels.
- Mark genuinely unclear words as [inaudible].
- If there is no intelligible speech at all, return an empty string for "text".
${contextClause}

Reply with JSON only:
{"text": "the transcription", "language": "BCP-47 code, e.g. fr"}`;
}

/** Clean a model's text and settle on a language. */
function finish(text, reportedLanguage, engine) {
  let clean = text.trim();
  if (isNoSpeech(clean)) clean = '';
  let language = normalize(reportedLanguage);
  if (language === AUTO && clean) language = detect(clean);
  return { text: clean, language, engine };
}

/**
 * Run `attempt(model)` for each model until one succeeds.
 *
 * A transient failure gets one more try on the same model; a short quota wait
 * is sat out if it is brief and the deadline allows; a daily quota marks the
 * model exhausted so later chunks go straight past it.
 */
async function walk(models, attempt, { deadline, errors, log }) {
  for (const model of models) {
    const until = exhausted.get(model);
    if (until && until > Date.now()) {
      // Recorded so a chain that was skipped entirely still reads as "quota".
      errors.push(new ProviderError(`${model} skipped: out of quota`, { kind: 'quota-day' }));
      continue;
    }

    for (let tries = 0; tries < 2; tries += 1) {
      const remaining = deadline - Date.now();
      if (remaining < 15_000) return null; // not worth starting a request we would abandon
      try {
        // eslint-disable-next-line no-await-in-loop
        return await attempt(model, Math.min(remaining - 5_000, 100_000));
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        errors.push(err);
        log(`${model}: ${err.kind} - ${err.message.slice(0, 200)}`);

        if (err.kind === 'quota-day') {
          exhausted.set(model, Date.now() + HOUR);
          break;
        }
        if (err.kind === 'quota-short') {
          const wait = err.retryAfterMs ?? 20_000;
          if (tries === 0 && wait <= 12_000 && deadline - Date.now() > wait + 20_000) {
            // eslint-disable-next-line no-await-in-loop
            await sleep(wait + 250);
            continue;
          }
          exhausted.set(model, Date.now() + Math.max(wait, 30_000));
          break;
        }
        if (err.kind === 'fatal') break;
        // transient: loop round for the second try, after a short pause
        // eslint-disable-next-line no-await-in-loop
        await sleep(1_000 + Math.random() * 500);
      }
    }
  }
  return null;
}

/**
 * Transcribe one chunk. Returns {text, language, engine}; throws
 * TranscriptionFailed when every model in the chain has refused.
 *
 * `waitUntil` lets the tidy-up (deleting the uploaded file) run after the
 * response has gone out.
 */
export async function transcribeChunk({
  audio,
  mimeType,
  language = AUTO,
  context = '',
  env,
  deadline = Date.now() + 150_000,
  waitUntil = () => {},
  log = () => {},
}) {
  const lang = normalize(language);
  const errors = [];
  const shared = { deadline, errors, log };

  // Gemini first: its punctuation and casing read better than Whisper's.
  if (env.GEMINI_API_KEY) {
    const models = csv(env.GEMINI_AUDIO_MODELS, 'gemini-3.5-flash,gemini-2.5-flash,gemini-3.1-flash-lite');
    let file = null;
    // No upload when every Gemini model is known to be out of quota.
    if (models.some((model) => !(exhausted.get(model) > Date.now()))) {
      try {
        file = await geminiUpload(env.GEMINI_API_KEY, audio, mimeType, 60_000);
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        errors.push(err);
        log(`gemini upload: ${err.kind} - ${err.message.slice(0, 200)}`);
      }
    }
    if (!file) {
      for (const model of models) {
        if (exhausted.get(model) > Date.now()) {
          errors.push(new ProviderError(`${model} skipped: out of quota`, { kind: 'quota-day' }));
        }
      }
    } else {
      try {
        const prompt = buildPrompt(lang, context);
        const result = await walk(
          models,
          async (model, timeoutMs) => {
            // Two ways a reply loses words: it loops, or it runs out of output
            // tokens and stops mid-transcript. Neither is reproducible - asked
            // again, the model usually transcribes the same audio cleanly - so
            // either gets one more request, and the better reply is kept:
            // complete over cut off, then less repetitive. Loops are collapsed
            // whichever wins, so one never reaches the notes.
            let best = null;
            for (let round = 0; round < 2; round += 1) {
              // eslint-disable-next-line no-await-in-loop
              const { raw, finish: stop } = await geminiTranscribe(
                env.GEMINI_API_KEY,
                model,
                prompt,
                file,
                timeoutMs,
              );
              const [text, reported] = readReply(raw);
              const [clean, removed] = collapseRepeats(text.trim());
              const truncated = stop === 'MAX_TOKENS';
              const candidate = { clean, removed, reported, truncated };
              if (
                !best ||
                (best.truncated && !truncated) ||
                (best.truncated === truncated && removed < best.removed)
              ) {
                best = candidate;
              }
              const looping = isLooping(clean, removed);
              if ((!looping && !truncated) || deadline - Date.now() < 30_000) break;
              log(
                `${model}: ${truncated ? 'cut off at the token limit' : 'looped'} ` +
                  `(${removed} repeated words cut), asking again`,
              );
            }
            if (best.truncated) log(`${model}: kept a reply that was cut off at the token limit`);
            return finish(best.clean, best.reported, model);
          },
          shared,
        );
        if (result) return result;
      } finally {
        waitUntil(geminiDelete(env.GEMINI_API_KEY, file.name));
      }
    }
  }

  // Then Whisper: plainer text, but hours of free audio a day.
  if (env.GROQ_API_KEY) {
    const models = csv(env.GROQ_AUDIO_MODELS, 'whisper-large-v3,whisper-large-v3-turbo');
    const result = await walk(
      models,
      async (model, timeoutMs) => {
        const reply = await groqTranscribe(
          env.GROQ_API_KEY,
          model,
          audio,
          mimeType,
          { language: lang === AUTO ? null : lang, prompt: context },
          timeoutMs,
        );
        // Whisper loops too, on a quiet stretch at temperature 0.
        const [clean, removed] = collapseRepeats(reply.text);
        if (removed) log(`${model}: looped (${removed} repeated words cut)`);
        return finish(clean, reply.language, model);
      },
      shared,
    );
    if (result) return result;
  }

  throw new TranscriptionFailed(errors);
}

// Gemini and Groq, as thin calls that either return a result or throw a
// ProviderError saying what kind of failure it was. Deciding what to do about
// a failure - wait, move on, give up - is transcribe.js's job.

const GEMINI_ROOT = 'https://generativelanguage.googleapis.com';
const GROQ_ROOT = 'https://api.groq.com/openai/v1';

export class ProviderError extends Error {
  /**
   * @param kind  'quota-day'   refused until the daily quota resets
   *              'quota-short' refused for now; `retryAfterMs` says how long
   *              'transient'   overloaded, timed out, 5xx: worth one more try
   *              'fatal'       bad request, unknown model: this model is out
   */
  constructor(message, { kind = 'fatal', status = null, retryAfterMs = null } = {}) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }

  get quota() {
    return this.kind === 'quota-day' || this.kind === 'quota-short';
  }
}

const seconds = (text) => {
  const found = /([0-9.]+)\s*s/.exec(text || '');
  return found ? Math.ceil(parseFloat(found[1]) * 1000) : null;
};

/** Turn a failed HTTP response into a ProviderError of the right kind. */
async function failure(response, what) {
  const body = await response.text().catch(() => '');
  const snippet = body.slice(0, 300);
  const { status } = response;
  const message = `${what} returned HTTP ${status}: ${snippet}`;

  if (status === 429 || /rate.?limit|quota|resource_exhausted/i.test(body)) {
    // Gemini names the quota ("...PerDay..."), Groq names the window ("per
    // day (RPD)", "audio seconds per day (ASD)"). A daily one will not clear
    // by waiting, so the model is skipped until it does.
    const daily = /PerDay|per day|\(RPD\)|\(ASD\)/i.test(body);
    const retryAfterMs =
      seconds(response.headers.get('retry-after') ? `${response.headers.get('retry-after')}s` : '') ??
      seconds(/"retryDelay"\s*:\s*"([0-9.]+s)"/.exec(body)?.[1]) ??
      seconds(/try again in ([0-9.]+s)/i.exec(body)?.[1]);
    return new ProviderError(message, {
      kind: daily ? 'quota-day' : 'quota-short',
      status,
      retryAfterMs,
    });
  }
  if (status === 408 || status === 409 || status >= 500) {
    return new ProviderError(message, { kind: 'transient', status });
  }
  return new ProviderError(message, { kind: 'fatal', status });
}

async function send(url, init, timeoutMs, what) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new ProviderError(`${what} ${timedOut ? 'timed out' : `network error: ${err?.message}`}`, {
      kind: 'transient',
    });
  }
}

// ── Gemini ───────────────────────────────────────────────────────────────────

/**
 * Put the audio in Gemini's file store and return {name, uri, mimeType}.
 *
 * Sending it inline would mean base64-encoding a few MB in JavaScript on every
 * attempt, which is more CPU than a free Worker gets. Uploaded once, the same
 * file serves every model and every retry.
 */
export async function geminiUpload(apiKey, audio, mimeType, timeoutMs) {
  const start = await send(
    `${GEMINI_ROOT}/upload/v1beta/files`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(audio.byteLength),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: 'lumina-chunk' } }),
    },
    timeoutMs,
    'Gemini upload',
  );
  if (!start.ok) throw await failure(start, 'Gemini upload');
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new ProviderError('Gemini upload gave no upload URL', { kind: 'transient' });

  const done = await send(
    uploadUrl,
    {
      method: 'POST',
      headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
      body: audio,
    },
    timeoutMs,
    'Gemini upload',
  );
  if (!done.ok) throw await failure(done, 'Gemini upload');
  let { file } = await done.json();

  // Audio is usually usable at once; wait briefly if it is still processing.
  for (let poll = 0; file?.state === 'PROCESSING' && poll < 10; poll += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // eslint-disable-next-line no-await-in-loop
    const check = await send(
      `${GEMINI_ROOT}/v1beta/${file.name}`,
      { headers: { 'x-goog-api-key': apiKey } },
      timeoutMs,
      'Gemini file status',
    );
    if (check.ok) file = await check.json();
  }
  if (!file?.uri || file.state === 'FAILED') {
    throw new ProviderError('Gemini could not process the uploaded audio', { kind: 'transient' });
  }
  return { name: file.name, uri: file.uri, mimeType: file.mimeType || mimeType };
}

/** Files expire on their own after two days; deleting is just tidiness. */
export async function geminiDelete(apiKey, name) {
  try {
    await fetch(`${GEMINI_ROOT}/v1beta/${name}`, {
      method: 'DELETE',
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    /* it expires anyway */
  }
}

// The defaults block a lot of ordinary lecture talk; keep only the highest.
const SAFETY = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }));

/**
 * How much the model may think before transcribing.
 *
 * Thinking tokens count against maxOutputTokens, and on one four minute chunk
 * Gemini 2.5 Flash spent anywhere from 1,400 to 5,300 of them - so a run that
 * thought a little longer ran out of room and returned a transcript cut off
 * part-way. Verbatim transcription needs no reasoning, so it is kept minimal.
 */
export function thinkingFor(model) {
  if (/^gemini-2\.5/.test(model)) return { thinkingBudget: 0 };
  if (/^gemini-3/.test(model)) return { thinkingLevel: 'low' };
  return null;
}

/**
 * One transcription request to one Gemini model.
 * Returns {raw, finish}: the reply text and why the model stopped.
 */
export async function geminiTranscribe(apiKey, model, prompt, file, timeoutMs) {
  const request = (thinking) =>
    send(
      `${GEMINI_ROOT}/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }, { file_data: { mime_type: file.mimeType, file_uri: file.uri } }],
            },
          ],
          generationConfig: {
            // Temperature stays at the model's default: Gemini 3 is documented
            // to loop below 1.0, which is where "des des des ..." came from.
            // Four minutes of speech is one to two thousand tokens.
            maxOutputTokens: 8192,
            responseMimeType: 'application/json',
            ...(thinking ? { thinkingConfig: thinking } : {}),
          },
          safetySettings: SAFETY,
        }),
      },
      timeoutMs,
      `Gemini ${model}`,
    );

  const thinking = thinkingFor(model);
  let response = await request(thinking);
  if (thinking && response.status === 400) {
    // A model that does not take this thinking setting says so with a 400;
    // asking again without it beats losing the model.
    const body = await response.clone().text();
    if (/thinking/i.test(body)) response = await request(null);
  }
  if (!response.ok) throw await failure(response, `Gemini ${model}`);

  const data = await response.json();
  const candidate = data.candidates?.[0];
  if (!candidate) {
    const reason = data.promptFeedback?.blockReason;
    throw new ProviderError(`Gemini ${model} returned no candidates (block=${reason})`, {
      kind: 'transient',
    });
  }
  // Thought summaries are not transcript; only the answer parts are kept.
  const text = (candidate.content?.parts || [])
    .filter((part) => !part.thought)
    .map((part) => part.text || '')
    .join('')
    .trim();
  if (!text) {
    throw new ProviderError(`Gemini ${model} returned nothing (finish=${candidate.finishReason})`, {
      kind: 'transient',
    });
  }
  return { raw: text, finish: candidate.finishReason || null };
}

// ── Groq Whisper ─────────────────────────────────────────────────────────────

const EXTENSIONS = {
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/aac': 'm4a',
  'audio/aiff': 'aiff',
};

/** Whisper on Groq: {text, language}. `prompt` is a vocabulary hint, not an instruction. */
export async function groqTranscribe(apiKey, model, audio, mimeType, { language, prompt }, timeoutMs) {
  const form = new FormData();
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', prompt.slice(-400));
  form.append('file', new Blob([audio], { type: mimeType }), `chunk.${EXTENSIONS[mimeType] || 'mp3'}`);

  const response = await send(
    `${GROQ_ROOT}/audio/transcriptions`,
    { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form },
    timeoutMs,
    `Groq ${model}`,
  );
  if (!response.ok) throw await failure(response, `Groq ${model}`);
  const data = await response.json();
  return { text: (data.text || '').trim(), language: (data.language || '').trim().toLowerCase() };
}

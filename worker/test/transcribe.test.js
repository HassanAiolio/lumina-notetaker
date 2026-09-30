import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { resetExhausted, TranscriptionFailed, transcribeChunk } from '../src/transcribe.js';

const ENV = { GEMINI_API_KEY: 'g-key', GROQ_API_KEY: 'q-key' };
const AUDIO = new Uint8Array([0xff, 0xf3, 1, 2, 3]).buffer;
const realFetch = globalThis.fetch;

let calls;

const reply = (status, body, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const geminiText = (text) => reply(200, { candidates: [{ content: { parts: [{ text }] } }] });
const dailyQuota = () =>
  reply(429, {
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }],
    },
  });

/**
 * A stand-in for the network. `models` maps a model name to the list of
 * replies it gives, one per call; uploads and deletes always succeed.
 */
function network(models) {
  const served = {};
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({ href, method: init.method || 'GET' });
    if (href.endsWith('/upload/v1beta/files')) {
      return reply(200, {}, { 'x-goog-upload-url': 'https://upload.example/session' });
    }
    if (href === 'https://upload.example/session') {
      return reply(200, { file: { name: 'files/abc', uri: 'https://files/abc', mimeType: 'audio/mp3', state: 'ACTIVE' } });
    }
    if (init.method === 'DELETE') return reply(200, {});

    const model = /models\/([^:]+):generateContent/.exec(href)?.[1] || (href.includes('groq') ? 'groq' : null);
    const script = models[model === 'groq' ? String(init.body.get('model')) : model];
    if (!script) return reply(404, { error: { message: 'unknown model' } });
    served[model] = (served[model] || 0) + 1;
    const next = script[Math.min(served[model], script.length) - 1];
    return typeof next === 'function' ? next() : next;
  };
}

const run = (overrides = {}) =>
  transcribeChunk({ audio: AUDIO, mimeType: 'audio/mp3', language: 'fr', env: ENV, ...overrides });

beforeEach(() => {
  calls = [];
  resetExhausted();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('uses the first Gemini model when it answers', async () => {
  network({ 'gemini-3.5-flash': [() => geminiText('{"text": "Bonjour à tous.", "language": "fr"}')] });
  const result = await run();
  assert.deepEqual(result, { text: 'Bonjour à tous.', language: 'fr', engine: 'gemini-3.5-flash' });
  // Uploaded once, then referenced; nothing base64-encoded inline.
  assert.equal(calls.filter((c) => c.href.includes('/upload/')).length, 1);
});

test('moves past a model out of daily quota, and skips it for the next chunk', async () => {
  network({
    'gemini-3.5-flash': [dailyQuota],
    'gemini-2.5-flash': [() => geminiText('{"text": "Suite du cours.", "language": "fr"}')],
  });
  assert.equal((await run()).engine, 'gemini-2.5-flash');

  calls = [];
  assert.equal((await run()).engine, 'gemini-2.5-flash');
  assert.ok(!calls.some((c) => c.href.includes('gemini-3.5-flash')), 'exhausted model was asked again');
});

test('retries a looping reply once, and keeps the clean one', async () => {
  network({
    'gemini-3.5-flash': [
      () => geminiText(`{"text": "Bonjour ${'des '.repeat(300)}`),
      () => geminiText('{"text": "Bonjour à tous.", "language": "fr"}'),
    ],
  });
  const result = await run();
  assert.equal(result.text, 'Bonjour à tous.');
  // The retry reused the upload.
  assert.equal(calls.filter((c) => c.href.includes('/upload/')).length, 1);
});

test('a reply that loops twice is collapsed, never passed on', async () => {
  network({ 'gemini-3.5-flash': [() => geminiText(`{"text": "Bonjour ${'euh '.repeat(300)}`)] });
  assert.equal((await run()).text, 'Bonjour euh euh');
});

test('falls through to Groq Whisper when every Gemini model refuses', async () => {
  network({
    'gemini-3.5-flash': [dailyQuota],
    'gemini-2.5-flash': [dailyQuota],
    'gemini-3.1-flash-lite': [dailyQuota],
    'whisper-large-v3': [() => reply(200, { text: ' Bonjour, on reprend. ', language: 'french' })],
  });
  assert.deepEqual(await run(), { text: 'Bonjour, on reprend.', language: 'fr', engine: 'whisper-large-v3' });
});

test('retries a transient failure once on the same model', async () => {
  network({
    'gemini-3.5-flash': [
      () => reply(503, { error: { status: 'UNAVAILABLE', message: 'high demand' } }),
      () => geminiText('{"text": "Deuxième essai.", "language": "fr"}'),
    ],
  });
  assert.equal((await run()).text, 'Deuxième essai.');
});

test('reports quota when every service is out of it', async () => {
  network({
    'gemini-3.5-flash': [dailyQuota],
    'gemini-2.5-flash': [dailyQuota],
    'gemini-3.1-flash-lite': [dailyQuota],
    'whisper-large-v3': [() => reply(429, { error: { message: 'Rate limit reached on audio seconds per day (ASD)' } })],
    'whisper-large-v3-turbo': [() => reply(429, { error: { message: 'Rate limit reached on requests per day (RPD)' } })],
  });
  await assert.rejects(run(), (err) => err instanceof TranscriptionFailed && err.quota === true);
});

test('tidies the uploaded file away after answering', async () => {
  network({ 'gemini-3.5-flash': [() => geminiText('{"text": "Ok.", "language": "fr"}')] });
  const pending = [];
  await run({ waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.href.endsWith('/v1beta/files/abc')));
});

test('a reply cut off at the token limit is asked again, and the complete one kept', async () => {
  const cut = () =>
    reply(200, { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"text": "Bonjour à' }] } }] });
  network({
    'gemini-3.5-flash': [cut, () => geminiText('{"text": "Bonjour à tous, on commence.", "language": "fr"}')],
  });
  assert.equal((await run()).text, 'Bonjour à tous, on commence.');
});

test('keeps thinking minimal, in the form each model family takes', async () => {
  const bodies = {};
  network({
    'gemini-3.5-flash': [dailyQuota],
    'gemini-2.5-flash': [() => geminiText('{"text": "Ok.", "language": "fr"}')],
  });
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const model = /models\/([^:]+):/.exec(String(url))?.[1];
    if (model) bodies[model] = JSON.parse(init.body).generationConfig.thinkingConfig;
    return inner(url, init);
  };
  await run();
  assert.deepEqual(bodies['gemini-3.5-flash'], { thinkingLevel: 'low' });
  assert.deepEqual(bodies['gemini-2.5-flash'], { thinkingBudget: 0 });
});

test('a model that rejects the thinking setting is asked again without it', async () => {
  const seen = [];
  network({
    'gemini-3.5-flash': [
      () => reply(400, { error: { message: 'thinking_level is not supported for this model' } }),
      () => geminiText('{"text": "Sans réflexion.", "language": "fr"}'),
    ],
  });
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes(':generateContent')) seen.push(JSON.parse(init.body).generationConfig.thinkingConfig);
    return inner(url, init);
  };
  assert.equal((await run()).text, 'Sans réflexion.');
  assert.deepEqual(seen, [{ thinkingLevel: 'low' }, undefined]);
});

test('silence comes back empty rather than as a sentence about silence', async () => {
  network({ 'gemini-3.5-flash': [() => geminiText('{"text": "[no speech]", "language": "fr"}')] });
  assert.equal((await run()).text, '');
});

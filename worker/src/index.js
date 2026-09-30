// Lumina transcription Worker.
//
// Audio is over 99% of the bytes the app moves. Sending it through the Render
// backend meant a hosting bandwidth meter - 5 GB a month on the free plan -
// that suspends the whole backend when it runs out. A Worker's traffic is not
// metered, so the audio comes here instead and only small JSON goes to Render.
// The backend's own /api/transcribe stays as the fallback path.
//
//   POST /transcribe?language=fr&context=...   body: the audio chunk itself
//   GET  /health
//
// The body is the raw chunk rather than a multipart form: parsing a form costs
// CPU, and a free Worker gets 10 ms of it per request. Waiting on the network
// does not count, which is what this Worker mostly does.

import { AuthError, verifySession } from './auth.js';
import { csv, MIME_ALIASES, TranscriptionFailed, transcribeChunk } from './transcribe.js';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
// The browser gives up at 180 s; stop starting new requests well before that.
const BUDGET_MS = 150_000;

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  // Browsers send an origin with no trailing slash; one copied from the
  // address bar usually has it, and would then never match.
  const allowed = csv(env.ALLOWED_ORIGINS, 'http://localhost:3000').map((o) => o.replace(/\/+$/, ''));
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

async function handleTranscribe(request, env, ctx, cors) {
  try {
    await verifySession(request.headers.get('Authorization'), env.JWT_SECRET);
  } catch (err) {
    if (err instanceof AuthError) return json({ detail: err.message }, 401, cors);
    throw err;
  }

  if (!env.GEMINI_API_KEY && !env.GROQ_API_KEY) {
    return json({ detail: 'Transcription is unavailable: no API key is configured.' }, 503, cors);
  }

  const base = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  const mimeType = MIME_ALIASES[base];
  if (!mimeType) return json({ detail: `Unsupported audio format: ${base || 'none'}` }, 400, cors);

  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_AUDIO_BYTES) {
    return json({ detail: 'Audio is too large. The limit is 25 MB per request.' }, 413, cors);
  }
  const audio = await request.arrayBuffer();
  if (!audio.byteLength) return json({ detail: 'Empty audio upload' }, 400, cors);
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    return json({ detail: 'Audio is too large. The limit is 25 MB per request.' }, 413, cors);
  }

  const params = new URL(request.url).searchParams;
  const started = Date.now();
  try {
    const result = await transcribeChunk({
      audio,
      mimeType,
      language: params.get('language') || 'auto',
      context: (params.get('context') || '').slice(0, 2000),
      env,
      deadline: started + BUDGET_MS,
      waitUntil: (promise) => ctx.waitUntil(promise),
      log: (line) => console.log(line),
    });
    console.log(
      `transcribed ${audio.byteLength} bytes with ${result.engine} in ${Date.now() - started} ms`,
    );
    return json({ ...result, duration: null, chunks: 1 }, 200, cors);
  } catch (err) {
    if (!(err instanceof TranscriptionFailed)) throw err;
    console.log(`all providers failed (quota=${err.quota}) after ${Date.now() - started} ms`);
    // `providers_failed` tells the app not to retry through the backend: it
    // holds the same keys, so it would meet the same refusals.
    return json({ detail: err.message, code: 'providers_failed', quota: err.quota }, 502, cors);
  }
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (pathname === '/health' && request.method === 'GET') {
        return json(
          { ok: true, gemini: Boolean(env.GEMINI_API_KEY), groq: Boolean(env.GROQ_API_KEY) },
          200,
          cors,
        );
      }
      if (pathname === '/transcribe' && request.method === 'POST') {
        return await handleTranscribe(request, env, ctx, cors);
      }
      return json({ detail: 'Not found' }, 404, cors);
    } catch (err) {
      console.log(`unhandled: ${err?.stack || err}`);
      return json({ detail: 'Something went wrong on our side. Please try again.' }, 500, cors);
    }
  },
};

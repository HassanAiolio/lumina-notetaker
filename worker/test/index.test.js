import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import worker from '../src/index.js';

const ENV = { ALLOWED_ORIGINS: 'https://lumina.example/,http://localhost:3000', JWT_SECRET: 's', GROQ_API_KEY: 'k' };
const call = (path, init = {}, env = ENV) => worker.fetch(new Request(`https://w.example${path}`, init), env, { waitUntil() {} });

test('answers the preflight for an allowed origin, even one configured with a trailing slash', async () => {
  const response = await call('/transcribe', { method: 'OPTIONS', headers: { Origin: 'https://lumina.example' } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://lumina.example');
});

test('gives no CORS headers to any other origin', async () => {
  const response = await call('/transcribe', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

test('refuses a chunk without a session', async () => {
  const response = await call('/transcribe', { method: 'POST', body: 'x', headers: { 'Content-Type': 'audio/mpeg' } });
  assert.equal(response.status, 401);
});

test('health reports which keys the running Worker can see', async () => {
  const body = await (await call('/health')).json();
  assert.deepEqual(body, { ok: true, gemini: false, groq: true });
});

test('steers a chunk with the end of the previous text, not its start', async () => {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const token = `${unsigned}.${createHmac('sha256', ENV.JWT_SECRET).update(unsigned).digest('base64url')}`;
  const realFetch = globalThis.fetch;
  let prompt = null;
  globalThis.fetch = async (_url, init) => {
    prompt = init.body.get('prompt');
    return new Response(JSON.stringify({ text: 'Suite.', language: 'french' }), { status: 200 });
  };
  try {
    const context = `${'début '.repeat(600)}la toute fin`;
    const response = await call(`/transcribe?language=fr&context=${encodeURIComponent(context)}`, {
      method: 'POST',
      body: new Uint8Array([1, 2, 3]),
      headers: { 'Content-Type': 'audio/mpeg', Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.ok(prompt.endsWith('la toute fin'), 'Whisper is primed with the words just before the chunk');
  } finally {
    globalThis.fetch = realFetch;
  }
});

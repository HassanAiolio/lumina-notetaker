import assert from 'node:assert/strict';
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

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { AuthError, verifySession } from '../src/auth.js';

const SECRET = 'the-backend-secret';
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A token built the way PyJWT builds the backend's. */
export function sign(claims, { secret = SECRET, alg = 'HS256' } = {}) {
  const head = b64({ alg, typ: 'JWT' });
  const body = b64(claims);
  const signature = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

const future = () => Math.floor(Date.now() / 1000) + 3600;

test('accepts a token the backend signed', async () => {
  const claims = await verifySession(`Bearer ${sign({ sub: 'u1', email: 'a@b.c', exp: future() })}`, SECRET);
  assert.equal(claims.sub, 'u1');
});

test('refuses a token signed with another secret', async () => {
  const token = sign({ sub: 'u1', exp: future() }, { secret: 'someone-else' });
  await assert.rejects(verifySession(`Bearer ${token}`, SECRET), AuthError);
});

test('refuses an expired token, and says so', async () => {
  const token = sign({ sub: 'u1', exp: Math.floor(Date.now() / 1000) - 5 });
  await assert.rejects(verifySession(`Bearer ${token}`, SECRET), /expired/);
});

test('refuses alg=none and other algorithms, whatever the signature', async () => {
  const token = sign({ sub: 'u1', exp: future() }, { alg: 'none' });
  await assert.rejects(verifySession(`Bearer ${token}`, SECRET), AuthError);
});

test('refuses a tampered payload', async () => {
  const [head, , signature] = sign({ sub: 'u1', exp: future() }).split('.');
  const forged = `${head}.${b64({ sub: 'admin', exp: future() })}.${signature}`;
  await assert.rejects(verifySession(`Bearer ${forged}`, SECRET), AuthError);
});

test('refuses a missing header, and works without a configured secret only by failing', async () => {
  await assert.rejects(verifySession(null, SECRET), /Not signed in/);
  await assert.rejects(verifySession(`Bearer ${sign({ sub: 'u1', exp: future() })}`, ''), AuthError);
});

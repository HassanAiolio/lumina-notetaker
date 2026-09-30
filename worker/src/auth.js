// Verifies the session token the backend issues at sign-in (backend/auth.py:
// HS256, signed with JWT_SECRET). Sharing the secret is what lets the Worker
// accept exactly the people the backend let in - its email allow-list included
// - without a round trip to the backend on every chunk.

const encoder = new TextEncoder();
const keyCache = new Map();

function base64UrlToBytes(segment) {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret) {
  if (!keyCache.has(secret)) {
    keyCache.set(
      secret,
      crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
        'verify',
      ]),
    );
  }
  return keyCache.get(secret);
}

export class AuthError extends Error {}

/** The token's claims if it is genuine and current; throws AuthError otherwise. */
export async function verifySession(authorization, secret, now = Date.now()) {
  if (!secret) throw new AuthError('The transcription service is missing its JWT_SECRET');
  const token = /^Bearer\s+(\S+)$/i.exec(authorization || '')?.[1];
  if (!token) throw new AuthError('Not signed in');

  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('Invalid session token');
  const [headerPart, payloadPart, signaturePart] = parts;

  let header;
  let claims;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(headerPart)));
    claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadPart)));
  } catch (err) {
    throw new AuthError('Invalid session token');
  }
  // Pinned, never read from the token: trusting its "alg" is the classic hole.
  if (header.alg !== 'HS256') throw new AuthError('Invalid session token');

  const valid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    base64UrlToBytes(signaturePart),
    encoder.encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) throw new AuthError('Invalid session token');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) {
    throw new AuthError('Session expired, please sign in again');
  }
  if (!claims.sub) throw new AuthError('Invalid session token');
  return claims;
}

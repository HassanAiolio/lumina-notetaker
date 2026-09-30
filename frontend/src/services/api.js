import axios from 'axios';

const BASE_URL = (process.env.REACT_APP_BACKEND_URL || '').replace(/\/+$/, '');
export const API_ROOT = `${BASE_URL}/api`;

export const TOKEN_STORAGE_KEY = 'lumina.token';

/** localStorage throws in private mode on some browsers; never let that break the app. */
const safeStorage = {
  get(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (err) {
      /* storage unavailable */
    }
  },
  remove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (err) {
      /* storage unavailable */
    }
  },
};

export const tokenStore = {
  get: () => safeStorage.get(TOKEN_STORAGE_KEY),
  set: (token) => safeStorage.set(TOKEN_STORAGE_KEY, token),
  clear: () => safeStorage.remove(TOKEN_STORAGE_KEY),
};

export const client = axios.create({ baseURL: API_ROOT, timeout: 180000 });

let onUnauthorized = null;
export const setUnauthorizedHandler = (handler) => {
  onUnauthorized = handler;
};

client.interceptors.request.use((config) => {
  const token = tokenStore.get();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

const RETRYABLE_STATUS = new Set([408, 502, 503, 504]);
const MAX_RETRIES = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

client.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config || {};
    const status = error.response?.status;

    if (status === 401) {
      tokenStore.clear();
      onUnauthorized?.();
      return Promise.reject(error);
    }

    // Retry idempotent reads and the network failures that a cold backend
    // produces; never retry a POST that may already have written something.
    const method = (config.method || 'get').toLowerCase();
    const isSafe = method === 'get';
    const isTransient = !error.response || RETRYABLE_STATUS.has(status);

    if (isSafe && isTransient && (config.__retryCount || 0) < MAX_RETRIES) {
      config.__retryCount = (config.__retryCount || 0) + 1;
      await sleep(600 * config.__retryCount);
      return client(config);
    }

    return Promise.reject(error);
  },
);

/** A message worth showing a user, out of any axios failure. */
export const errorMessage = (error, fallback = 'Something went wrong.') => {
  const detail = error?.response?.data?.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail) && detail[0]?.msg) return detail[0].msg;
  if (error?.code === 'ECONNABORTED') return 'The server took too long to respond. Please try again.';
  if (!error?.response) return 'Cannot reach the server. Check your connection and try again.';
  if (error.response.status === 429) return 'Too many requests. Please wait a moment.';
  if (error.response.status >= 500) return 'The server had a problem. Please try again.';
  return fallback;
};

// ── Auth ─────────────────────────────────────────────────────────────────────

export const getPublicConfig = async () => (await client.get('/config')).data;

export const signInWithGoogle = async (credential) =>
  (await client.post('/auth/google', { credential })).data;

export const fetchMe = async () => (await client.get('/auth/me')).data;

// ── Transcription and notes ──────────────────────────────────────────────────

// Audio goes to the transcription Worker when one is configured, because its
// traffic is not metered: sent through the backend, every chunk counted
// against Render's 5 GB a month, and running out suspended the whole app.
// The backend's own /transcribe stays as the second path.
const TRANSCRIBE_URL = (process.env.REACT_APP_TRANSCRIBE_URL || '').replace(/\/+$/, '');

// Its own client, not `client`: that one signs people out on any 401, and a
// Worker with the wrong secret must never do that. The backend decides.
export const workerClient = axios.create({ timeout: 180000 });

const viaBackend = async ({ blob, language, context, signal }) => {
  const form = new FormData();
  form.append('file', blob, blob.type === 'audio/mpeg' ? 'chunk.mp3' : 'chunk.wav');
  form.append('language', language);
  form.append('context', context);
  const response = await client.post('/transcribe', form, { signal });
  return response.data;
};

// The raw chunk as the body, the rest as query parameters: the Worker would
// otherwise spend its small CPU allowance parsing a form.
const viaWorker = async ({ blob, language, context, signal }) => {
  const token = tokenStore.get();
  const response = await workerClient.post(`${TRANSCRIBE_URL}/transcribe`, blob, {
    params: { language, context },
    headers: {
      'Content-Type': blob.type || 'audio/mpeg',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal,
  });
  return response.data;
};

/**
 * Is a Worker failure worth retrying through the backend?
 *
 * Only when the Worker itself is the problem - unreachable, misconfigured,
 * crashing. Not when the audio was refused, which the backend would refuse
 * too, and not when every transcription service was out of quota: the backend
 * holds the same keys, so it would meet the same refusals and spend its
 * metered bandwidth on the way.
 */
export const shouldFallBack = (error) => {
  if (axios.isCancel(error) || error?.code === 'ERR_CANCELED') return false;
  const status = error?.response?.status;
  if (!status) return true;
  if (status === 400 || status === 413) return false;
  if (error.response.data?.code === 'providers_failed') return false;
  return true;
};

// After the Worker fails for its own reasons, the next few minutes of chunks
// go straight to the backend rather than each waiting on the same failure.
const WORKER_COOLDOWN_MS = 5 * 60 * 1000;
let workerDownUntil = 0;
export const resetTranscriptionRoute = () => {
  workerDownUntil = 0;
};

export const transcribeChunk = async ({ blob, language = 'auto', context = '', signal }) => {
  const args = { blob, language, context, signal };
  if (!TRANSCRIBE_URL || Date.now() < workerDownUntil) return viaBackend(args);
  try {
    return await viaWorker(args);
  } catch (error) {
    if (!shouldFallBack(error)) throw error;
    workerDownUntil = Date.now() + WORKER_COOLDOWN_MS;
    // eslint-disable-next-line no-console
    console.warn('Transcription Worker failed, using the backend instead:', error?.message);
    return viaBackend(args);
  }
};

// Summarizing walks a long transcript window by window, and a rate-limited
// provider is waited out rather than skipped, so this is the one call that
// legitimately runs for minutes. The default timeout would cut it off.
export const SUMMARIZE_TIMEOUT_MS = 10 * 60 * 1000;

export const summarizeTranscript = async (transcript, language = 'auto') =>
  (
    await client.post(
      '/notes/summarize',
      { transcript, language },
      { timeout: SUMMARIZE_TIMEOUT_MS },
    )
  ).data;

export const saveNote = async (note) => (await client.post('/notes', note)).data;

export const getNotes = async ({ search, tag, limit = 30, offset = 0 } = {}) => {
  const params = { limit, offset };
  if (search) params.search = search;
  if (tag) params.tag = tag;
  return (await client.get('/notes', { params })).data;
};

export const getNote = async (id) => (await client.get(`/notes/${id}`)).data;

export const updateNote = async (id, changes) => (await client.patch(`/notes/${id}`, changes)).data;

export const deleteNote = async (id) => (await client.delete(`/notes/${id}`)).data;

export const getAllTags = async () => (await client.get('/tags')).data;

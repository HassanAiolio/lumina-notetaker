/**
 * Which path a chunk takes. The Worker is the main one; the backend is only a
 * fallback for when the Worker itself is broken, because a fallback on a
 * quota refusal would hit the same quota and spend metered bandwidth doing so.
 */
const failure = (status, data = {}) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

let api;

beforeEach(() => {
  jest.resetModules();
  process.env.REACT_APP_TRANSCRIBE_URL = 'https://worker.example/';
  // eslint-disable-next-line global-require
  api = require('./api');
  api.tokenStore.set('session-token');
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.REACT_APP_TRANSCRIBE_URL;
  jest.restoreAllMocks();
});

const blob = () => new Blob(['mp3'], { type: 'audio/mpeg' });

it('sends the raw chunk to the Worker, signed in, with the rest as parameters', async () => {
  const worker = jest.spyOn(api.workerClient, 'post').mockResolvedValue({ data: { text: 'ok' } });
  const backend = jest.spyOn(api.client, 'post');

  const result = await api.transcribeChunk({ blob: blob(), language: 'fr', context: 'avant' });

  expect(result).toEqual({ text: 'ok' });
  expect(backend).not.toHaveBeenCalled();
  const [url, body, config] = worker.mock.calls[0];
  expect(url).toBe('https://worker.example/transcribe');
  expect(body.type).toBe('audio/mpeg');
  expect(config.params).toEqual({ language: 'fr', context: 'avant' });
  expect(config.headers).toMatchObject({ Authorization: 'Bearer session-token', 'Content-Type': 'audio/mpeg' });
});

it('falls back to the backend when the Worker cannot be reached, then stays there a while', async () => {
  const worker = jest.spyOn(api.workerClient, 'post').mockRejectedValue(new Error('Network Error'));
  const backend = jest.spyOn(api.client, 'post').mockResolvedValue({ data: { text: 'via backend' } });

  expect(await api.transcribeChunk({ blob: blob() })).toEqual({ text: 'via backend' });
  await api.transcribeChunk({ blob: blob() });

  expect(worker).toHaveBeenCalledTimes(1); // the second chunk did not wait on it again
  expect(backend).toHaveBeenCalledTimes(2);
  expect(backend.mock.calls[0][0]).toBe('/transcribe');
});

it.each([
  ['every service out of quota', failure(502, { code: 'providers_failed', quota: true })],
  ['audio the backend would refuse too', failure(400)],
  ['a cancelled upload', Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' })],
])('does not fall back for %s', async (_, error) => {
  jest.spyOn(api.workerClient, 'post').mockRejectedValue(error);
  const backend = jest.spyOn(api.client, 'post');

  await expect(api.transcribeChunk({ blob: blob() })).rejects.toBe(error);
  expect(backend).not.toHaveBeenCalled();
});

it.each([
  ['a Worker with the wrong secret', failure(401)],
  ['a crashing Worker', failure(500)],
])('falls back for %s', async (_, error) => {
  jest.spyOn(api.workerClient, 'post').mockRejectedValue(error);
  jest.spyOn(api.client, 'post').mockResolvedValue({ data: { text: 'via backend' } });
  expect(await api.transcribeChunk({ blob: blob() })).toEqual({ text: 'via backend' });
});

it('uses the backend alone when no Worker is configured', async () => {
  jest.resetModules();
  delete process.env.REACT_APP_TRANSCRIBE_URL;
  // eslint-disable-next-line global-require
  const plain = require('./api');
  const backend = jest.spyOn(plain.client, 'post').mockResolvedValue({ data: { text: 'ok' } });
  const worker = jest.spyOn(plain.workerClient, 'post');

  await plain.transcribeChunk({ blob: blob() });
  expect(backend).toHaveBeenCalled();
  expect(worker).not.toHaveBeenCalled();
});

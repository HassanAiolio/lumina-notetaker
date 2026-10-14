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

describe('summarizeTranscript', () => {
  const running = (done, total) => ({ data: { id: 'j1', status: 'running', progress: { stage: 'writing', done, total } } });

  it('starts a job and checks on it until the notes are written', async () => {
    const post = jest.spyOn(api.client, 'post').mockResolvedValue(running(0, 3));
    const get = jest.spyOn(api.client, 'get')
      .mockResolvedValueOnce(running(1, 3))
      .mockResolvedValueOnce({ data: { id: 'j1', status: 'done', result: { title: 'Cours 2' } } });
    const progress = [];

    const result = await api.summarizeTranscript('Bonjour', 'fr', [{ page: 1, text: 'x' }], {
      onProgress: (update) => progress.push(update.done),
      pollMs: 0,
    });

    expect(result).toEqual({ title: 'Cours 2' });
    expect(post).toHaveBeenCalledWith('/notes/summarize/jobs', {
      transcript: 'Bonjour', language: 'fr', slides: [{ page: 1, text: 'x' }],
    });
    expect(get).toHaveBeenCalledWith('/notes/summarize/jobs/j1');
    expect(progress).toEqual([0, 1]);
  });

  it("reports the server's reason when a job fails", async () => {
    jest.spyOn(api.client, 'post').mockResolvedValue(running(0, 2));
    jest.spyOn(api.client, 'get').mockResolvedValue({ data: { id: 'j1', status: 'failed', error: 'Took too long.' } });

    const error = await api.summarizeTranscript('Bonjour', 'fr', [], { pollMs: 0 }).catch((e) => e);
    expect(api.errorMessage(error)).toBe('Took too long.');
  });

  it('rides out a few failed checks, but not a job the server no longer has', async () => {
    jest.spyOn(api.client, 'post').mockResolvedValue(running(0, 2));
    jest.spyOn(api.client, 'get')
      .mockRejectedValueOnce(new Error('Network Error'))
      .mockRejectedValueOnce(failure(503))
      .mockResolvedValueOnce({ data: { id: 'j1', status: 'done', result: { title: 'T' } } });
    expect(await api.summarizeTranscript('Bonjour', 'fr', [], { pollMs: 0 })).toEqual({ title: 'T' });

    api.client.get.mockReset();
    api.client.get.mockRejectedValue(failure(404, { detail: 'The server may have restarted: try again.' }));
    const error = await api.summarizeTranscript('Bonjour', 'fr', [], { pollMs: 0 }).catch((e) => e);
    expect(api.errorMessage(error)).toContain('restarted');
    expect(api.client.get).toHaveBeenCalledTimes(1);
  });

  it('uses the single request on a backend that has no jobs yet', async () => {
    const post = jest.spyOn(api.client, 'post')
      .mockRejectedValueOnce(failure(404))
      .mockResolvedValueOnce({ data: { title: 'Old way' } });

    expect(await api.summarizeTranscript('Bonjour')).toEqual({ title: 'Old way' });
    expect(post.mock.calls[1][0]).toBe('/notes/summarize');
    expect(post.mock.calls[1][2]).toEqual({ timeout: api.SUMMARIZE_TIMEOUT_MS });
  });
});

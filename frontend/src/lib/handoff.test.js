import { HANDOFF_KEY, handoffStore, serverRoute } from './handoff';

const failure = (status) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: {} } });
// The route only passes the chunk along, so a named stand-in will do.
const blob = (name) => ({ name, type: 'audio/mpeg' });

const fakeServices = () => {
  const services = {
    calls: [],
    startNoteJob: jest.fn(async (body) => {
      services.calls.push(['start', body]);
      return { id: 'job-1', status: body.audio ? 'receiving' : 'running', audio: { received: 0 } };
    }),
    uploadJobAudio: jest.fn(async (id, index, chunk) => {
      services.calls.push(['upload', id, index, chunk.name]);
    }),
    sealNoteJob: jest.fn(async (id, chunks) => {
      services.calls.push(['seal', id, chunks]);
      return { id, status: 'running' };
    }),
  };
  return services;
};

beforeEach(() => window.localStorage.clear());

it('makes the job at the first upload, with the transcript as it is then, and seals with the count', async () => {
  const services = fakeServices();
  let transcript = 'Live text';
  let done = 3;
  const uploaded = [];
  const route = serverRoute({
    request: () => ({ transcript, language: 'fr' }),
    base: () => done,
    recordingId: 'rec-1',
    chunkSeconds: 240,
    onUpload: (sent) => uploaded.push(sent),
    services,
  });

  // A chunk still being transcribed at Stop lands before the first upload.
  transcript = 'Live text and the chunk in flight';
  done = 4;
  expect(await route.transcribe({ blob: blob('a') })).toEqual({ text: '', language: '' });
  expect(handoffStore.get()).toEqual({ jobId: 'job-1', recordingId: 'rec-1', base: 4, chunkSeconds: 240 });
  await route.transcribe({ blob: blob('b') });
  const sealed = await route.finish();

  expect(services.calls).toEqual([
    ['start', { transcript: 'Live text and the chunk in flight', language: 'fr', audio: true }],
    ['upload', 'job-1', 0, 'a'],
    ['upload', 'job-1', 1, 'b'],
    ['seal', 'job-1', 2],
  ]);
  expect(uploaded).toEqual([1, 2]);
  expect(sealed.status).toBe('running');
  expect(window.localStorage.getItem(HANDOFF_KEY)).toBeNull();
});

it('hands over the text alone when live transcription already did all the audio', async () => {
  const services = fakeServices();
  const route = serverRoute({ request: () => ({ transcript: 'Everything' }), services });
  const job = await route.finish();
  expect(services.calls).toEqual([['start', { transcript: 'Everything', audio: false }]]);
  expect(job.status).toBe('running');
});

it('carries on with a job already made, from the chunk the server got to', async () => {
  const services = fakeServices();
  const route = serverRoute({
    request: () => {
      throw new Error('not asked for');
    },
    job: { id: 'job-9', status: 'receiving', audio: { received: 2 } },
    services,
  });
  await route.transcribe({ blob: blob('c') });
  await route.finish();
  expect(services.startNoteJob).not.toHaveBeenCalled();
  expect(services.calls).toEqual([['upload', 'job-9', 2, 'c'], ['seal', 'job-9', 3]]);
});

it('tries a dropped upload again, but not one the server refused', async () => {
  const services = fakeServices();
  services.uploadJobAudio
    .mockRejectedValueOnce(new Error('Network Error'))
    .mockRejectedValueOnce(failure(503));
  const route = serverRoute({ request: () => ({ transcript: 'x' }), retryDelayMs: 0, services });
  await route.transcribe({ blob: blob('a') });
  expect(services.uploadJobAudio).toHaveBeenCalledTimes(3);
  expect(route.sent).toBe(1);

  services.uploadJobAudio.mockReset();
  services.uploadJobAudio.mockRejectedValue(failure(409));
  await expect(route.transcribe({ blob: blob('b') })).rejects.toThrow('HTTP 409');
  expect(services.uploadJobAudio).toHaveBeenCalledTimes(1);
  expect(route.sent).toBe(1);
});

it('stops at once when cancelled', async () => {
  const services = fakeServices();
  const controller = new AbortController();
  services.uploadJobAudio.mockImplementation(async () => {
    controller.abort();
    throw Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' });
  });
  const route = serverRoute({ request: () => ({ transcript: 'x' }), retryDelayMs: 0, services });
  await expect(route.transcribe({ blob: blob('a'), signal: controller.signal })).rejects.toThrow('canceled');
  expect(services.uploadJobAudio).toHaveBeenCalledTimes(1);
});

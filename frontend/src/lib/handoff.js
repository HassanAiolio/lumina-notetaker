/**
 * Handing a stopped recording to the server, so the tab can close.
 *
 * Live transcription does most of a lecture while it is being given. What is
 * left at Stop - normally the last few minutes - used to be done here too,
 * followed by the notes, and closing the tab at any point lost the rest. Now
 * the rest goes to the server (backend pipeline.py), which transcribes it,
 * writes the notes and saves the note itself.
 *
 * serverRoute() stands in for transcribeChunk: plugged into
 * transcribeSegments as its `transcribe`, each chunk is uploaded instead of
 * transcribed. That lets the live run that has been cutting the lecture into
 * chunks all along simply carry on after Stop - nothing is decoded twice, and
 * a chunk that was already being transcribed when Stop was pressed finishes
 * first and is part of the text the server is given.
 *
 * The job is made at the first upload rather than at Stop for that same
 * reason: the transcript it is given is the one as it stands then.
 *
 * While audio is going up, where it got to is kept in localStorage, so a
 * reload can finish the upload from the copy of the recording on this device.
 */
import * as api from '../services/api';
import { isCancel } from './transcription';

export const HANDOFF_KEY = 'lumina.handoff';

export const handoffStore = {
  get() {
    try {
      return JSON.parse(window.localStorage.getItem(HANDOFF_KEY) || 'null');
    } catch (err) {
      return null;
    }
  },
  set(value) {
    try {
      window.localStorage.setItem(HANDOFF_KEY, JSON.stringify(value));
    } catch (err) {
      /* storage unavailable: a reload just cannot pick the upload back up */
    }
  },
  clear() {
    try {
      window.localStorage.removeItem(HANDOFF_KEY);
    } catch (err) {
      /* storage unavailable */
    }
  },
};

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

// Refusals that the same request would meet again: bad audio, a lost session,
// someone else's job, chunks out of order, too much audio.
const HOPELESS = new Set([400, 401, 403, 404, 409, 413, 422]);

/**
 * Uploads chunks to one server job, and seals it when there are no more.
 *
 * `request()` is the job's body (transcript, language, slides...), read when
 * the job is made. `base()` is how many chunks were transcribed here by then;
 * kept with the job's id, it is what a reload needs to carry on. Pass `job` to
 * carry on with one already made (after a reload, or a failed upload).
 */
export function serverRoute({
  request,
  base = () => 0,
  job: existing = null,
  recordingId = null,
  chunkSeconds = null,
  onUpload,
  retries = 3,
  retryDelayMs = 4000,
  services = api,
}) {
  let job = existing;
  let creating = null;
  let sent = existing?.audio?.received || 0;

  const persist = async (call, signal) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await call();
      } catch (error) {
        if (isCancel(error, signal) || HOPELESS.has(error?.response?.status) || attempt >= retries) throw error;
        // eslint-disable-next-line no-await-in-loop
        await sleep(retryDelayMs * (attempt + 1), signal);
        if (signal?.aborted) throw error;
      }
    }
  };

  const ensureJob = () => {
    if (job) return Promise.resolve(job);
    if (!creating) {
      const done = base();
      creating = services
        .startNoteJob({ ...request(), audio: true })
        .then((made) => {
          job = made;
          handoffStore.set({ jobId: made.id, recordingId, base: done, chunkSeconds });
          return made;
        })
        .finally(() => {
          creating = null;
        });
    }
    return creating;
  };

  return {
    get job() {
      return job;
    },
    get sent() {
      return sent;
    },
    /** In place of transcribeChunk: the chunk goes to the server, to be transcribed there. */
    async transcribe({ blob, signal }) {
      const target = await persist(ensureJob, signal);
      await persist(() => services.uploadJobAudio(target.id, sent, blob, { signal }), signal);
      sent += 1;
      onUpload?.(sent);
      return { text: '', language: '' };
    },
    /**
     * No more audio. Seals the job; with no audio sent at all, the server is
     * given the transcript alone and writes the notes from it.
     */
    async finish() {
      let finished;
      if (!job && !creating) {
        finished = await persist(() => services.startNoteJob({ ...request(), audio: false }));
      } else {
        const target = await persist(ensureJob);
        finished = await persist(() => services.sealNoteJob(target.id, sent));
      }
      handoffStore.clear();
      return finished;
    },
  };
}

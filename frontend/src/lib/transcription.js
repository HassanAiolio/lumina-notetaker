import { streamWavChunks } from './audio';
import { transcribeChunk as defaultTranscribe } from '../services/api';

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

/** Has `error` come from the run being cancelled rather than from a failure? */
export const isCancel = (error, signal) =>
  signal?.aborted ||
  error?.code === 'ERR_CANCELED' ||
  ['CanceledError', 'AbortError'].includes(error?.name);

/**
 * Where a transcription run has got to. Everything a later run needs to carry
 * on from the same place: chunks done, the text that steers the next chunk's
 * spelling, the language heard, and the chunk length the cut points came from.
 */
export const freshProgress = (chunkSeconds) => ({ done: 0, context: '', detected: '', chunkSeconds });

/**
 * Encode and upload capture segments one chunk at a time, in order.
 *
 * `segments` is the finished array after a recording, or a live
 * createSegmentQueue() while it is still running - which is what lets a
 * lecture be transcribed as it is given, so that pressing stop leaves only the
 * last few minutes to do.
 *
 * Chunks are pulled from the encoder one ahead of the upload rather than all
 * built up front, so at most two chunks of audio are ever in memory and the
 * next one is ready the moment the current upload returns.
 *
 * `onChunk(text, progress)` runs after each chunk. On failure the error is
 * thrown with `error.progress` set, so the caller can retry from that chunk.
 *
 * `retries` re-sends a failed chunk after a pause. The live run uses it: a
 * lecture hall's Wi-Fi drops for a few seconds and an hour of recording still
 * has plenty of time to catch up, where giving up would leave everything to
 * the end again.
 */
export async function transcribeSegments(
  segments,
  {
    language = 'auto',
    progress: start,
    signal,
    onChunk,
    retries = 0,
    retryDelayMs = 15000,
    transcribe = defaultTranscribe,
  },
) {
  const progress = { ...start };

  const chunks = streamWavChunks(segments, {
    chunkSeconds: progress.chunkSeconds,
    // MP3 rather than WAV: a chunk is 2.7 times smaller (see MP3_KBPS).
    format: 'mp3',
    skipChunks: progress.done,
  });
  // The catch only marks a failure as handled here; awaiting the same promise
  // below still throws it.
  const prepare = () => {
    const pending = chunks.next();
    pending.catch(() => {});
    return pending;
  };

  const send = async (blob) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await transcribe({ blob, language, context: progress.context, signal });
      } catch (error) {
        // A refused upload or a lost session is refused again, however long we wait.
        const hopeless = [400, 401, 413].includes(error?.response?.status);
        if (isCancel(error, signal) || hopeless || attempt >= retries) throw error;
        // eslint-disable-next-line no-await-in-loop
        await sleep(retryDelayMs * (attempt + 1), signal);
        if (signal?.aborted) throw error;
      }
    }
  };

  // A cancelled run throws rather than returning, so nobody mistakes the text
  // so far for the whole recording.
  const checkCancelled = () => {
    if (signal?.aborted) throw Object.assign(new Error('Transcription cancelled'), { name: 'AbortError' });
  };

  let upcoming = prepare();
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { value: chunk, done: finished } = await upcoming;
      checkCancelled();
      if (finished) break;
      upcoming = prepare();
      // eslint-disable-next-line no-await-in-loop
      const result = await send(chunk.blob);
      // A reply that lands just after a cancel is not counted, so the text the
      // caller holds and the chunk a retry starts from always agree.
      checkCancelled();
      const text = (result.text || '').trim();
      if (text) progress.context = text;
      if (!progress.detected && result.language && result.language !== 'auto') {
        progress.detected = result.language;
      }
      progress.done += 1;
      onChunk?.(text, { ...progress });
    }
  } catch (error) {
    error.progress = { ...progress };
    throw error;
  } finally {
    // Stop the encoder working ahead on a chunk nobody will upload.
    chunks.return().catch(() => {});
  }
  return progress;
}

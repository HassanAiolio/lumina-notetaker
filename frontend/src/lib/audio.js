/**
 * Browser audio -> WAV chunks the transcription API can accept.
 *
 * MediaRecorder hands us WebM/Opus on Chrome and MP4/AAC on Safari, and the
 * speech model is only documented for WAV/MP3/OGG/FLAC/AAC/AIFF. Rather than
 * bet on container support, we decode locally and re-encode to 16 kHz mono
 * PCM, which every speech model accepts and which is also the rate they
 * downsample to anyway.
 *
 * Nothing here ever holds a whole recording. Audio arrives as a list of
 * independently decodable segments, and `streamWavChunks` walks them one at a
 * time, so peak memory follows the segment length rather than how long someone
 * spoke. That is what makes a three hour recording possible: the old pipeline
 * decoded everything into a single Float32Array first, which cost ~230 MB per
 * hour at 16 kHz - and three times that again at the 48 kHz rate the decoder
 * picked up from the output device when nobody asked it for anything else.
 */

export const TARGET_SAMPLE_RATE = 16000;
// 4 minutes of 16 kHz mono PCM is about 7.7 MB, comfortably inside the
// request ceiling once base64 encoding has inflated it by a third.
export const CHUNK_SECONDS = 240;

/**
 * How much audio goes into one capture segment. Every segment is a complete,
 * self-contained recording, so it can be decoded on its own and then dropped.
 * Five minutes decodes to ~19 MB of samples, which any phone can hold.
 *
 * Shorter would cap memory lower still, but each rotation costs a few
 * milliseconds of audio, where one MediaRecorder stops and the next starts.
 */
export const SEGMENT_SECONDS = 300;

export const MAX_RECORDING_SECONDS = 3 * 3600;

/**
 * Memory no longer scales with recording length, so the ceiling is about what
 * the device can sit and do rather than what it can hold: a long recording
 * still means a warm phone, a draining battery and one upload every four
 * minutes. Desktop gets the full three hours, phones a shorter run.
 */
export const maxRecordingSeconds = () => {
  const memory = navigator.deviceMemory; // GB, Chromium only
  if (memory && memory <= 4) return 60 * 60;
  const coarsePointer =
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  return coarsePointer ? 2 * 3600 : MAX_RECORDING_SECONDS;
};

/**
 * Chunk length for one upload. A 4 minute WAV is ~7.7 MB, which is a slow and
 * expensive thing to lose on a weak mobile connection, so shorten it there:
 * each request is smaller and a retry costs less.
 */
export const chunkSecondsForConnection = () => {
  const connection = navigator.connection;
  if (!connection) return CHUNK_SECONDS;
  if (connection.saveData) return 90;
  if (/(^|-)2g$/.test(connection.effectiveType || '')) return 60;
  if (connection.effectiveType === '3g') return 120;
  return CHUNK_SECONDS;
};

/** Hand the main thread back so a long encode does not freeze the UI. */
const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0));

const BYTES_PER_SAMPLE = 2;

/**
 * A decode that failed for a reason worth telling the user apart.
 *
 * `reason` is one of:
 *   'empty'        nothing was captured
 *   'unsupported'  this browser has no Web Audio at all
 *   'undecodable'  the container or codec was rejected
 *   'exhausted'    the browser ran out of memory part-way through
 */
export class AudioDecodeError extends Error {
  constructor(message, reason = 'undecodable') {
    super(message);
    this.name = 'AudioDecodeError';
    this.reason = reason;
  }
}

/** Container the current browser will actually record in. */
export function pickRecorderMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
    'audio/mpeg',
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) || '';
}

function getAudioContextClass() {
  return window.AudioContext || window.webkitAudioContext;
}

function getOfflineAudioContextClass() {
  return window.OfflineAudioContext || window.webkitOfflineAudioContext;
}

/** decodeAudioData is promise-based everywhere modern, callback-based on old Safari. */
function decodeAudioData(context, arrayBuffer) {
  return new Promise((resolve, reject) => {
    const decoded = context.decodeAudioData(arrayBuffer, resolve, reject);
    if (decoded && typeof decoded.then === 'function') decoded.then(resolve, reject);
  });
}

/**
 * A context that decodes straight to TARGET_SAMPLE_RATE where the browser
 * allows it.
 *
 * This is the single most important allocation in the file. `new
 * AudioContext()` adopts the output device's rate - 48 kHz on most machines -
 * and decodeAudioData then has to materialise the segment at that rate before
 * anything downsamples it: three times the samples, three times the memory,
 * for audio that is about to be thrown away. Asking for 16 kHz up front makes
 * the decoder resample as it goes and the large buffer never exists.
 *
 * OfflineAudioContext is tried first because it decodes without opening the
 * audio hardware. Both forms are checked against the rate the context actually
 * reports, since a browser may accept the argument and ignore it; the caller
 * resamples afterwards when that happens.
 */
function createDecodeContext() {
  const OfflineAudioContextClass = getOfflineAudioContextClass();
  if (OfflineAudioContextClass) {
    try {
      const offline = new OfflineAudioContextClass(1, 1, TARGET_SAMPLE_RATE);
      if (
        offline.sampleRate === TARGET_SAMPLE_RATE &&
        typeof offline.decodeAudioData === 'function'
      ) {
        return offline;
      }
    } catch (err) {
      // Some Safari builds refuse non-standard offline sample rates.
    }
  }

  const AudioContextClass = getAudioContextClass();
  if (!AudioContextClass) return null;

  try {
    const context = new AudioContextClass({ sampleRate: TARGET_SAMPLE_RATE });
    if (context.sampleRate === TARGET_SAMPLE_RATE) return context;
    context.close?.();
  } catch (err) {
    // Older browsers take no options object.
  }
  return new AudioContextClass();
}

/** Tell "the browser gave up on this data" apart from "the browser ran out of room". */
function classifyDecodeFailure(err) {
  const name = err?.name || '';
  const message = String(err?.message || err || '');
  if (name === 'RangeError' || /allocation failed|out of memory|array buffer/i.test(message)) {
    return 'exhausted';
  }
  return 'undecodable';
}

function mixToMono(audioBuffer) {
  const { numberOfChannels, length } = audioBuffer;
  if (numberOfChannels === 1) return audioBuffer.getChannelData(0);

  const mono = new Float32Array(length);
  for (let channel = 0; channel < numberOfChannels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) mono[i] += data[i];
  }
  for (let i = 0; i < length; i += 1) mono[i] /= numberOfChannels;
  return mono;
}

/** Linear-interpolation resampler, used only when OfflineAudioContext is unavailable. */
function resampleLinear(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const next = index + 1 < samples.length ? samples[index + 1] : samples[index];
    out[i] = samples[index] * (1 - fraction) + next * fraction;
  }
  return out;
}

/** Decode one recording segment into mono Float32 samples at TARGET_SAMPLE_RATE. */
export async function decodeToMono16k(blob) {
  const context = createDecodeContext();
  if (!context) throw new AudioDecodeError('This browser cannot process audio.', 'unsupported');

  let decoded;
  try {
    const arrayBuffer = await blob.arrayBuffer();
    if (!arrayBuffer.byteLength) throw new AudioDecodeError('The recording is empty.', 'empty');
    decoded = await decodeAudioData(context, arrayBuffer);
  } catch (err) {
    if (err instanceof AudioDecodeError) throw err;
    throw new AudioDecodeError(
      'The recording could not be decoded by this browser.',
      classifyDecodeFailure(err),
    );
  } finally {
    context.close?.();
  }

  if (!decoded.length) throw new AudioDecodeError('The recording is empty.', 'empty');
  if (decoded.sampleRate === TARGET_SAMPLE_RATE) return mixToMono(decoded);

  // Only reached when the browser ignored the requested rate.
  const OfflineAudioContextClass = getOfflineAudioContextClass();
  const frames = Math.ceil((decoded.length * TARGET_SAMPLE_RATE) / decoded.sampleRate);

  if (OfflineAudioContextClass && frames > 0) {
    try {
      const offline = new OfflineAudioContextClass(1, frames, TARGET_SAMPLE_RATE);
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start(0);
      const rendered = await offline.startRendering();
      return rendered.getChannelData(0);
    } catch (err) {
      // Some Safari builds refuse non-standard offline sample rates.
    }
  }
  return resampleLinear(mixToMono(decoded), decoded.sampleRate, TARGET_SAMPLE_RATE);
}

/** Wrap Float32 samples in a 16-bit PCM WAV container. */
export function encodeWav(samples, sampleRate = TARGET_SAMPLE_RATE) {
  const dataBytes = samples.length * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 8 * BYTES_PER_SAMPLE, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += BYTES_PER_SAMPLE;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Pick a cut point near `idealEnd` that falls in the quietest moment, so a
 * chunk boundary lands between words instead of through one.
 */
export function findQuietCut(samples, idealEnd, searchSeconds = 12) {
  const searchSamples = Math.min(Math.floor(searchSeconds * TARGET_SAMPLE_RATE), idealEnd - 1);
  if (searchSamples <= 0) return idealEnd;

  const windowSize = Math.floor(0.2 * TARGET_SAMPLE_RATE);
  const hop = Math.floor(windowSize / 2);
  const searchStart = idealEnd - searchSamples;

  let quietestEnergy = Infinity;
  let quietestCut = idealEnd;

  for (let start = searchStart; start + windowSize <= idealEnd; start += hop) {
    let energy = 0;
    for (let i = start; i < start + windowSize; i += 4) energy += samples[i] * samples[i];
    if (energy < quietestEnergy) {
      quietestEnergy = energy;
      quietestCut = start + Math.floor(windowSize / 2);
    }
  }
  return quietestCut;
}

/**
 * Yield WAV chunks of at most `chunkSeconds` from one or more capture segments.
 *
 * Each segment is decoded only when its turn comes and is released as soon as
 * it has been emitted, so a three hour recording costs no more memory than a
 * five minute one. Audio left at the end of a segment is carried into the next
 * one, so a segment boundary does not show up as a stub chunk mid-sentence.
 *
 * Consume it with `for await`; the caller is expected to upload each chunk
 * before asking for the next, which is also what keeps encoded WAVs from
 * piling up.
 */
export async function* streamWavChunks(source, { chunkSeconds } = {}) {
  const segments = (Array.isArray(source) ? source : [source]).filter(Boolean);
  if (!segments.length) throw new AudioDecodeError('The recording is empty.', 'empty');

  const seconds = chunkSeconds || chunkSecondsForConnection();
  const chunkSamples = Math.max(1, Math.floor(seconds * TARGET_SAMPLE_RATE));
  let carry = null;
  let index = 0;

  for (let segment = 0; segment < segments.length; segment += 1) {
    let samples = await decodeToMono16k(segments[segment]);

    if (carry && carry.length) {
      const joined = new Float32Array(carry.length + samples.length);
      joined.set(carry, 0);
      joined.set(samples, carry.length);
      samples = joined;
      carry = null;
    }

    const isLast = segment === segments.length - 1;
    let start = 0;

    while (samples.length - start >= chunkSamples || (isLast && start < samples.length)) {
      let end = Math.min(start + chunkSamples, samples.length);
      // Only hunt for a quiet boundary when there is more audio after this chunk.
      if (end < samples.length) end = findQuietCut(samples, end);
      // encodeWav copies into its own buffer, so a view is enough here.
      const slice = samples.subarray(start, end);
      index += 1;
      yield { blob: encodeWav(slice), seconds: slice.length / TARGET_SAMPLE_RATE, index };
      start = end;
      // encodeWav walks every sample synchronously; on a phone a long recording
      // would otherwise lock the interface for seconds at a time.
      await yieldToUI();
    }

    // A copy, not a view: a view would pin the whole decoded segment in memory.
    carry = isLast || start >= samples.length ? null : samples.slice(start);
  }
}

/**
 * Collect every chunk at once. Convenient for short recordings and for tests;
 * prefer `streamWavChunks` anywhere the length is not known to be small.
 */
export async function toWavChunks(source, chunkSeconds = chunkSecondsForConnection()) {
  const chunks = [];
  for await (const chunk of streamWavChunks(source, { chunkSeconds })) chunks.push(chunk);
  return chunks;
}

/** Roughly how many chunks `seconds` of audio will produce, for a progress bar. */
export const estimateChunkCount = (seconds, chunkSeconds) =>
  Math.max(1, Math.ceil((seconds || 0) / (chunkSeconds || chunkSecondsForConnection())));

export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

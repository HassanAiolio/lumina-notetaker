/**
 * Browser audio -> WAV chunks the transcription API can accept.
 *
 * MediaRecorder hands us WebM/Opus on Chrome and MP4/AAC on Safari, and the
 * speech model is only documented for WAV/MP3/OGG/FLAC/AAC/AIFF. Rather than
 * bet on container support, we decode locally and re-encode to 16 kHz mono
 * PCM, which every speech model accepts and which is also the rate they
 * downsample to anyway.
 */

export const TARGET_SAMPLE_RATE = 16000;
// 4 minutes of 16 kHz mono PCM is about 7.7 MB, comfortably inside the
// request ceiling once base64 encoding has inflated it by a third.
export const CHUNK_SECONDS = 240;
export const MAX_RECORDING_SECONDS = 3600;

const BYTES_PER_SAMPLE = 2;

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

/** decodeAudioData is promise-based everywhere modern, callback-based on old Safari. */
function decodeAudioData(context, arrayBuffer) {
  return new Promise((resolve, reject) => {
    const decoded = context.decodeAudioData(arrayBuffer, resolve, reject);
    if (decoded && typeof decoded.then === 'function') decoded.then(resolve, reject);
  });
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

/** Decode any recorded blob into mono Float32 samples at TARGET_SAMPLE_RATE. */
export async function decodeToMono16k(blob) {
  const AudioContextClass = getAudioContextClass();
  if (!AudioContextClass) throw new Error('This browser cannot process audio.');

  const arrayBuffer = await blob.arrayBuffer();
  if (!arrayBuffer.byteLength) throw new Error('The recording is empty.');

  const context = new AudioContextClass();
  let decoded;
  try {
    decoded = await decodeAudioData(context, arrayBuffer);
  } catch (err) {
    throw new Error('The recording could not be decoded by this browser.');
  } finally {
    context.close?.();
  }

  if (!decoded.length) throw new Error('The recording is empty.');
  if (decoded.sampleRate === TARGET_SAMPLE_RATE) return mixToMono(decoded);

  const OfflineAudioContextClass = window.OfflineAudioContext || window.webkitOfflineAudioContext;
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
 * Split a recording into WAV chunks of at most `chunkSeconds`.
 * Returns [{ blob, seconds }] in playback order.
 */
export async function toWavChunks(blob, chunkSeconds = CHUNK_SECONDS) {
  const samples = await decodeToMono16k(blob);
  const chunkSamples = Math.floor(chunkSeconds * TARGET_SAMPLE_RATE);
  const chunks = [];

  let start = 0;
  while (start < samples.length) {
    let end = Math.min(start + chunkSamples, samples.length);
    // Only hunt for a quiet boundary when there is more audio after this chunk.
    if (end < samples.length) end = findQuietCut(samples, end);
    const slice = samples.subarray(start, end);
    chunks.push({
      blob: encodeWav(slice),
      seconds: slice.length / TARGET_SAMPLE_RATE,
    });
    start = end;
  }

  return chunks.length ? chunks : [{ blob: encodeWav(samples), seconds: 0 }];
}

export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

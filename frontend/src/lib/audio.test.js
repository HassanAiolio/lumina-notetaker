/**
 * The audio pipeline, exercised against a fake Web Audio implementation.
 *
 * The cases that matter here are the ones that used to fail silently on a long
 * recording: decoding at the output device's rate instead of the target rate,
 * and holding every decoded sample at once. Both are asserted directly, so a
 * revert shows up as a failing test rather than as a browser that gives up an
 * hour into a meeting.
 */
import {
  AudioDecodeError,
  SEGMENT_SECONDS,
  TARGET_SAMPLE_RATE,
  decodeToMono16k,
  encodeWav,
  estimateChunkCount,
  findQuietCut,
  formatDuration,
  streamWavChunks,
  toWavChunks,
} from './audio';

const CHUNK_SECONDS = 240;

class FakeAudioBuffer {
  constructor(length, sampleRate, numberOfChannels = 1, fill = 0.25) {
    this.length = length;
    this.sampleRate = sampleRate;
    this.numberOfChannels = numberOfChannels;
    this._channels = Array.from({ length: numberOfChannels }, () => {
      const data = new Float32Array(length);
      data.fill(fill);
      return data;
    });
  }

  getChannelData(channel = 0) {
    return this._channels[channel];
  }
}

/** Everything the fake contexts recorded during one test. */
let audio;

/**
 * @param offlineRates  sample rates OfflineAudioContext will accept
 * @param deviceRate    rate a plain AudioContext falls back to
 * @param decode        (contextRate) => FakeAudioBuffer | throws
 */
function installWebAudio({ offlineRates = [TARGET_SAMPLE_RATE], deviceRate = 48000, decode } = {}) {
  audio = {
    decodeCalls: [],
    offlineConstructions: [],
    audioContextConstructions: [],
    renderCalls: 0,
    liveBuffers: 0,
    peakLiveBuffers: 0,
  };

  const decodeFn =
    decode ||
    ((contextRate) => new FakeAudioBuffer(Math.round(1 * contextRate), contextRate));

  const track = (buffer) => {
    audio.liveBuffers += 1;
    audio.peakLiveBuffers = Math.max(audio.peakLiveBuffers, audio.liveBuffers);
    return buffer;
  };

  class FakeOfflineAudioContext {
    constructor(channels, length, sampleRate) {
      if (!offlineRates.includes(sampleRate)) {
        throw new Error(`offline rate ${sampleRate} refused`);
      }
      audio.offlineConstructions.push({ channels, length, sampleRate });
      this.sampleRate = sampleRate;
      this.length = length;
      this.destination = {};
    }

    decodeAudioData(arrayBuffer) {
      audio.decodeCalls.push({ contextRate: this.sampleRate, bytes: arrayBuffer.byteLength });
      return Promise.resolve().then(() => track(decodeFn(this.sampleRate)));
    }

    createBufferSource() {
      return { buffer: null, connect() {}, start() {} };
    }

    startRendering() {
      audio.renderCalls += 1;
      return Promise.resolve(track(new FakeAudioBuffer(this.length, this.sampleRate)));
    }
  }

  class FakeAudioContext {
    constructor(options) {
      const requested = options?.sampleRate;
      audio.audioContextConstructions.push(requested);
      // A browser that honours the option reports the rate back; one that does
      // not silently keeps the device rate, which is what used to happen.
      this.sampleRate = requested && offlineRates.includes(requested) ? requested : deviceRate;
    }

    decodeAudioData(arrayBuffer) {
      audio.decodeCalls.push({ contextRate: this.sampleRate, bytes: arrayBuffer.byteLength });
      return Promise.resolve().then(() => track(decodeFn(this.sampleRate)));
    }

    close() {}
  }

  window.OfflineAudioContext = FakeOfflineAudioContext;
  window.AudioContext = FakeAudioContext;
  delete window.webkitOfflineAudioContext;
  delete window.webkitAudioContext;
}

/** A stand-in for a recorded segment; only `arrayBuffer()` is ever called. */
const fakeSegment = (bytes = 4096) => ({
  size: bytes,
  type: 'audio/webm',
  arrayBuffer: () => Promise.resolve(new ArrayBuffer(bytes)),
});

/** A decoder that hands back exactly `seconds` of audio at the context rate. */
const decoderOf = (seconds) => (contextRate) =>
  new FakeAudioBuffer(Math.round(seconds * contextRate), contextRate);

/** jsdom 16 has no Blob.arrayBuffer, so fall back to FileReader. */
const readBlob = (blob) =>
  typeof blob.arrayBuffer === 'function'
    ? blob.arrayBuffer()
    : new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(blob);
      });

afterEach(() => {
  delete window.OfflineAudioContext;
  delete window.AudioContext;
});

describe('decodeToMono16k', () => {
  it('decodes straight to 16 kHz instead of the device rate', async () => {
    installWebAudio({ decode: decoderOf(10) });

    const samples = await decodeToMono16k(fakeSegment());

    // The whole point of the fix: nothing is ever materialised at 48 kHz.
    expect(audio.decodeCalls).toHaveLength(1);
    expect(audio.decodeCalls[0].contextRate).toBe(TARGET_SAMPLE_RATE);
    expect(audio.renderCalls).toBe(0); // no second pass to resample
    expect(samples.length).toBe(10 * TARGET_SAMPLE_RATE);
  });

  it('prefers OfflineAudioContext so decoding never opens the audio hardware', async () => {
    installWebAudio({ decode: decoderOf(5) });

    await decodeToMono16k(fakeSegment());

    expect(audio.offlineConstructions[0]).toMatchObject({ sampleRate: TARGET_SAMPLE_RATE });
    expect(audio.audioContextConstructions).toHaveLength(0);
  });

  it('asks a plain AudioContext for 16 kHz when OfflineAudioContext refuses', async () => {
    installWebAudio({ offlineRates: [], deviceRate: 48000, decode: decoderOf(5) });

    await decodeToMono16k(fakeSegment());

    expect(audio.audioContextConstructions[0]).toBe(TARGET_SAMPLE_RATE);
  });

  it('resamples when the browser accepts the rate request but ignores it', async () => {
    // Neither context honours 16 kHz, so decoding lands at 48 kHz and the old
    // render-based resample has to run. Still correct, just more expensive.
    installWebAudio({ offlineRates: [44100], deviceRate: 44100, decode: decoderOf(3) });

    const samples = await decodeToMono16k(fakeSegment());

    expect(audio.decodeCalls[0].contextRate).toBe(44100);
    expect(samples.length).toBe(3 * TARGET_SAMPLE_RATE);
  });

  it('mixes a stereo decode down to mono', async () => {
    installWebAudio({
      decode: (rate) => new FakeAudioBuffer(rate, rate, 2, 0.5),
    });

    const samples = await decodeToMono16k(fakeSegment());

    expect(samples.length).toBe(TARGET_SAMPLE_RATE);
    expect(samples[0]).toBeCloseTo(0.5, 5);
  });
});

describe('decode failures', () => {
  it('reports an empty upload as empty, not as a browser problem', async () => {
    installWebAudio();
    await expect(decodeToMono16k(fakeSegment(0))).rejects.toMatchObject({
      name: 'AudioDecodeError',
      reason: 'empty',
    });
  });

  it('reports a missing Web Audio implementation as unsupported', async () => {
    installWebAudio();
    delete window.OfflineAudioContext;
    delete window.AudioContext;

    await expect(decodeToMono16k(fakeSegment())).rejects.toMatchObject({ reason: 'unsupported' });
  });

  it('separates running out of memory from a codec it cannot read', async () => {
    installWebAudio({
      decode: () => {
        throw new RangeError('Array buffer allocation failed');
      },
    });
    await expect(decodeToMono16k(fakeSegment())).rejects.toMatchObject({ reason: 'exhausted' });

    installWebAudio({
      decode: () => {
        const err = new Error('Unable to decode audio data');
        err.name = 'EncodingError';
        throw err;
      },
    });
    await expect(decodeToMono16k(fakeSegment())).rejects.toMatchObject({ reason: 'undecodable' });
  });

  it('is an AudioDecodeError, so callers can tell it from a network failure', async () => {
    installWebAudio({
      decode: () => {
        throw new Error('nope');
      },
    });
    await expect(decodeToMono16k(fakeSegment())).rejects.toBeInstanceOf(AudioDecodeError);
  });
});

describe('encodeWav', () => {
  it('writes a 16-bit mono PCM header at the target rate', async () => {
    const blob = encodeWav(new Float32Array(1000));
    const view = new DataView(await readBlob(blob));
    const ascii = (offset) =>
      String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(offset + i)));

    expect(ascii(0)).toBe('RIFF');
    expect(ascii(8)).toBe('WAVE');
    expect(ascii(36)).toBe('data');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(TARGET_SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(40, true)).toBe(2000); // 1000 samples, 2 bytes each
    expect(blob.size).toBe(44 + 2000);
  });

  it('clamps samples outside [-1, 1] instead of wrapping them', async () => {
    const blob = encodeWav(Float32Array.from([2, -2]));
    const view = new DataView(await readBlob(blob));
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
  });
});

describe('findQuietCut', () => {
  it('moves the boundary to the quietest moment before it', () => {
    const samples = new Float32Array(20 * TARGET_SAMPLE_RATE).fill(0.8);
    const silenceAt = 14 * TARGET_SAMPLE_RATE;
    samples.fill(0, silenceAt, silenceAt + TARGET_SAMPLE_RATE);

    const cut = findQuietCut(samples, 20 * TARGET_SAMPLE_RATE, 12);

    expect(cut).toBeGreaterThanOrEqual(silenceAt);
    expect(cut).toBeLessThanOrEqual(silenceAt + TARGET_SAMPLE_RATE);
  });

  it('leaves the boundary alone when there is nothing to search', () => {
    expect(findQuietCut(new Float32Array(10), 0)).toBe(0);
  });
});

describe('streamWavChunks', () => {
  const totalSeconds = (chunks) => chunks.reduce((sum, chunk) => sum + chunk.seconds, 0);

  // These run every sample through the real WAV encoder, so they are kept
  // deliberately short; the three hour case below covers the real durations.
  it('splits one segment into chunks that add back up to the original', async () => {
    installWebAudio({ decode: decoderOf(150) });

    const chunks = await toWavChunks([fakeSegment()], 40);

    expect(chunks.length).toBeGreaterThan(1);
    expect(totalSeconds(chunks)).toBeCloseTo(150, 3);
    chunks.forEach((chunk) => expect(chunk.seconds).toBeLessThanOrEqual(40.001));
  }, 30000);

  it('loses no audio across a segment boundary', async () => {
    installWebAudio({ decode: decoderOf(50) });

    const segments = [fakeSegment(), fakeSegment(), fakeSegment()];
    const chunks = await toWavChunks(segments, 40);

    expect(totalSeconds(chunks)).toBeCloseTo(150, 3);
  }, 30000);

  it('carries a segment tail forward instead of emitting a stub per segment', async () => {
    installWebAudio({ decode: decoderOf(50) });

    // Six segments that are not a whole number of chunks long. Without
    // carry-over every one of them would end in a stub; with it, only the very
    // last chunk of the recording is short. Kept small because every sample
    // here is really encoded into a WAV.
    const segments = Array.from({ length: 6 }, () => fakeSegment());
    const chunks = await toWavChunks(segments, 40);

    const short = chunks.filter((chunk) => chunk.seconds < 20);
    expect(short.length).toBeLessThanOrEqual(1);
    expect(totalSeconds(chunks)).toBeCloseTo(300, 3);
  });

  it('numbers chunks in playback order', async () => {
    installWebAudio({ decode: decoderOf(50) });

    const chunks = await toWavChunks([fakeSegment(), fakeSegment()], 40);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, i) => i + 1));
  });

  it('decodes lazily, so an unconsumed recording costs nothing', async () => {
    installWebAudio({ decode: decoderOf(50) });

    const segments = Array.from({ length: 10 }, () => fakeSegment());
    const iterator = streamWavChunks(segments, { chunkSeconds: 40 });

    expect(audio.decodeCalls).toHaveLength(0); // nothing happens until it is pulled

    await iterator.next();
    expect(audio.decodeCalls).toHaveLength(1);

    await iterator.next();
    expect(audio.decodeCalls.length).toBeLessThanOrEqual(2);
    expect(audio.decodeCalls.length).toBeLessThan(segments.length);

    await iterator.return();
  });

  it('refuses a recording with no segments', async () => {
    installWebAudio();
    const iterator = streamWavChunks([]);
    await expect(iterator.next()).rejects.toMatchObject({ reason: 'empty' });
  });

  it('accepts a single blob as well as a list', async () => {
    installWebAudio({ decode: decoderOf(30) });
    const chunks = await toWavChunks(fakeSegment(), CHUNK_SECONDS);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].seconds).toBeCloseTo(30, 3);
  });
});

describe('a three hour recording', () => {
  // The case that started all of this. Three hours is 36 segments; the old
  // pipeline decoded the lot into one 691 MB array before emitting anything.
  const SEGMENTS = (3 * 3600) / SEGMENT_SECONDS;

  it('streams the whole thing with only one segment decoded at a time', async () => {
    installWebAudio({ decode: decoderOf(SEGMENT_SECONDS) });

    const segments = Array.from({ length: SEGMENTS }, () => fakeSegment());
    let chunkCount = 0;
    let seconds = 0;
    let maxDecodedAhead = 0;

    for await (const chunk of streamWavChunks(segments, { chunkSeconds: CHUNK_SECONDS })) {
      chunkCount += 1;
      seconds += chunk.seconds;
      // A consumer uploads each chunk before pulling the next, so the decoder
      // must never be more than one segment ahead of what has been emitted.
      audio.liveBuffers = 0;
      maxDecodedAhead = Math.max(maxDecodedAhead, audio.peakLiveBuffers);
      audio.peakLiveBuffers = 0;
    }

    expect(SEGMENTS).toBe(36);
    expect(seconds).toBeCloseTo(3 * 3600, 2); // no audio lost over three hours
    expect(chunkCount).toBeGreaterThan(40);
    expect(chunkCount).toBeLessThan(60);
    expect(maxDecodedAhead).toBeLessThanOrEqual(1);
  }, 180000);
});

describe('estimateChunkCount', () => {
  it('estimates the progress total from the recorded length', () => {
    expect(estimateChunkCount(0)).toBe(1);
    expect(estimateChunkCount(240)).toBe(1);
    expect(estimateChunkCount(241)).toBe(2);
    expect(estimateChunkCount(3 * 3600)).toBe(45);
  });
});

describe('formatDuration', () => {
  it('shows hours once a recording runs past one', () => {
    expect(formatDuration(59)).toBe('0:59');
    expect(formatDuration(600)).toBe('10:00');
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(3 * 3600 + 61)).toBe('3:01:01');
  });
});

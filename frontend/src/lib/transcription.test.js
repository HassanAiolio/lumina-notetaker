/**
 * The chunk-by-chunk transcription loop, with the audio pipeline faked out:
 * what matters here is the bookkeeping - context, resume point, retries and
 * cancellation - not the encoding, which audio.test.js covers.
 */
import { freshProgress, transcribeSegments } from './transcription';

// A plain function, not jest.fn: CRA resets mock implementations before each test.
jest.mock('./audio', () => ({
  // Five chunks, honouring skipChunks the way the real one does.
  async *streamWavChunks(_segments, { skipChunks = 0 } = {}) {
    for (let index = skipChunks + 1; index <= 5; index += 1) {
      yield { blob: { index }, seconds: 40, index };
    }
  },
}));

const reply = (text, language = 'fr') => Promise.resolve({ text, language });
const start = () => freshProgress(40);

describe('transcribeSegments', () => {
  it('sends each chunk with the text before it as context', async () => {
    const seen = [];
    const transcribe = jest.fn(({ blob, context }) => {
      seen.push(context);
      return reply(`texte ${blob.index}`);
    });
    const texts = [];

    const progress = await transcribeSegments([], {
      progress: start(),
      transcribe,
      onChunk: (text) => texts.push(text),
    });

    expect(texts).toEqual(['texte 1', 'texte 2', 'texte 3', 'texte 4', 'texte 5']);
    expect(seen).toEqual(['', 'texte 1', 'texte 2', 'texte 3', 'texte 4']);
    expect(progress).toMatchObject({ done: 5, detected: 'fr', context: 'texte 5' });
  });

  it('resumes from the chunk an earlier run stopped at', async () => {
    const transcribe = jest.fn(({ blob }) => reply(`texte ${blob.index}`));

    await transcribeSegments([], {
      progress: { ...start(), done: 3, context: 'texte 3' },
      transcribe,
    });

    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(transcribe.mock.calls[0][0].context).toBe('texte 3');
  });

  it('reports how far it got when a chunk fails', async () => {
    const transcribe = jest.fn(({ blob }) =>
      blob.index === 3 ? Promise.reject(new Error('down')) : reply(`texte ${blob.index}`),
    );

    const error = await transcribeSegments([], { progress: start(), transcribe }).catch((e) => e);

    expect(error.message).toBe('down');
    expect(error.progress).toMatchObject({ done: 2, context: 'texte 2' });
  });

  it('retries a failed chunk when asked to, and carries on', async () => {
    let failures = 1;
    const transcribe = jest.fn(({ blob }) => {
      if (blob.index === 2 && failures > 0) {
        failures -= 1;
        return Promise.reject(new Error('blip'));
      }
      return reply(`texte ${blob.index}`);
    });

    const progress = await transcribeSegments([], {
      progress: start(),
      transcribe,
      retries: 2,
      retryDelayMs: 1,
    });

    expect(progress.done).toBe(5);
    expect(transcribe).toHaveBeenCalledTimes(6);
  });

  it('does not retry an upload the server refused outright', async () => {
    const refused = Object.assign(new Error('bad audio'), { response: { status: 400 } });
    const transcribe = jest.fn(() => Promise.reject(refused));

    await expect(
      transcribeSegments([], { progress: start(), transcribe, retries: 3, retryDelayMs: 1 }),
    ).rejects.toBe(refused);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it('does not count a reply that lands after a cancel', async () => {
    const controller = new AbortController();
    const texts = [];
    const transcribe = jest.fn(({ blob }) => {
      if (blob.index === 2) controller.abort(); // cancelled while chunk 2 is in flight
      return reply(`texte ${blob.index}`);
    });

    const error = await transcribeSegments([], {
      progress: start(),
      signal: controller.signal,
      transcribe,
      onChunk: (text) => texts.push(text),
    }).catch((e) => e);

    expect(error.name).toBe('AbortError');
    expect(texts).toEqual(['texte 1']);
    expect(error.progress.done).toBe(1); // a retry redoes chunk 2, not chunk 3
  });
});

import { assembleSegments, listRecordings, loadRecording, keepRecording } from './recordingStore';

/** jsdom 16 has no Blob.text, so fall back to FileReader. */
const readText = (blob) =>
  new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsText(blob);
  });

describe('assembleSegments', () => {
  it('joins pieces into one file per segment, in order, whatever order they come back in', async () => {
    const piece = (segment, index, text) => ({ segment, piece: index, blob: new Blob([text], { type: 'audio/webm' }) });
    const segments = assembleSegments(
      [piece(1, 0, 'c'), piece(0, 1, 'b'), piece(1, 1, 'd'), piece(0, 0, 'a')],
      'audio/webm',
    );
    expect(segments).toHaveLength(2);
    expect(segments[0].type).toBe('audio/webm');
    expect(await readText(segments[0])).toBe('ab');
    expect(await readText(segments[1])).toBe('cd');
  });

  it('gives nothing back for a recording with no audio', () => {
    expect(assembleSegments([], 'audio/webm')).toEqual([]);
  });
});

describe('without IndexedDB', () => {
  // jsdom has none, like some private windows: recording must carry on regardless.
  it('keeps nothing, and fails soft', async () => {
    const keep = keepRecording({ owner: 'u1' });
    keep.add(new Blob(['x'], { type: 'audio/webm' }), 0);
    keep.chunk('hello', { done: 1 });
    await keep.close();
    expect(keep.meta.text).toBe('hello');
    expect(await listRecordings('u1')).toEqual([]);
    expect(await loadRecording(keep.id)).toBeNull();
  });
});

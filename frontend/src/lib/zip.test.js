import { TextDecoder, TextEncoder } from 'util';
import { crc32, zipBytes } from './zip';

// jsdom has no TextEncoder; the browsers the app runs in all do.
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

const encoder = new TextEncoder();

describe('crc32', () => {
  it('matches the standard check values', () => {
    expect(crc32(encoder.encode('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('zipBytes', () => {
  const files = [
    { path: 'Lumina Notes/Café.md', data: '# hi\n' },
    { path: 'Lumina Notes/attachments/p1.jpg', data: new Uint8Array([0xff, 0xd8, 0xff]) },
  ];
  const bytes = zipBytes(files, new Date(2026, 9, 12, 9, 30, 0));
  const view = new DataView(bytes.buffer);

  it('lays out local headers, the central directory and its end record', () => {
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const end = bytes.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);

    const centralSize = view.getUint32(end + 12, true);
    const centralStart = view.getUint32(end + 16, true);
    expect(centralStart + centralSize).toBe(end);
    expect(view.getUint32(centralStart, true)).toBe(0x02014b50);
  });

  it('stores each file whole, with its UTF-8 name and checksum', () => {
    const name = encoder.encode(files[0].path);
    expect(view.getUint16(6, true)).toBe(0x0800);
    expect(view.getUint32(14, true)).toBe(crc32(encoder.encode('# hi\n')));
    expect(view.getUint32(18, true)).toBe(5);
    expect(view.getUint16(26, true)).toBe(name.length);
    expect(new TextDecoder().decode(bytes.slice(30, 30 + name.length))).toBe(files[0].path);
    expect(new TextDecoder().decode(bytes.slice(30 + name.length, 35 + name.length))).toBe('# hi\n');
  });

  it('points the central directory at the second file', () => {
    const end = bytes.length - 22;
    const centralStart = view.getUint32(end + 16, true);
    const firstName = encoder.encode(files[0].path).length;
    const secondEntry = centralStart + 46 + firstName;
    expect(view.getUint32(secondEntry, true)).toBe(0x02014b50);
    expect(view.getUint32(secondEntry + 42, true)).toBe(30 + firstName + 5);
  });
});

/**
 * Inline formatting in a bullet.
 *
 * Models emit Markdown whether or not the prompt asked for it, and rendering a
 * bullet as raw text turned "**like this**" into visible asterisks. These pin
 * down both halves: emphasis that is handled renders, and anything else is left
 * exactly as written rather than silently eaten.
 */
import { inlineRuns, stripInline } from './notes';

const plain = (text) => inlineRuns(text).map((r) => r.text).join('');

describe('inlineRuns', () => {
  it('pulls bold out of a sentence', () => {
    expect(inlineRuns('**Chaine de pensee** : une strategie')).toEqual([
      { key: 1, text: 'Chaine de pensee', bold: true },
      { key: 2, text: ' : une strategie' },
    ]);
  });

  it('handles italic, code and underscores', () => {
    expect(inlineRuns('run `npm test` now')[1]).toMatchObject({ text: 'npm test', code: true });
    expect(inlineRuns('a *stress* test')[1]).toMatchObject({ text: 'stress', italic: true });
    expect(inlineRuns('__aussi gras__')[0]).toMatchObject({ text: 'aussi gras', bold: true });
  });

  it('leaves ordinary text completely alone', () => {
    const text = "L'IA a ete entrainee pour maximiser son score (2 * 3 = 6).";
    expect(inlineRuns(text)).toEqual([{ key: 1, text }]);
  });

  it('does not treat snake_case or a lone asterisk as emphasis', () => {
    expect(plain('the key_concepts section')).toBe('the key_concepts section');
    expect(plain('5 * 3 and a_b_c')).toBe('5 * 3 and a_b_c');
  });

  it('keeps unmatched markers rather than swallowing them', () => {
    // Better to show a stray asterisk than to lose the word after it.
    expect(plain('**not closed')).toBe('**not closed');
    expect(plain('a ** b')).toBe('a ** b');
  });

  it('survives empty and non-string input', () => {
    expect(inlineRuns('')).toEqual([]);
    expect(inlineRuns(undefined)).toEqual([]);
    expect(inlineRuns(null)).toEqual([]);
  });
});

describe('stripInline', () => {
  it('gives the plain text, for copying and previews', () => {
    expect(stripInline('**Terme** : la `def` et *plus*')).toBe('Terme : la def et plus');
  });
});

/**
 * Inline formatting in a bullet.
 *
 * Models emit Markdown whether or not the prompt asked for it, and rendering a
 * bullet as raw text turned "**like this**" into visible asterisks. These pin
 * down both halves: emphasis that is handled renders, and anything else is left
 * exactly as written rather than silently eaten.
 */
import {
  buildDeck, groupByDate, inlineRuns, mathParts, noteCounts, notePreview, splitQuestion, stripInline,
} from './notes';

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

describe('splitQuestion', () => {
  it('splits a review question from its answer', () => {
    expect(splitQuestion("Que mesure l'entropie ? → Le désordre d'un système")).toEqual({
      question: "Que mesure l'entropie ?",
      answer: "Le désordre d'un système",
    });
  });

  it('takes the first arrow, so an answer can contain one', () => {
    expect(splitQuestion('Sens de la réaction ? → A -> B')).toEqual({
      question: 'Sens de la réaction ?',
      answer: 'A -> B',
    });
  });

  it('leaves a bullet without an answer alone', () => {
    expect(splitQuestion('Une question sans réponse ?')).toBeNull();
    expect(splitQuestion(undefined)).toBeNull();
  });
});

describe('library helpers', () => {
  const note = {
    created_at: '2026-10-05T09:00:00Z',
    sections: {
      overview: ['**Thermo** : le cours entier'],
      definitions: ['**Entropie** : mesure du désordre', 'Une phrase sans terme'],
      key_concepts: ['**Deuxième principe** — l’entropie ne décroît pas'],
      review_questions: ['Que mesure l’entropie ? → Le désordre', 'Sans réponse ?'],
    },
  };

  it('previews a note by its overview, without the formatting', () => {
    expect(notePreview(note)).toBe('Thermo : le cours entier');
    expect(notePreview({ sections: { definitions: ['**A** : b'] } })).toBe('A : b');
    expect(notePreview({})).toBe('');
  });

  it('builds a deck from questions, defined terms and explained concepts', () => {
    expect(buildDeck(note)).toEqual([
      { id: 'q0', kind: 'question', front: 'Que mesure l’entropie ?', back: 'Le désordre' },
      { id: 'definitions0', kind: 'definitions', front: 'Entropie', back: 'mesure du désordre' },
      { id: 'key_concepts0', kind: 'key_concepts', front: 'Deuxième principe', back: 'l’entropie ne décroît pas' },
    ]);
  });

  it('counts points apart from questions', () => {
    expect(noteCounts(note)).toEqual({ points: 4, questions: 2, cards: 3 });
  });

  it('groups notes by how recent they are', () => {
    const now = new Date(2026, 9, 5, 18, 0);
    const at = (d) => ({ created_at: d.toISOString() });
    const groups = groupByDate(
      [at(new Date(2026, 9, 5, 9)), at(new Date(2026, 9, 4, 9)), at(new Date(2026, 9, 1, 9)), at(new Date(2026, 7, 20))],
      now,
    );
    expect(groups.map((g) => [g.label.replace(/\s+\d{4}$/, ''), g.notes.length]).slice(0, 3)).toEqual([
      ['Today', 1],
      ['Yesterday', 1],
      ['This week', 1],
    ]);
    expect(groups).toHaveLength(4);
  });
});

describe('LaTeX in bullets', () => {
  it('reads $...$ as maths, underscores and all', () => {
    const runs = inlineRuns('**Suite** : $u_{n+1} = u_n * q$ pour tout _n_');
    const math = runs.find((run) => run.math);
    expect(math).toMatchObject({ tex: 'u_{n+1} = u_n * q', display: false });
    expect(runs.find((run) => run.italic)?.text).toBe('n');
  });

  it('reads $$...$$ as a displayed equation', () => {
    expect(inlineRuns('$$\sum_{k=0}^{n} k = \frac{n(n+1)}{2}$$')[0]).toMatchObject({
      math: true,
      display: true,
      tex: '\sum_{k=0}^{n} k = \frac{n(n+1)}{2}',
    });
  });

  it('leaves prices alone', () => {
    expect(inlineRuns('Entre 50 $ et 80 $').some((run) => run.math)).toBe(false);
  });

  it('finds maths inside a bold term', () => {
    const parts = mathParts('Rendement $\eta$ de Carnot');
    expect(parts.map((part) => !!part.math)).toEqual([false, true, false]);
    expect(parts[1].tex).toBe('\eta');
  });

  it('keeps the dollars when formatting is stripped, so copied notes stay LaTeX', () => {
    expect(stripInline('**Limite** : $\frac{1}{n}$')).toBe('Limite : $\frac{1}{n}$');
  });
});

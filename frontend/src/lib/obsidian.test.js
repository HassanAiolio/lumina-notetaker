import {
  noteBaseName, obsidianTag, safeFileName, toObsidian, uniqueName,
} from './obsidian';

const note = {
  id: 'n1',
  title: 'Chapitre 3: Entropie',
  type: 'LECTURE',
  language: 'fr',
  created_at: '2026-10-12T09:30:00',
  tags: ['thermo', 'Second law', '2026'],
  labels: { overview: 'Vue d’ensemble' },
  sections: {
    overview: ['L’entropie mesure le désordre [p. 4].'],
    definitions: ['**Entropie** : $S = k_B \\ln \\Omega$ [p. 5–6]'],
    formulas: ['$$\\Delta S = \\int \\frac{\\delta Q}{T}$$'],
    review_questions: ['Unité de S ? → J/K'],
  },
  raw_transcript: 'Bonjour.\n\nOn commence.',
  slides: { name: 'cours3.pdf', cited: [4, 5, 6], hash: 'h' },
};

describe('file names', () => {
  it('drops characters Obsidian and Windows refuse', () => {
    expect(safeFileName('A/B: C? [draft] #1')).toBe('A B C draft 1');
    expect(safeFileName('...hidden')).toBe('hidden');
  });

  it('starts with the day the note was made', () => {
    expect(noteBaseName(note)).toBe('2026-10-12 Chapitre 3 Entropie');
    expect(noteBaseName({ title: '' }, new Date(2026, 0, 2))).toBe('2026-01-02 Untitled note');
  });

  it('numbers names that are already taken, ignoring case', () => {
    const taken = new Set();
    expect(uniqueName('Notes', taken)).toBe('Notes');
    expect(uniqueName('notes', taken)).toBe('notes (2)');
    expect(uniqueName('Notes', taken)).toBe('Notes (3)');
  });
});

describe('obsidianTag', () => {
  it('makes one tag of a phrase and keeps nesting', () => {
    expect(obsidianTag('Second law')).toBe('Second-law');
    expect(obsidianTag('#physics/thermo')).toBe('physics/thermo');
    expect(obsidianTag('café!')).toBe('café');
  });

  it('never leaves a tag of digits only, which Obsidian ignores', () => {
    expect(obsidianTag('2026')).toBe('_2026');
  });
});

describe('toObsidian', () => {
  const markdown = toObsidian(note, { slides: new Map([[4, 'x p4.jpg'], [5, 'x p5.jpg']]) });

  it('opens with properties', () => {
    expect(markdown.startsWith('---\naliases:\n  - "Chapitre 3: Entropie"\ndate: "2026-10-12"\n')).toBe(true);
    expect(markdown).toContain('type: "lecture"');
    expect(markdown).toContain('language: "fr"');
    expect(markdown).toContain('tags:\n  - "thermo"\n  - "Second-law"\n  - "_2026"\n  - "flashcards"');
    expect(markdown).toContain('slides: "cours3.pdf"');
    expect(markdown).toContain('lumina_id: "n1"');
  });

  it('uses the localized section names', () => {
    expect(markdown).toContain('## Vue d’ensemble\n\n- L’entropie');
  });

  it('links citations to the slide pages that came with the note', () => {
    expect(markdown).toContain('[[#p. 4|p. 4]]');
    expect(markdown).toContain('[[#p. 5|p. 5–6]]');
    expect(markdown).toContain('### p. 4\n\n![[x p4.jpg]]');
  });

  it('leaves citations as text when there are no slide pages', () => {
    const plain = toObsidian(note);
    expect(plain).toContain('[p. 4]');
    expect(plain).not.toContain('## Slides');
  });

  it('sets a displayed equation as a block, not a bullet', () => {
    expect(markdown).toContain('$$\n\\Delta S = \\int \\frac{\\delta Q}{T}\n$$');
    expect(markdown).not.toContain('- $$');
  });

  it('writes the revision deck as Spaced Repetition cards', () => {
    expect(markdown).toContain('## Flashcards\n\nUnité de S ?::J/K\nEntropie::$S = k_B \\ln \\Omega$ [[#p. 5|p. 5–6]]');
  });

  it('folds the transcript away in a callout', () => {
    expect(markdown).toContain('> [!quote]- Transcript\n> Bonjour.\n>\n> On commence.\n');
  });

  it('escapes what would break the YAML', () => {
    const tricky = toObsidian({ title: 'He said "hi"\nthen left', sections: {} });
    expect(tricky).toContain('  - "He said \\"hi\\"\\nthen left"');
    expect(tricky).not.toContain('flashcards');
  });
});

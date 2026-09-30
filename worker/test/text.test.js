// The same cases as backend/test_backend.py, so the Worker and the backend
// clean transcripts identically whichever path a chunk took.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detect, normalize } from '../src/languages.js';
import { collapseRepeats, isNoSpeech, readReply } from '../src/text.js';

test('collapses a one-word loop', () => {
  const text = `Donc forward transfert. ${'des '.repeat(500)}OK, la suite.`;
  assert.deepEqual(collapseRepeats(text), ['Donc forward transfert. des des OK, la suite.', 498]);
});

test('collapses a phrase loop, ignoring punctuation, and spares a short repeat', () => {
  const text = `Alors. ${'pas mal, '.repeat(3)}on espère que ça, ${'je veux dire. '.repeat(40)}`;
  const [cleaned, removed] = collapseRepeats(text);
  assert.ok(cleaned.endsWith('on espère que ça, je veux dire. je veux dire.'));
  assert.ok(cleaned.includes('pas mal, pas mal, pas mal,'));
  assert.equal(removed, 38 * 3);
});

test('leaves ordinary speech untouched, whitespace and all', () => {
  const text = "Euh euh euh, bon.\nOui oui, c'est c'est c'est ça. Donc donc voilà.";
  assert.deepEqual(collapseRepeats(text), [text, 0]);
  assert.deepEqual(collapseRepeats(''), ['', 0]);
  assert.deepEqual(collapseRepeats('des des des'), ['des des des', 0]);
});

test('reads every segment of a list reply', () => {
  const raw = '[{"text": "Premier bout.", "language": "fr"}, {"text": "Second bout."}]';
  assert.deepEqual(readReply(raw), ['Premier bout. Second bout.', 'fr']);
});

test('salvages a reply cut off mid-string', () => {
  assert.deepEqual(readReply('{"text": "c\'est aussi deux indicateurs des des des'), [
    "c'est aussi deux indicateurs des des des",
    null,
  ]);
});

test('salvages unescaped quotes', () => {
  const raw = '{"text": "dire "Je ne veux pas" grosso modo", "language": "fr"}';
  assert.deepEqual(readReply(raw), ['dire "Je ne veux pas" grosso modo', 'fr']);
});

test('reads fenced JSON and keeps bare text', () => {
  assert.deepEqual(readReply('```json\n{"text": "Bonjour.", "language": "fr"}\n```'), ['Bonjour.', 'fr']);
  assert.deepEqual(readReply('Juste du texte.'), ['Juste du texte.', null]);
});

test('recognises replies that mean silence', () => {
  assert.ok(isNoSpeech('[no speech]'));
  assert.ok(isNoSpeech('Aucun son audible.'));
  assert.ok(!isNoSpeech("Pas de souci, on continue avec l'exercice suivant."));
});

test('normalises codes and names, and detects French', () => {
  assert.equal(normalize('fr-FR'), 'fr');
  assert.equal(normalize('french'), 'fr');
  assert.equal(normalize('klingon'), 'auto');
  assert.equal(detect("Donc on va voir que les modèles sont dans une situation qui est plus difficile pour nous"), 'fr');
});

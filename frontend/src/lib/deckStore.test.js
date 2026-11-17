import { clearDecks, currentDeck, forgetCurrentDeck, loadDeckFile, rememberCurrentDeck, saveDeck } from './deckStore';

beforeEach(() => window.localStorage.clear());

it('remembers which slides are attached, per account', () => {
  rememberCurrentDeck('abc', 'u1');
  expect(currentDeck('u1')).toBe('abc');
  expect(currentDeck('u2')).toBeNull(); // someone else signed in on this browser
  forgetCurrentDeck();
  expect(currentDeck('u1')).toBeNull();
});

it('fails soft without IndexedDB, as in some private windows', async () => {
  // jsdom has none: slides then last as long as the tab, and nothing throws.
  await saveDeck({ file: new Blob(['%PDF']), hash: 'abc', name: 'cours.pdf' }, 'u1');
  expect(await loadDeckFile('abc')).toBeNull();
  rememberCurrentDeck('abc', 'u1');
  await clearDecks();
  expect(currentDeck('u1')).toBeNull();
});

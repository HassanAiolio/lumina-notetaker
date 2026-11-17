/**
 * Slides (PDFs) kept on this device, in IndexedDB.
 *
 * A deck used to live only in the tab's memory: a reload dropped it, a
 * recording finished later on had lost its slides, and a note the server
 * finished after the tab closed never got the pictures of the pages it cites -
 * those are drawn from the PDF, here. Now the file is kept, by its hash, so:
 *
 *   - the slides attached in the recorder are still attached after a reload
 *   - a recording kept on the device remembers its deck (meta.deckHash)
 *   - when a note is ready, whenever that is, its cited pages are drawn from
 *     the kept deck and stored with the note
 *
 * The PDF itself still never leaves the device. Every call fails soft: no
 * IndexedDB just means slides last as long as the tab, as before.
 */

const DB_NAME = 'lumina-slides';
const DB_VERSION = 1;
const DECKS = 'decks';
const CURRENT_KEY = 'lumina.deck';

/** How many decks are kept, and for how long - longer than recordings (14 days). */
export const KEEP_DECKS = 6;
export const KEEP_DECK_DAYS = 30;

let dbPromise = null;

const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

const openDb = () => {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(DECKS)) req.result.createObjectStore(DECKS, { keyPath: 'hash' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (err) {
      resolve(null);
    }
  });
  return dbPromise;
};

const allDecks = async (db) => request(db.transaction(DECKS).objectStore(DECKS).getAll());

/** Keep a deck's file, and make room by dropping the oldest. */
export const saveDeck = async ({ file, hash, name }, owner = '') => {
  if (!file || !hash) return;
  try {
    const db = await openDb();
    if (!db) return;
    const cutoff = Date.now() - KEEP_DECK_DAYS * 24 * 3600 * 1000;
    const stale = (await allDecks(db))
      .filter((deck) => deck.hash !== hash)
      .sort((a, b) => b.savedAt - a.savedAt)
      .filter((deck, index) => index >= KEEP_DECKS - 1 || deck.savedAt < cutoff);
    const tx = db.transaction(DECKS, 'readwrite');
    const store = tx.objectStore(DECKS);
    stale.forEach((deck) => store.delete(deck.hash));
    store.put({ hash, name: name || file.name || 'slides.pdf', owner, savedAt: Date.now(), file });
    await done(tx);
  } catch (err) {
    /* nothing kept: slides last as long as the tab */
  }
};

/** The kept PDF for `hash`, as a File ready for openDeck, or null. */
export const loadDeckFile = async (hash) => {
  if (!hash) return null;
  try {
    const db = await openDb();
    if (!db) return null;
    const deck = await request(db.transaction(DECKS).objectStore(DECKS).get(hash));
    if (!deck?.file) return null;
    return new File([deck.file], deck.name, { type: 'application/pdf' });
  } catch (err) {
    return null;
  }
};

/** Every kept deck - used on sign-out. */
export const clearDecks = async () => {
  forgetCurrentDeck();
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction(DECKS, 'readwrite');
    tx.objectStore(DECKS).clear();
    await done(tx);
  } catch (err) {
    /* nothing more to do */
  }
};

/** The deck attached in the recorder, remembered across reloads by its hash. */
export const rememberCurrentDeck = (hash, owner = '') => {
  try {
    window.localStorage.setItem(CURRENT_KEY, JSON.stringify({ hash, owner }));
  } catch (err) {
    /* storage unavailable */
  }
};

export const currentDeck = (owner = '') => {
  try {
    const saved = JSON.parse(window.localStorage.getItem(CURRENT_KEY) || 'null');
    return saved?.hash && (!owner || !saved.owner || saved.owner === owner) ? saved.hash : null;
  } catch (err) {
    return null;
  }
};

export function forgetCurrentDeck() {
  try {
    window.localStorage.removeItem(CURRENT_KEY);
  } catch (err) {
    /* storage unavailable */
  }
}

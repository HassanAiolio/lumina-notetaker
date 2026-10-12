/**
 * Recordings kept on this device, in IndexedDB.
 *
 * Audio used to live only in memory, so a reload, a crash, a misclicked
 * Discard or simply starting the next recording lost it for good - and with it
 * any lecture that could not be given again. Now every second of audio is
 * written here as it is captured, together with the text transcribed from it
 * and how far transcription got. Nothing here is ever uploaded: a recording
 * can be transcribed again, or picked up where it stopped, without the
 * network seeing anything twice.
 *
 * Audio is stored in pieces - whatever the recorder handed over since the last
 * write - keyed by recording, segment and piece. A segment's pieces joined in
 * order are that segment's file, so a recording cut off mid-segment still
 * leaves everything up to its last write.
 *
 * Every call fails soft. Private windows, a full disk or a browser without
 * IndexedDB just mean nothing is kept; recording itself never depends on it.
 */

const DB_NAME = 'lumina-recordings';
const DB_VERSION = 1;
const RECORDINGS = 'recordings';
const PIECES = 'pieces';

/** How many recordings are kept, and for how long. */
export const KEEP_RECORDINGS = 3;
export const KEEP_DAYS = 14;

/** How long new audio or text waits before it is written. */
const FLUSH_MS = 5000;

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
        const db = req.result;
        if (!db.objectStoreNames.contains(RECORDINGS)) db.createObjectStore(RECORDINGS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(PIECES)) db.createObjectStore(PIECES, { keyPath: ['id', 'segment', 'piece'] });
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

/** Every key range for one recording's pieces, in segment and piece order. */
const piecesOf = (id) => IDBKeyRange.bound([id, 0, 0], [id, Infinity, Infinity]);

/** Join stored pieces back into one file per segment, in order. */
export const assembleSegments = (pieces, type) => {
  const bySegment = new Map();
  [...pieces]
    .sort((a, b) => a.segment - b.segment || a.piece - b.piece)
    .forEach(({ segment, blob }) => {
      if (!bySegment.has(segment)) bySegment.set(segment, []);
      bySegment.get(segment).push(blob);
    });
  return [...bySegment.values()].map((blobs) => new Blob(blobs, { type: type || blobs[0]?.type || 'audio/webm' }));
};

/** The stored recordings that belong to `owner`, newest first. */
export const listRecordings = async (owner) => {
  try {
    const db = await openDb();
    if (!db) return [];
    const all = await request(db.transaction(RECORDINGS).objectStore(RECORDINGS).getAll());
    return all
      .filter((meta) => !owner || meta.owner === owner)
      .sort((a, b) => b.startedAt - a.startedAt);
  } catch (err) {
    return [];
  }
};

/** A stored recording with its audio, shaped like a fresh one from the recorder. */
export const loadRecording = async (id) => {
  try {
    const db = await openDb();
    if (!db) return null;
    const tx = db.transaction([RECORDINGS, PIECES]);
    const [meta, pieces] = await Promise.all([
      request(tx.objectStore(RECORDINGS).get(id)),
      request(tx.objectStore(PIECES).getAll(piecesOf(id))),
    ]);
    if (!meta) return null;
    const segments = assembleSegments(pieces, meta.mimeType);
    if (!segments.length) return null;
    return { id, segments, seconds: meta.seconds, mimeType: meta.mimeType, meta };
  } catch (err) {
    return null;
  }
};

export const deleteRecording = async (id) => {
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction([RECORDINGS, PIECES], 'readwrite');
    tx.objectStore(RECORDINGS).delete(id);
    tx.objectStore(PIECES).delete(piecesOf(id));
    await done(tx);
  } catch (err) {
    /* nothing more to do */
  }
};

/** Everything kept on this device, for every account - used on sign-out. */
export const clearRecordings = async () => {
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction([RECORDINGS, PIECES], 'readwrite');
    tx.objectStore(RECORDINGS).clear();
    tx.objectStore(PIECES).clear();
    await done(tx);
  } catch (err) {
    /* nothing more to do */
  }
};

/**
 * Make room before a new recording: keep the `keep` newest, and nothing older
 * than KEEP_DAYS. Counted across accounts, since they share the disk.
 */
export const pruneRecordings = async (keep = KEEP_RECORDINGS - 1) => {
  const all = await listRecordings();
  const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
  const stale = all.filter((meta, index) => index >= keep || meta.startedAt < cutoff);
  await Promise.all(stale.map((meta) => deleteRecording(meta.id)));
};

const newId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * Keeps one recording up to date on disk: audio pieces as they are captured,
 * and the text and progress of its transcription as chunks come back.
 *
 * Writes are batched every few seconds, and forced when the page is hidden -
 * the last moment a phone or a closing tab reliably gives.
 *
 * Pass the `meta` of a stored recording to carry on with it (transcribing the
 * rest of it, say); leave it out for a new one.
 */
export const keepRecording = ({ owner = '', meta: existing, onError } = {}) => {
  const meta = existing
    ? { ...existing }
    : {
        id: newId(),
        owner,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        mimeType: '',
        seconds: 0,
        text: '',
        progress: null,
        complete: false,
        discarded: false,
      };
  let pending = []; // { segment, blob } not yet written
  const nextPiece = new Map();
  let dirty = !existing;
  let timer = null;
  let failed = false;
  let writing = Promise.resolve();

  const write = async () => {
    if (!dirty && !pending.length) return;
    const batch = pending;
    pending = [];
    dirty = false;
    meta.updatedAt = Date.now();
    try {
      const db = await openDb();
      if (!db) return;
      const tx = db.transaction([RECORDINGS, PIECES], 'readwrite');
      // Pieces from the same segment go down as one, which keeps the store
      // small without waiting on a whole five-minute segment.
      const bySegment = new Map();
      batch.forEach(({ segment, blob }) => {
        if (!bySegment.has(segment)) bySegment.set(segment, []);
        bySegment.get(segment).push(blob);
      });
      bySegment.forEach((blobs, segment) => {
        const piece = nextPiece.get(segment) || 0;
        nextPiece.set(segment, piece + 1);
        tx.objectStore(PIECES).put({
          id: meta.id,
          segment,
          piece,
          blob: new Blob(blobs, { type: blobs[0].type }),
        });
      });
      tx.objectStore(RECORDINGS).put({ ...meta });
      await done(tx);
    } catch (err) {
      if (!failed) {
        failed = true;
        onError?.(err);
      }
    }
  };

  const flush = () => {
    clearTimeout(timer);
    timer = null;
    writing = writing.then(write);
    return writing;
  };

  const schedule = () => {
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  };

  const onHide = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flush);

  return {
    id: meta.id,
    get meta() {
      return { ...meta };
    },
    /** A slice of audio from the recorder, for capture segment `segment`. */
    add(blob, segment) {
      if (!blob?.size) return;
      if (!meta.mimeType) meta.mimeType = blob.type;
      meta.segments = Math.max(meta.segments || 0, segment + 1);
      pending.push({ segment, blob });
      schedule();
    },
    /** Merge fields into the stored description (seconds, discarded...). */
    update(fields) {
      Object.assign(meta, fields);
      dirty = true;
      schedule();
    },
    /** A transcribed chunk: its text, and how far transcription has got. */
    chunk(text, progress) {
      if (text) meta.text = [meta.text, text].filter(Boolean).join(' ').trim();
      if (progress) meta.progress = progress;
      dirty = true;
      schedule();
    },
    flush,
    /** Write what is left and stop listening for the page closing. */
    close() {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
      return flush();
    },
  };
};

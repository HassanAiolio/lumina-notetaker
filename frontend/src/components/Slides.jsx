import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Loader2, Presentation, X } from 'lucide-react';
import { toast } from 'sonner';
import { openDeck } from '../lib/slides';
import { getSlidePage } from '../services/api';

/**
 * Lecture slides in the notes.
 *
 * A bullet that draws on a slide ends with "[p. 12]"; that becomes a chip, and
 * the chip opens the page. Where the page comes from depends on the note:
 * straight from the PDF while it is still open in this session, otherwise from
 * the pictures kept with the saved note.
 */

const SlidesContext = createContext(null);

/**
 * Makes the citations under it clickable.
 *
 * `deck`   the PDF opened in this session, if any (lib/slides openDeck)
 * `note`   the note being shown; its `slides` say which deck it was made with
 */
export const SlidesProvider = ({ deck, note, children }) => {
  const [open, setOpen] = useState(null); // page number, or null
  const urls = useRef(new Map());
  const info = note?.slides;
  // The open PDF is only the right source if it is the deck the note cites.
  const liveDeck = deck && (!info?.hash || info.hash === deck.hash) ? deck : null;
  const savedId = note?.id && info?.cited?.length ? note.id : null;

  // A different note or deck: pictures cached for the last one do not apply.
  useEffect(() => {
    urls.current = new Map();
    setOpen(null);
  }, [liveDeck, savedId, info?.hash]);

  const image = useCallback(
    (page) => {
      if (!urls.current.has(page)) {
        const load = liveDeck
          ? liveDeck.render(page).then((blob) => URL.createObjectURL(blob))
          : savedId
            ? getSlidePage(savedId, page, info?.hash)
            : Promise.reject(new Error('This page was not kept with the note.'));
        urls.current.set(page, load.catch((err) => {
          urls.current.delete(page);
          throw err;
        }));
      }
      return urls.current.get(page);
    },
    [info?.hash, liveDeck, savedId],
  );

  const value = useMemo(() => {
    const available = !!(liveDeck || savedId);
    // Steps through what the note cites, which is what is worth revisiting.
    const pages = info?.cited?.length ? info.cited : [];
    return {
      available,
      name: info?.name || deck?.name || 'Slides',
      pageCount: info?.pages || deck?.pageCount || 0,
      pages,
      open: (page) => available && setOpen(page),
      image,
    };
  }, [deck?.name, deck?.pageCount, image, info?.cited, info?.name, info?.pages, liveDeck, savedId]);

  return (
    <SlidesContext.Provider value={value}>
      {children}
      <AnimatePresence>
        {open !== null && <SlideViewer page={open} onPage={setOpen} onClose={() => setOpen(null)} />}
      </AnimatePresence>
    </SlidesContext.Provider>
  );
};

export const useSlides = () => useContext(SlidesContext);

/** "[p. 12]" in a bullet: a chip that opens the page, or plain when it cannot. */
export const SlideChip = ({ page, last }) => {
  const slides = useSlides();
  const label = last && last !== page ? `p. ${page}–${last}` : `p. ${page}`;
  if (!slides?.available) {
    return <span className="ml-1 text-[11px] text-zinc-500 whitespace-nowrap">{label}</span>;
  }
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        slides.open(page);
      }}
      className="ml-1 inline-flex items-center gap-1 align-[1px] px-1.5 py-[1px] rounded-md text-[11px] font-medium whitespace-nowrap bg-violet-500/10 border border-violet-500/25 text-violet-200 hover:bg-violet-500/20 transition-colors"
      title={`Open slide ${label}`}
      data-testid="slide-chip"
    >
      <Presentation size={10} />
      {label}
    </button>
  );
};

const SlideViewer = ({ page, onPage, onClose }) => {
  const slides = useSlides();
  const [state, setState] = useState({ page: null, url: null, error: '' });
  const order = slides.pages.length ? slides.pages : [page];
  const at = order.indexOf(page);
  const prev = at > 0 ? order[at - 1] : null;
  const next = at >= 0 && at < order.length - 1 ? order[at + 1] : null;

  useEffect(() => {
    let live = true;
    slides
      .image(page)
      .then((url) => live && setState({ page, url, error: '' }))
      .catch(() => live && setState({ page, url: null, error: 'This page is not available here.' }));
    return () => {
      live = false;
    };
  }, [page, slides]);

  // Captured on the way in, so the reader underneath never sees these keys:
  // its own arrows step between notes and Escape leaves the note.
  useEffect(() => {
    const onKey = (event) => {
      if (!['Escape', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft' && prev) onPage(prev);
      if (event.key === 'ArrowRight' && next) onPage(next);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [next, onClose, onPage, prev]);

  const loading = state.page !== page;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-[80] bg-black/85 backdrop-blur-sm flex flex-col items-center justify-center p-3 sm:p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Slide ${page}`}
      data-testid="slide-viewer"
    >
      <div className="w-full max-w-5xl flex items-center justify-between text-xs text-zinc-300 mb-3" onClick={(e) => e.stopPropagation()}>
        <span className="truncate">
          {slides.name} · page {page}
          {slides.pageCount ? ` / ${slides.pageCount}` : ''}
          {order.length > 1 && <span className="text-zinc-500"> · cited {at + 1} of {order.length}</span>}
        </span>
        <button onClick={onClose} className="tap p-1.5 rounded-lg hover:bg-white/10" aria-label="Close slide">
          <X size={16} />
        </button>
      </div>
      <div className="relative w-full max-w-5xl flex-1 min-h-0 flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
        {loading ? (
          <Loader2 size={22} className="animate-spin text-violet-300" />
        ) : state.url ? (
          <img
            src={state.url}
            alt={`Slide page ${page}`}
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl bg-white"
            data-testid="slide-image"
          />
        ) : (
          <p className="text-sm text-zinc-400 text-center max-w-xs">
            {state.error} Attach the same PDF to see every page.
          </p>
        )}
        {prev && (
          <button
            onClick={() => onPage(prev)}
            className="absolute left-0 sm:-left-12 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/60 border border-white/10 text-zinc-200 hover:bg-black/80"
            aria-label={`Page ${prev}`}
          >
            <ChevronLeft size={18} />
          </button>
        )}
        {next && (
          <button
            onClick={() => onPage(next)}
            className="absolute right-0 sm:-right-12 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/60 border border-white/10 text-zinc-200 hover:bg-black/80"
            aria-label={`Page ${next}`}
          >
            <ChevronRight size={18} />
          </button>
        )}
      </div>
    </motion.div>
  );
};

/** Attach a lecture's slides (PDF) to what is being recorded or pasted. */
export const SlidesPicker = ({ deck, onDeck, disabled }) => {
  const input = useRef(null);
  const [reading, setReading] = useState(null);

  const pick = async (file) => {
    if (!file) return;
    setReading({ done: 0, total: 0 });
    try {
      const opened = await openDeck(file, { onProgress: (done, total) => setReading({ done, total }) });
      deck?.close?.();
      onDeck(opened);
      if (!opened.readable) {
        toast.warning('No text found in those slides (scanned images?). They can still be opened, but cannot guide the notes.');
      } else {
        toast.success(`Slides attached: ${opened.pageCount} pages`);
      }
    } catch (err) {
      toast.error(err?.message?.includes('PDF') ? err.message : 'Could not read that PDF.');
    } finally {
      setReading(null);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="flex items-center gap-1.5" data-testid="slides-picker">
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(event) => pick(event.target.files?.[0])}
        data-testid="slides-input"
      />
      {deck ? (
        <span className="flex items-center gap-1.5 max-w-[14rem] pl-3 pr-1.5 py-1.5 rounded-full text-xs bg-violet-500/10 border border-violet-500/25 text-violet-200">
          <Presentation size={12} className="flex-shrink-0" />
          <span className="truncate" title={deck.name}>{deck.name}</span>
          <span className="text-violet-300/60 flex-shrink-0">{deck.pageCount} p.</span>
          <button
            onClick={() => {
              deck.close?.();
              onDeck(null);
            }}
            disabled={disabled}
            className="tap p-0.5 rounded-full hover:bg-white/10 disabled:opacity-40"
            aria-label="Remove slides"
          >
            <X size={11} />
          </button>
        </span>
      ) : (
        <button
          onClick={() => input.current?.click()}
          disabled={disabled || !!reading}
          className="flex items-center gap-1.5 px-3 py-2 rounded-full text-sm font-medium text-zinc-400 hover:text-white border border-transparent hover:border-white/10 transition-colors disabled:opacity-40"
          title="Attach the lecture's slides (PDF) so the notes can use and cite them"
          data-testid="attach-slides-btn"
        >
          {reading ? <Loader2 size={14} className="animate-spin" /> : <Presentation size={14} />}
          {reading ? (reading.total ? `Reading ${reading.done}/${reading.total}…` : 'Opening…') : 'Slides'}
        </button>
      )}
    </div>
  );
};

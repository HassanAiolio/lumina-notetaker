import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ChevronRight, GraduationCap, Loader2, RotateCcw, Search, Tag, TriangleAlert, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Input } from './ui/input';
import { NoteReader } from './NoteReader';
import { errorMessage, getAllTags, getNote, getNotes } from '../services/api';
import { groupByDate, languageName, noteCounts, notePreview, TYPE_LABELS } from '../lib/notes';

const PAGE_SIZE = 30;

// A note open in the reader is in the address: #note=<id>. Back closes it,
// and a link to a note opens straight onto it.
const HASH_PREFIX = '#note=';
const hashNote = () =>
  window.location.hash.startsWith(HASH_PREFIX) ? decodeURIComponent(window.location.hash.slice(HASH_PREFIX.length)) : null;

const isTyping = (event) => !!event.target.closest?.('input, textarea, [contenteditable="true"]');

const time = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) +
        ' · ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};

const NoteRow = React.forwardRef(({ note, onOpen, onKeyDown }, ref) => {
  const counts = useMemo(() => noteCounts(note), [note]);
  const preview = useMemo(() => notePreview(note), [note]);
  return (
    <button
      ref={ref}
      onClick={() => onOpen(note.id)}
      onKeyDown={onKeyDown}
      className="group w-full text-left glass-card p-4 md:p-5 hover:border-violet-500/30 focus:border-violet-500/50 focus:outline-none transition-colors duration-200 flex items-start gap-4"
      data-testid={`note-card-${note.id}`}
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="font-heading text-[15px] font-semibold text-white leading-snug">{note.title}</h3>
          {note.degraded && (
            <TriangleAlert size={12} className="text-amber-400" aria-label="Made while the AI was unavailable" />
          )}
        </div>
        {preview && <p className="text-sm text-zinc-400 leading-relaxed line-clamp-2">{preview}</p>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
          <span>{time(note.created_at)}</span>
          {note.type && <span className="uppercase tracking-wider">{note.type}</span>}
          {languageName(note.language) && <span>{languageName(note.language)}</span>}
          <span>{counts.points} points</span>
          {counts.cards > 0 && (
            <span className="flex items-center gap-1 text-violet-300/80">
              <GraduationCap size={11} /> {counts.cards} cards
            </span>
          )}
          {note.tags?.map((tag) => (
            <span key={tag} className="text-zinc-400">#{tag}</span>
          ))}
        </div>
      </div>
      <ChevronRight size={16} className="mt-1 text-zinc-600 group-hover:text-zinc-300 transition-colors flex-shrink-0" />
    </button>
  );
});
NoteRow.displayName = 'NoteRow';

export const NoteHistory = ({ refreshTrigger }) => {
  const [notes, setNotes] = useState([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedTag, setSelectedTag] = useState('');
  const [selectedType, setSelectedType] = useState('');
  const [allTags, setAllTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [openId, setOpenId] = useState(hashNote);
  // A note opened from a link may not be in the page that is loaded.
  const [stray, setStray] = useState(null);

  const requestIdRef = useRef(0);
  const searchRef = useRef(null);
  const rowRefs = useRef([]);
  const pushedRef = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const sync = () => {
      setOpenId(hashNote());
      pushedRef.current = false;
    };
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  // One effect owns fetching. Keyed on the debounced search so typing does not
  // fire a request per keystroke, and stale responses are discarded by id.
  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError('');
    (async () => {
      try {
        const [page, tags] = await Promise.all([
          getNotes({
            search: debouncedSearch || undefined,
            tag: selectedTag || undefined,
            type: selectedType || undefined,
            brief: true,
            limit: PAGE_SIZE,
            offset: 0,
          }),
          getAllTags(),
        ]);
        if (requestIdRef.current !== requestId) return;
        setNotes(page.items);
        setTotal(page.total);
        setAllTags(tags);
      } catch (err) {
        if (requestIdRef.current !== requestId) return;
        setError(errorMessage(err, 'Could not load your notes.'));
      } finally {
        if (requestIdRef.current === requestId) setLoading(false);
      }
    })();
  }, [debouncedSearch, selectedTag, selectedType, refreshTrigger, reloadKey]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const page = await getNotes({
        search: debouncedSearch || undefined,
        tag: selectedTag || undefined,
        type: selectedType || undefined,
        brief: true,
        limit: PAGE_SIZE,
        offset: notes.length,
      });
      setNotes((current) => {
        const seen = new Set(current.map((note) => note.id));
        return [...current, ...page.items.filter((note) => !seen.has(note.id))];
      });
      setTotal(page.total);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not load more notes.'));
    } finally {
      setLoadingMore(false);
    }
  }, [debouncedSearch, notes.length, selectedTag, selectedType]);

  const open = useCallback((id) => {
    // Opening from the list pushes an entry, so Back returns to the list;
    // stepping to the next note replaces it, so Back still does.
    if (hashNote()) window.history.replaceState(null, '', HASH_PREFIX + encodeURIComponent(id));
    else {
      window.history.pushState(null, '', HASH_PREFIX + encodeURIComponent(id));
      pushedRef.current = true;
    }
    setOpenId(id);
  }, []);

  const close = useCallback(() => {
    if (pushedRef.current) window.history.back();
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
    pushedRef.current = false;
    setOpenId(null);
  }, []);

  const openIndex = notes.findIndex((note) => note.id === openId);
  const openNote = openIndex >= 0 ? notes[openIndex] : stray?.id === openId ? stray : null;

  useEffect(() => {
    if (!openId || loading || openIndex >= 0 || stray?.id === openId) return;
    getNote(openId)
      .then(setStray)
      .catch(() => {
        toast.error('That note could not be found.');
        close();
      });
  }, [close, loading, openId, openIndex, stray]);

  // In the list: "/" searches, arrows move between notes.
  useEffect(() => {
    if (openId) return undefined;
    const onKey = (event) => {
      if (event.key === '/' && !isTyping(event)) {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === 'ArrowDown' && isTyping(event) && event.target === searchRef.current) {
        event.preventDefault();
        rowRefs.current[0]?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openId]);

  const rowKeys = (index) => (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      rowRefs.current[index + 1]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      (rowRefs.current[index - 1] || searchRef.current)?.focus();
    }
  };

  const groups = useMemo(() => groupByDate(notes), [notes]);
  const hasFilters = Boolean(debouncedSearch || selectedTag || selectedType);

  if (openId) {
    if (!openNote) {
      return (
        <div className="flex justify-center py-16" data-testid="reader-loading">
          <Loader2 size={20} className="animate-spin text-violet-400" />
        </div>
      );
    }
    const prev = openIndex > 0 ? notes[openIndex - 1] : null;
    const next = openIndex >= 0 && openIndex < notes.length - 1 ? notes[openIndex + 1] : null;
    return (
      <NoteReader
        initial={openNote}
        position={openIndex >= 0 ? `${openIndex + 1} / ${total}` : ''}
        onBack={close}
        onPrev={prev ? () => open(prev.id) : null}
        onNext={next ? () => open(next.id) : null}
        onUpdated={(saved) =>
          setNotes((current) => current.map((note) => (note.id === saved.id ? { ...note, ...saved, raw_transcript: '' } : note)))
        }
        onDeleted={(id) => {
          setNotes((current) => current.filter((note) => note.id !== id));
          setTotal((value) => Math.max(0, value - 1));
          close();
        }}
      />
    );
  }

  let rowIndex = -1;
  rowRefs.current = [];

  return (
    <div className="space-y-5" data-testid="note-history">
      <div className="relative">
        <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400" />
        <Input
          ref={searchRef}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search titles, transcripts and tags…"
          className="pl-9 pr-16 h-10 bg-black/50 border-white/10 text-zinc-200 placeholder:text-zinc-400 rounded-xl text-sm"
          data-testid="search-notes-input"
        />
        {search ? (
          <button
            onClick={() => setSearch('')}
            className="tap absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-white"
            aria-label="Clear search"
          >
            <X size={14} />
          </button>
        ) : (
          <kbd className="hidden sm:block absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-zinc-500 border border-white/10 rounded px-1.5 py-0.5">
            /
          </kbd>
        )}
      </div>

      <div className="flex flex-wrap gap-2" data-testid="type-filter">
        {[['', 'All'], ...Object.entries(TYPE_LABELS)].map(([value, label]) => (
          <button
            key={value || 'all'}
            onClick={() => setSelectedType(selectedType === value ? '' : value)}
            className={`tag-pill ${selectedType === value ? 'tag-pill--active' : ''}`}
            data-testid={`filter-type-${value || 'all'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-2" data-testid="tag-filter">
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => setSelectedTag(selectedTag === tag ? '' : tag)}
              className={`tag-pill ${selectedTag === tag ? 'tag-pill--active' : ''}`}
              data-testid={`filter-tag-${tag}`}
            >
              <Tag size={10} />
              {tag}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div
          className="flex flex-col gap-3 text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3"
          role="alert"
          data-testid="notes-error"
        >
          <div className="flex items-start gap-2">
            <TriangleAlert size={15} className="flex-shrink-0 mt-0.5" />
            <span className="leading-relaxed">{error}</span>
          </div>
          <button
            onClick={() => setReloadKey((value) => value + 1)}
            className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white/5 hover:bg-white/10 text-zinc-200 border border-white/10 transition-colors duration-200"
            data-testid="retry-notes-btn"
          >
            <RotateCcw size={12} />
            Try again
          </button>
        </div>
      )}

      {loading ? (
        <div className="space-y-3" data-testid="notes-skeleton">
          {[0, 1, 2].map((index) => (
            <div key={index} className="glass-card p-5 animate-pulse space-y-3">
              <div className="h-4 w-1/3 bg-white/5 rounded" />
              <div className="h-3 w-2/3 bg-white/5 rounded" />
              <div className="h-3 w-1/4 bg-white/5 rounded" />
            </div>
          ))}
        </div>
      ) : notes.length === 0 ? (
        <div className="text-center py-16" data-testid="notes-empty">
          <p className="text-zinc-400 text-sm">
            {hasFilters ? 'No notes match.' : 'No saved notes yet. Record a lecture and save its notes.'}
          </p>
          {hasFilters && (
            <button
              onClick={() => {
                setSearch('');
                setSelectedTag('');
                setSelectedType('');
              }}
              className="mt-3 text-xs text-violet-400 hover:text-violet-300 transition-colors duration-200"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
          <p className="text-xs text-zinc-400">
            {total} note{total === 1 ? '' : 's'}
            {hasFilters ? ' found' : ''}
          </p>
          {groups.map((group) => (
            <section key={group.label} className="space-y-2.5">
              <h3 className="text-[11px] uppercase tracking-widest text-zinc-500 font-medium first-letter:uppercase">
                {group.label}
              </h3>
              {group.notes.map((note) => {
                rowIndex += 1;
                const index = rowIndex;
                return (
                  <NoteRow
                    key={note.id}
                    ref={(element) => {
                      rowRefs.current[index] = element;
                    }}
                    note={note}
                    onOpen={open}
                    onKeyDown={rowKeys(index)}
                  />
                );
              })}
            </section>
          ))}

          {notes.length < total && (
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="w-full py-3 rounded-xl text-sm font-medium bg-white/5 hover:bg-white/10 text-zinc-300 border border-white/10 transition-colors duration-200 flex items-center justify-center gap-2"
              data-testid="load-more-btn"
            >
              {loadingMore && <Loader2 size={14} className="animate-spin" />}
              {loadingMore ? 'Loading…' : `Load more (${total - notes.length} left)`}
            </button>
          )}
        </motion.div>
      )}
    </div>
  );
};

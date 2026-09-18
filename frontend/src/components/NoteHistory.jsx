import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ChevronDown, Clock, FileText, Loader2, RotateCcw, Search, Tag, Trash2, TriangleAlert, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Input } from './ui/input';
import { ExportButton } from './ExportButton';
import { deleteNote, errorMessage, getAllTags, getNotes } from '../services/api';
import { languageName, sectionEntries, sectionLabel } from '../lib/notes';

const PAGE_SIZE = 20;

// One quiet bullet for every section. The old rotating rainbow implied a
// meaning the sections do not have, and competed with the primary action.
const BULLET_CLASS = 'bg-zinc-600';

const NoteCard = ({ note, onDelete, isExpanded, onToggle, isDeleting }) => {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const entries = useMemo(() => sectionEntries(note), [note]);

  const created = new Date(note.created_at);
  const formatted = Number.isNaN(created.getTime())
    ? ''
    : created.toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10, transition: { duration: 0.15 } }}
      className="glass-card glass-card-highlight p-4 md:p-5 hover:border-violet-500/20 transition-colors duration-300"
      data-testid={`note-card-${note.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <button onClick={onToggle} className="flex-1 text-left min-w-0" aria-expanded={isExpanded}>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-heading text-base font-semibold text-white leading-snug">
              {note.title}
            </h3>
            {note.type && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-zinc-400 font-medium">
                {note.type}
              </span>
            )}
            {note.degraded && (
              <span
                className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 font-medium inline-flex items-center gap-1"
                title="Structured locally because the AI was unavailable"
              >
                <TriangleAlert size={10} />
                Offline summary
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1.5 text-xs text-zinc-400">
            <span className="flex items-center gap-1.5">
              <Clock size={11} />
              {formatted}
            </span>
            {languageName(note.language) && <span>{languageName(note.language)}</span>}
          </div>
        </button>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={onToggle}
            className="p-1.5 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-white transition-colors duration-200"
            aria-label={isExpanded ? 'Collapse note' : 'Expand note'}
            data-testid={`toggle-note-${note.id}`}
          >
            <ChevronDown
              size={14}
              className={`transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
            />
          </button>
          {confirmingDelete ? (
            <div className="flex items-center gap-1">
              <button
                onClick={() => onDelete(note.id)}
                disabled={isDeleting}
                className="px-2 py-1 rounded-lg text-[11px] font-medium bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors duration-200"
                data-testid={`confirm-delete-${note.id}`}
              >
                {isDeleting ? '…' : 'Delete'}
              </button>
              <button
                onClick={() => setConfirmingDelete(false)}
                className="p-1 rounded-lg text-zinc-400 hover:text-white"
                aria-label="Cancel delete"
              >
                <X size={12} />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmingDelete(true)}
              className="p-1.5 rounded-lg hover:bg-red-500/10 text-zinc-400 hover:text-red-400 transition-colors duration-200"
              aria-label="Delete note"
              data-testid={`delete-note-${note.id}`}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {note.tags?.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {note.tags.map((tag) => (
            <span key={tag} className="tag-pill text-[11px]">{tag}</span>
          ))}
        </div>
      )}

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-4 pt-4 border-t border-white/5 space-y-4">
              {entries.length > 0 ? (
                entries.map(([key, items]) => (
                  <div key={key}>
                    <p className="text-xs text-zinc-400 uppercase tracking-widest mb-2">
                      {sectionLabel(key, note.labels)}
                    </p>
                    <ul className="space-y-1.5">
                      {items.map((item, itemIndex) => (
                        <li
                          key={`${key}-${itemIndex}`}
                          className="text-sm text-zinc-300 flex items-start gap-2 leading-relaxed"
                        >
                          <span
                            className={`mt-[7px] w-1 h-1 rounded-full flex-shrink-0 ${BULLET_CLASS}`}
                          />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              ) : (
                <p className="text-sm text-zinc-400">This note has no sections.</p>
              )}

              {note.raw_transcript && (
                <div className="pt-1">
                  <button
                    onClick={() => setShowTranscript((value) => !value)}
                    className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-white uppercase tracking-widest transition-colors duration-200"
                    aria-expanded={showTranscript}
                    data-testid={`toggle-transcript-${note.id}`}
                  >
                    <FileText size={12} />
                    {showTranscript ? 'Hide transcript' : 'Show transcript'}
                  </button>
                  {showTranscript && (
                    <p className="mt-2 text-sm text-zinc-400 leading-relaxed whitespace-pre-wrap max-h-64 overflow-y-auto pr-2 bg-black/30 rounded-lg p-3 border border-white/5">
                      {note.raw_transcript}
                    </p>
                  )}
                </div>
              )}

              <div className="pt-1">
                <ExportButton note={note} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export const NoteHistory = ({ refreshTrigger }) => {
  const [notes, setNotes] = useState([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedTag, setSelectedTag] = useState('');
  const [allTags, setAllTags] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [deletingId, setDeletingId] = useState('');
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const requestIdRef = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

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
  }, [debouncedSearch, selectedTag, refreshTrigger, reloadKey]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const page = await getNotes({
        search: debouncedSearch || undefined,
        tag: selectedTag || undefined,
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
  }, [debouncedSearch, notes.length, selectedTag]);

  const handleDelete = useCallback(
    async (id) => {
      setDeletingId(id);
      const previous = notes;
      // Optimistic: the row disappears immediately and comes back on failure.
      setNotes((current) => current.filter((note) => note.id !== id));
      setTotal((current) => Math.max(0, current - 1));
      try {
        await deleteNote(id);
        toast.success('Note deleted');
      } catch (err) {
        setNotes(previous);
        setTotal(previous.length);
        toast.error(errorMessage(err, 'Could not delete that note.'));
      } finally {
        setDeletingId('');
      }
    },
    [notes],
  );

  const hasFilters = Boolean(debouncedSearch || selectedTag);

  return (
    <div className="space-y-6" data-testid="note-history">
      <div className="relative">
        <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search titles, transcripts and tags…"
          className="pl-9 pr-9 h-10 bg-black/50 border-white/10 text-zinc-200 placeholder:text-zinc-400 rounded-xl text-sm"
          data-testid="search-notes-input"
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-white"
            aria-label="Clear search"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-2" data-testid="tag-filter">
          <button
            onClick={() => setSelectedTag('')}
            className={`tag-pill ${!selectedTag ? 'tag-pill--active' : ''}`}
            data-testid="filter-all-tags"
          >
            All
          </button>
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
            <div key={index} className="glass-card p-5 animate-pulse">
              <div className="h-4 w-1/3 bg-white/5 rounded" />
              <div className="h-3 w-1/4 bg-white/5 rounded mt-3" />
            </div>
          ))}
        </div>
      ) : notes.length === 0 ? (
        <div className="text-center py-16" data-testid="notes-empty">
          <p className="text-zinc-400 text-sm">
            {hasFilters ? 'No notes match your search.' : 'No saved notes yet. Record something!'}
          </p>
          {hasFilters && (
            <button
              onClick={() => {
                setSearch('');
                setSelectedTag('');
              }}
              className="mt-3 text-xs text-violet-400 hover:text-violet-300 transition-colors duration-200"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <>
          <p className="text-xs text-zinc-400">
            {total} note{total === 1 ? '' : 's'}
            {hasFilters ? ' found' : ''}
          </p>
          <div className="space-y-3">
            <AnimatePresence initial={false}>
              {notes.map((note) => (
                <NoteCard
                  key={note.id}
                  note={note}
                  onDelete={handleDelete}
                  isDeleting={deletingId === note.id}
                  isExpanded={expandedId === note.id}
                  onToggle={() => setExpandedId(expandedId === note.id ? null : note.id)}
                />
              ))}
            </AnimatePresence>
          </div>

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
        </>
      )}
    </div>
  );
};

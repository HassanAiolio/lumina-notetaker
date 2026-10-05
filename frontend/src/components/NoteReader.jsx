import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowLeft, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, FileText, GraduationCap,
  Loader2, Pencil, Plus, Trash2, TriangleAlert, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { BulletText } from './BulletText';
import { ExportButton } from './ExportButton';
import { ReviseDeck } from './ReviseDeck';
import { deleteNote, errorMessage, getNote, updateNote } from '../services/api';
import {
  languageName, noteCounts, noteToMarkdown, sectionEntries, sectionLabel,
} from '../lib/notes';

const isTyping = (event) => !!event.target.closest?.('input, textarea, [contenteditable="true"]');

const longDate = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(undefined, {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });
};

/**
 * One saved note, on its own page: an index of its sections, the notes, the
 * transcript, and a revision deck.
 *
 * Opened from the library with only what a listing carries; the whole note,
 * transcript included, is fetched here.
 */
export const NoteReader = ({
  initial, position, onBack, onPrev, onNext, onUpdated, onDeleted,
}) => {
  const [note, setNote] = useState(initial);
  const [complete, setComplete] = useState(false);
  const [mode, setMode] = useState('notes');
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(initial.title);
  const [tagDraft, setTagDraft] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [activeSection, setActiveSection] = useState('');
  const [copied, setCopied] = useState(false);
  const sectionRefs = useRef({});

  const entries = useMemo(() => sectionEntries(note), [note]);
  const counts = useMemo(() => noteCounts(note), [note]);

  useEffect(() => {
    let cancelled = false;
    setNote(initial);
    setComplete(false);
    setTitleDraft(initial.title);
    setEditingTitle(false);
    setConfirmingDelete(false);
    setShowTranscript(false);
    getNote(initial.id)
      .then((full) => {
        if (cancelled) return;
        setNote(full);
        setComplete(true);
      })
      .catch((err) => {
        if (!cancelled) toast.error(errorMessage(err, 'Could not load the whole note.'));
      });
    window.scrollTo({ top: 0 });
    return () => {
      cancelled = true;
    };
    // A new note, not a new copy of the same one: saving a rename hands back
    // an updated object, and that must not refetch and reset the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.id]);

  // Which section is being read, for the index.
  useEffect(() => {
    if (mode !== 'notes') return undefined;
    const observer = new IntersectionObserver(
      (seen) => {
        const visible = seen.filter((entry) => entry.isIntersecting);
        if (visible.length) setActiveSection(visible[0].target.dataset.section);
      },
      { rootMargin: '-20% 0px -65% 0px' },
    );
    Object.values(sectionRefs.current).forEach((element) => element && observer.observe(element));
    return () => observer.disconnect();
  }, [entries, mode]);

  useEffect(() => {
    const onKey = (event) => {
      if (isTyping(event) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'Escape') onBack();
      else if (event.key === 'r' || event.key === 'R') setMode((value) => (value === 'notes' ? 'revise' : 'notes'));
      else if (mode === 'notes' && event.key === 'ArrowLeft' && onPrev) onPrev();
      else if (mode === 'notes' && event.key === 'ArrowRight' && onNext) onNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, onBack, onNext, onPrev]);

  const save = useCallback(
    async (changes, success) => {
      const before = note;
      setNote((current) => ({ ...current, ...changes }));
      try {
        const saved = await updateNote(note.id, changes);
        setNote((current) => ({ ...current, ...saved }));
        onUpdated(saved);
        if (success) toast.success(success);
      } catch (err) {
        setNote(before);
        toast.error(errorMessage(err, 'Could not save that change.'));
      }
    },
    [note, onUpdated],
  );

  const commitTitle = () => {
    setEditingTitle(false);
    const title = titleDraft.trim();
    if (title && title !== note.title) save({ title }, 'Renamed');
    else setTitleDraft(note.title);
  };

  const addTag = () => {
    const tag = tagDraft.trim().toLowerCase();
    setTagDraft('');
    if (tag && !note.tags?.includes(tag)) save({ tags: [...(note.tags || []), tag] });
  };

  const handleDelete = async () => {
    try {
      await deleteNote(note.id);
      toast.success('Note deleted');
      onDeleted(note.id);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not delete that note.'));
    }
  };

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(noteToMarkdown(note));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      /* clipboard blocked; export still works */
    }
  };

  const jumpTo = (key) => {
    sectionRefs.current[key]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const language = languageName(note.language);

  return (
    <motion.article
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="space-y-6"
      data-testid="note-reader"
    >
      {/* Navigation */}
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-white transition-colors"
          data-testid="reader-back"
        >
          <ArrowLeft size={15} /> All notes
        </button>
        <div className="flex items-center gap-1 text-xs text-zinc-400">
          {position && <span className="mr-1 tabular-nums">{position}</span>}
          <button
            onClick={onPrev || undefined}
            disabled={!onPrev}
            className="tap p-1.5 rounded-lg hover:bg-white/5 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
            aria-label="Newer note"
            title="Newer note (←)"
            data-testid="reader-prev"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            onClick={onNext || undefined}
            disabled={!onNext}
            className="tap p-1.5 rounded-lg hover:bg-white/5 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
            aria-label="Older note"
            title="Older note (→)"
            data-testid="reader-next"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* Header */}
      <header className="space-y-3">
        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitTitle();
              if (event.key === 'Escape') {
                setTitleDraft(note.title);
                setEditingTitle(false);
              }
            }}
            maxLength={200}
            className="w-full bg-transparent border-b border-violet-500/50 font-heading text-2xl md:text-3xl font-bold text-white tracking-tight outline-none pb-1"
            aria-label="Note title"
            data-testid="reader-title-input"
          />
        ) : (
          <button
            onClick={() => setEditingTitle(true)}
            className="group text-left flex items-start gap-2"
            title="Rename"
            data-testid="reader-title"
          >
            <h2 className="font-heading text-2xl md:text-3xl font-bold text-white tracking-tight leading-tight">
              {note.title}
            </h2>
            <Pencil size={14} className="mt-2.5 text-zinc-600 group-hover:text-zinc-300 transition-colors flex-shrink-0" />
          </button>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-zinc-400">
          <span className="first-letter:uppercase">{longDate(note.created_at)}</span>
          {note.type && (
            <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 font-medium">{note.type}</span>
          )}
          {language && <span>{language}</span>}
          <span>
            {counts.points} points{counts.cards > 0 && ` · ${counts.cards} cards`}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {(note.tags || []).map((tag) => (
            <span key={tag} className="tag-pill text-[11px]">
              {tag}
              <button
                onClick={() => save({ tags: note.tags.filter((value) => value !== tag) })}
                className="tap hover:text-white"
                aria-label={`Remove tag ${tag}`}
              >
                <X size={10} />
              </button>
            </span>
          ))}
          <span className="flex items-center gap-1">
            <input
              value={tagDraft}
              onChange={(event) => setTagDraft(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && addTag()}
              placeholder="Add tag…"
              className="h-6 w-24 bg-transparent border border-white/10 rounded-full px-2.5 text-[11px] text-zinc-300 placeholder:text-zinc-500 outline-none focus:border-violet-500/50"
              data-testid="reader-tag-input"
            />
            <button onClick={addTag} className="tap text-zinc-400 hover:text-white" aria-label="Add tag">
              <Plus size={12} />
            </button>
          </span>
        </div>

        {note.degraded && (
          <div className="flex items-start gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
            <TriangleAlert size={13} className="flex-shrink-0 mt-px" />
            These notes were made while the AI was unavailable, so they may be incomplete.
          </div>
        )}
      </header>

      {/* Mode */}
      <div className="flex items-center gap-1 bg-white/5 rounded-full p-1 border border-white/5 w-fit" role="tablist">
        {[
          { id: 'notes', label: 'Notes', icon: FileText },
          { id: 'revise', label: `Revise${counts.cards ? ` · ${counts.cards}` : ''}`, icon: GraduationCap },
        ].map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={mode === id}
            onClick={() => setMode(id)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors flex items-center gap-1.5 ${
              mode === id ? 'bg-violet-600/30 text-violet-200' : 'text-zinc-400 hover:text-white'
            }`}
            data-testid={`reader-mode-${id}`}
          >
            <Icon size={13} /> {label}
          </button>
        ))}
        <span className="hidden sm:inline text-[11px] text-zinc-500 px-2">R</span>
      </div>

      {mode === 'revise' ? (
        <div className="glass-card glass-card-highlight p-5 md:p-6">
          <ReviseDeck note={note} />
        </div>
      ) : (
        <>
          {/* Index: a sticky strip of the sections, the current one lit. */}
          {entries.length > 2 && (
            <nav
              className="sticky top-0 z-20 -mx-4 sm:mx-0 px-4 sm:px-0 py-2 bg-[#030303]/85 backdrop-blur-md"
              aria-label="Sections"
              data-testid="reader-index"
            >
              <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
                {entries.map(([key, items]) => (
                  <button
                    key={key}
                    onClick={() => jumpTo(key)}
                    className={`whitespace-nowrap px-3 py-1 rounded-full text-xs border transition-colors ${
                      activeSection === key
                        ? 'bg-violet-600/25 border-violet-500/40 text-violet-200'
                        : 'border-white/10 text-zinc-400 hover:text-white'
                    }`}
                  >
                    {sectionLabel(key, note.labels)}
                    <span className="ml-1.5 opacity-60 tabular-nums">{items.length}</span>
                  </button>
                ))}
              </div>
            </nav>
          )}

          <div className="glass-card glass-card-highlight p-5 md:p-8 space-y-8">
            {entries.length === 0 && <p className="text-sm text-zinc-400">This note has no sections.</p>}
            {entries.map(([key, items]) => (
              <section
                key={key}
                ref={(element) => {
                  sectionRefs.current[key] = element;
                }}
                data-section={key}
                className="scroll-mt-16 space-y-3"
              >
                <h3 className="text-xs text-violet-300/80 uppercase tracking-widest font-semibold">
                  {sectionLabel(key, note.labels)}
                </h3>
                <ul className="space-y-2.5">
                  {items.map((item, index) => (
                    <li key={`${key}-${index}`} className="text-[15px] text-zinc-300 leading-relaxed flex items-start gap-2.5">
                      <span className="mt-[9px] w-1 h-1 rounded-full bg-zinc-600 flex-shrink-0" />
                      <span className="min-w-0">
                        <BulletText sectionKey={key} text={item} />
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}

            <div className="border-t border-white/5 pt-5">
              <button
                onClick={() => setShowTranscript((value) => !value)}
                className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-white uppercase tracking-widest font-medium transition-colors"
                aria-expanded={showTranscript}
                data-testid="reader-transcript-toggle"
              >
                <ChevronDown size={13} className={`transition-transform ${showTranscript ? 'rotate-180' : ''}`} />
                Full transcript
              </button>
              {showTranscript && (
                <div className="mt-3 text-sm text-zinc-400 leading-relaxed whitespace-pre-wrap max-h-[28rem] overflow-y-auto pr-2 bg-black/30 rounded-lg p-4 border border-white/5">
                  {complete ? (
                    note.raw_transcript || 'No transcript was saved with this note.'
                  ) : (
                    <span className="flex items-center gap-2">
                      <Loader2 size={13} className="animate-spin" /> Loading…
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-3">
        <ExportButton note={note} />
        <button
          onClick={copyAll}
          className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-medium bg-white/5 hover:bg-white/10 text-zinc-300 border border-white/10 transition-colors"
        >
          {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
          Copy all
        </button>
        <div className="ml-auto">
          {confirmingDelete ? (
            <span className="flex items-center gap-2 text-xs text-zinc-400">
              Delete this note?
              <button
                onClick={handleDelete}
                className="px-3 py-1.5 rounded-full font-medium bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors"
                data-testid="reader-confirm-delete"
              >
                Delete
              </button>
              <button onClick={() => setConfirmingDelete(false)} className="hover:text-white">
                Cancel
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmingDelete(true)}
              className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-red-400 transition-colors"
              data-testid="reader-delete"
            >
              <Trash2 size={13} /> Delete
            </button>
          )}
        </div>
      </div>
    </motion.article>
  );
};

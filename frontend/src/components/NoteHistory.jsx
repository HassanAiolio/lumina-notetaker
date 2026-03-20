import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Trash2, Tag, Clock, ChevronDown, ChevronUp, X } from 'lucide-react';
import { Input } from '../components/ui/input';
import { getNotes, deleteNote, getAllTags } from '../services/api';
import { ExportButton } from './ExportButton';

const NoteCard = ({ note, onDelete, onSelect, isExpanded, onToggle }) => {
  const date = new Date(note.created_at);
  const formatted = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="glass-card glass-card-highlight p-4 md:p-5 hover:border-violet-500/20 transition-colors duration-300"
      data-testid={`note-card-${note.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <button onClick={onToggle} className="flex-1 text-left">
          <h3 className="font-heading text-base font-semibold text-white leading-snug">{note.title}</h3>
          <div className="flex items-center gap-2 mt-1.5">
            <Clock size={11} className="text-zinc-600" />
            <span className="text-xs text-zinc-600">{formatted}</span>
          </div>
        </button>
        <div className="flex items-center gap-1.5">
          <button onClick={onToggle} className="p-1.5 rounded-lg hover:bg-white/5 text-zinc-500 hover:text-zinc-300 transition-colors duration-200" data-testid={`toggle-note-${note.id}`}>
            {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          <button
            onClick={() => onDelete(note.id)}
            className="p-1.5 rounded-lg hover:bg-red-500/10 text-zinc-600 hover:text-red-400 transition-colors duration-200"
            data-testid={`delete-note-${note.id}`}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Tags */}
      {note.tags?.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {note.tags.map((tag) => (
            <span key={tag} className="tag-pill text-[11px]">{tag}</span>
          ))}
        </div>
      )}

      {/* Expanded */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-4 pt-4 border-t border-white/5 space-y-4">
              <div>
                <p className="text-xs text-zinc-500 uppercase tracking-widest mb-2">Summary</p>
                <ul className="space-y-1">
                  {note.summary?.map((s, i) => (
                    <li key={i} className="text-sm text-zinc-300 flex items-start gap-2">
                      <span className="mt-1.5 w-1 h-1 rounded-full bg-violet-500 flex-shrink-0" />
                      {s}
                    </li>
                  ))}
                </ul>
              </div>
              {note.key_decisions?.length > 0 && (
                <div>
                  <p className="text-xs text-zinc-500 uppercase tracking-widest mb-2">Key Decisions</p>
                  <ul className="space-y-1">
                    {note.key_decisions.map((d, i) => (
                      <li key={i} className="text-sm text-zinc-300 flex items-start gap-2">
                        <span className="mt-1.5 w-1 h-1 rounded-full bg-emerald-500 flex-shrink-0" />
                        {d}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {note.action_items?.length > 0 && (
                <div>
                  <p className="text-xs text-zinc-500 uppercase tracking-widest mb-2">Action Items</p>
                  <ul className="space-y-1">
                    {note.action_items.map((a, i) => (
                      <li key={i} className="text-sm text-zinc-300 flex items-start gap-2">
                        <span className="mt-1.5 w-1 h-1 rounded-full bg-amber-500 flex-shrink-0" />
                        {a}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="pt-2">
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
  const [search, setSearch] = useState('');
  const [selectedTag, setSelectedTag] = useState('');
  const [allTags, setAllTags] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchNotes = useCallback(async () => {
    setLoading(true);
    try {
      const [notesData, tagsData] = await Promise.all([
        getNotes({ search: search || undefined, tag: selectedTag || undefined }),
        getAllTags(),
      ]);
      setNotes(notesData);
      setAllTags(tagsData);
    } catch (err) {
      console.error('Failed to fetch notes:', err);
    } finally {
      setLoading(false);
    }
  }, [search, selectedTag]);

  useEffect(() => {
    fetchNotes();
  }, [fetchNotes, refreshTrigger]);

  // Debounced search
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (debouncedSearch !== undefined) fetchNotes();
  }, [debouncedSearch]);

  const handleDelete = async (id) => {
    try {
      await deleteNote(id);
      setNotes(notes.filter((n) => n.id !== id));
    } catch (err) {
      console.error('Failed to delete note:', err);
    }
  };

  return (
    <div className="space-y-6" data-testid="note-history">
      {/* Search + Filter */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-600" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search notes..."
            className="pl-9 h-10 bg-black/50 border-white/10 text-zinc-200 placeholder:text-zinc-600 rounded-xl text-sm"
            data-testid="search-notes-input"
          />
        </div>
      </div>

      {/* Tags Filter */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-2" data-testid="tag-filter">
          <button
            onClick={() => setSelectedTag('')}
            className={`tag-pill transition-colors duration-200 ${!selectedTag ? 'bg-violet-600/30 border-violet-500/50 text-violet-300' : ''}`}
            data-testid="filter-all-tags"
          >
            All
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => setSelectedTag(selectedTag === tag ? '' : tag)}
              className={`tag-pill transition-colors duration-200 ${selectedTag === tag ? 'bg-violet-600/30 border-violet-500/50 text-violet-300' : ''}`}
              data-testid={`filter-tag-${tag}`}
            >
              <Tag size={10} />
              {tag}
            </button>
          ))}
        </div>
      )}

      {/* Notes List */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="w-6 h-6 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : notes.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-zinc-600 text-sm">
            {search || selectedTag ? 'No notes match your search.' : 'No saved notes yet. Start recording!'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <AnimatePresence>
            {notes.map((note) => (
              <NoteCard
                key={note.id}
                note={note}
                onDelete={handleDelete}
                isExpanded={expandedId === note.id}
                onToggle={() => setExpandedId(expandedId === note.id ? null : note.id)}
              />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
};

import React, { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, ChevronDown, Copy, Plus, TriangleAlert, X } from 'lucide-react';
import { ExportButton } from './ExportButton';
import { Input } from './ui/input';
import {
  inlineRuns, languageName, noteToMarkdown, sectionEntries, sectionLabel, stripInline,
} from '../lib/notes';

const Section = ({ sectionKey, label, items, copied, onCopy }) => (
  <div className="space-y-2">
    <div className="flex items-center justify-between gap-3">
      <h4 className="text-xs text-zinc-400 uppercase tracking-widest font-medium">{label}</h4>
      <button
        onClick={() => onCopy(items.map(stripInline).join('\n'), sectionKey)}
        className="tap text-zinc-400 hover:text-white transition-colors duration-200"
        aria-label={`Copy ${label}`}
        data-testid={`copy-${sectionKey}`}
      >
        {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
      </button>
    </div>
    <ul className="space-y-1.5">
      {items.map((item, index) => (
        <motion.li
          key={`${sectionKey}-${index}`}
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: Math.min(index * 0.04, 0.4) }}
          className="text-sm text-zinc-300 leading-relaxed flex items-start gap-2"
        >
          <span className="mt-[7px] w-1 h-1 rounded-full bg-zinc-600 flex-shrink-0" />
          <span>
            {inlineRuns(item).map((run) =>
              run.bold ? (
                <strong key={run.key} className="font-semibold text-zinc-100">
                  {run.text}
                </strong>
              ) : run.code ? (
                <code
                  key={run.key}
                  className="px-1 py-0.5 rounded bg-white/5 text-violet-200 text-[0.85em] font-mono"
                >
                  {run.text}
                </code>
              ) : run.italic ? (
                <em key={run.key}>{run.text}</em>
              ) : (
                <React.Fragment key={run.key}>{run.text}</React.Fragment>
              ),
            )}
          </span>
        </motion.li>
      ))}
    </ul>
  </div>
);

export const NoteOutput = ({ note, onSave, onClose, isSaving, saved }) => {
  const [tags, setTags] = useState(note?.tags || []);
  const [tagInput, setTagInput] = useState('');
  const [copiedKey, setCopiedKey] = useState('');
  const [showTranscript, setShowTranscript] = useState(false);

  const entries = useMemo(() => sectionEntries(note), [note]);

  if (!note) return null;

  const addTag = () => {
    const cleaned = tagInput.trim().toLowerCase();
    if (cleaned && !tags.includes(cleaned) && tags.length < 20) setTags([...tags, cleaned]);
    setTagInput('');
  };

  const copy = async (text, key) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(''), 1500);
    } catch (err) {
      /* clipboard blocked; the export button still works */
    }
  };

  const language = languageName(note.language);

  return (
    <motion.div
      initial={{ opacity: 0, y: 30, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="glass-card glass-card-highlight p-6 md:p-8 space-y-6"
      data-testid="note-output"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="font-heading text-xl md:text-2xl font-bold text-white tracking-tight">
              {note.title}
            </h2>
            {note.type && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-zinc-400 font-medium">
                {note.type}
              </span>
            )}
            {language && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-zinc-400 font-medium">
                {language}
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-400 mt-1">AI-generated summary</p>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="tap text-zinc-400 hover:text-white transition-colors duration-200 flex-shrink-0"
            aria-label="Close"
            data-testid="close-note-output"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {note.degraded && (
        <div
          className="flex items-start gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2.5"
          data-testid="degraded-banner"
        >
          <TriangleAlert size={14} className="flex-shrink-0 mt-px" />
          <span className="leading-relaxed">
            {note.degraded_reason === 'partial'
              ? 'Part of the recording could not be summarized before the AI hit its limit, so a stretch of it is missing from these notes. Your transcript is intact — regenerate later for the full set.'
              : note.degraded_reason === 'quota'
                ? 'The AI is out of quota right now, so these notes were structured locally. Your transcript is intact — regenerate later for a proper summary.'
                : 'The AI was unreachable, so these notes were structured locally. Your transcript is intact — regenerate later for a proper summary.'}
          </span>
        </div>
      )}

      <div className="space-y-5">
        {entries.map(([key, items], index) => (
          <React.Fragment key={key}>
            <Section
              sectionKey={key}
              label={sectionLabel(key, note.labels)}
              items={items}
              copied={copiedKey === key}
              onCopy={copy}
            />
            {index < entries.length - 1 && <div className="border-t border-white/5" />}
          </React.Fragment>
        ))}
      </div>

      {note.raw_transcript && (
        <div className="border-t border-white/5 pt-4">
          <button
            onClick={() => setShowTranscript((value) => !value)}
            className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-white uppercase tracking-widest font-medium transition-colors duration-200"
            aria-expanded={showTranscript}
            data-testid="toggle-transcript"
          >
            <ChevronDown
              size={13}
              className={`transition-transform duration-200 ${showTranscript ? 'rotate-180' : ''}`}
            />
            Full transcript
          </button>
          {showTranscript && (
            <motion.p
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="mt-3 text-sm text-zinc-400 leading-relaxed whitespace-pre-wrap max-h-72 overflow-y-auto pr-2"
              data-testid="transcript-body"
            >
              {note.raw_transcript}
            </motion.p>
          )}
        </div>
      )}

      <div className="space-y-3">
        <p className="text-xs text-zinc-400 uppercase tracking-widest font-medium">Tags</p>
        <div className="flex flex-wrap gap-2 items-center">
          {tags.map((tag) => (
            <span key={tag} className="tag-pill">
              {tag}
              <button
                onClick={() => setTags(tags.filter((value) => value !== tag))}
                className="tap hover:text-white transition-colors duration-200"
                aria-label={`Remove tag ${tag}`}
              >
                <X size={10} />
              </button>
            </span>
          ))}
          <div className="flex items-center gap-1">
            <Input
              value={tagInput}
              onChange={(event) => setTagInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addTag();
                }
              }}
              placeholder="Add tag…"
              className="h-7 w-28 text-xs bg-transparent border-white/10 rounded-full px-3 text-zinc-300 placeholder:text-zinc-400"
              data-testid="tag-input"
            />
            <button
              onClick={addTag}
              className="tap w-6 h-6 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-zinc-400 hover:text-white transition-colors duration-200"
              aria-label="Add tag"
              data-testid="add-tag-btn"
            >
              <Plus size={12} />
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 pt-2">
        <motion.button
          whileHover={{ scale: saved ? 1 : 1.02 }}
          whileTap={{ scale: saved ? 1 : 0.98 }}
          onClick={() => onSave({ ...note, tags })}
          disabled={isSaving || saved}
          className={`px-6 py-2.5 rounded-full text-sm font-semibold transition-colors duration-300 ${
            saved
              ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30'
              : 'bg-violet-600 hover:bg-violet-500 text-white shadow-[0_0_20px_-5px_rgba(124,58,237,0.4)]'
          }`}
          data-testid="save-note-btn"
        >
          {isSaving ? (
            'Saving…'
          ) : saved ? (
            <span className="flex items-center gap-1.5">
              <Check size={14} /> Saved
            </span>
          ) : (
            'Save note'
          )}
        </motion.button>

        <ExportButton note={{ ...note, tags }} />

        <button
          onClick={() => copy(noteToMarkdown({ ...note, tags }), '__all__')}
          className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-medium bg-white/5 hover:bg-white/10 text-zinc-300 border border-white/10 transition-colors duration-200"
          data-testid="copy-all-btn"
        >
          {copiedKey === '__all__' ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
          Copy all
        </button>
      </div>
    </motion.div>
  );
};

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Check, Copy, Tag, X, Plus } from 'lucide-react';
import { ExportButton } from './ExportButton';
import { Input } from '../components/ui/input';

// Convert snake_case or camelCase key to readable title
const formatSectionTitle = (key) => {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

export const NoteOutput = ({ note, onSave, onClose, isSaving }) => {
  const [tags, setTags] = useState(note?.tags || []);
  const [tagInput, setTagInput] = useState('');
  const [saved, setSaved] = useState(false);
  const [copiedSection, setCopiedSection] = useState('');

  if (!note) return null;

  // Support both old shape (summary/key_decisions/action_items)
  // and new dynamic shape (sections object)
  const sections = note.sections
    ? note.sections
    : {
        ...(note.summary?.length        ? { summary: note.summary }               : {}),
        ...(note.key_decisions?.length  ? { key_decisions: note.key_decisions }   : {}),
        ...(note.action_items?.length   ? { action_items: note.action_items }     : {}),
      };

  const addTag = () => {
    const trimmed = tagInput.trim().toLowerCase();
    if (trimmed && !tags.includes(trimmed)) {
      setTags([...tags, trimmed]);
      setTagInput('');
    }
  };

  const removeTag = (tag) => setTags(tags.filter((t) => t !== tag));

  const handleSave = async () => {
    await onSave({ ...note, tags });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const copyToClipboard = (text, key) => {
    navigator.clipboard.writeText(text);
    setCopiedSection(key);
    setTimeout(() => setCopiedSection(''), 1500);
  };

  const Section = ({ sectionKey, items }) => (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-xs text-zinc-500 uppercase tracking-widest font-medium">
          {formatSectionTitle(sectionKey)}
        </h4>
        <button
          onClick={() => copyToClipboard(items.join('\n'), sectionKey)}
          className="text-zinc-600 hover:text-zinc-300 transition-colors duration-200"
          data-testid={`copy-${sectionKey}`}
        >
          {copiedSection === sectionKey
            ? <Check size={12} className="text-emerald-400" />
            : <Copy size={12} />}
        </button>
      </div>
      <ul className="space-y-1.5">
        {items.map((item, i) => (
          <motion.li
            key={i}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.05 }}
            className="text-sm text-zinc-300 leading-relaxed flex items-start gap-2"
          >
            <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-violet-500 flex-shrink-0" />
            {item}
          </motion.li>
        ))}
      </ul>
    </div>
  );

  const sectionEntries = Object.entries(sections).filter(
    ([, items]) => Array.isArray(items) && items.length > 0
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 30, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="glass-card glass-card-highlight p-6 md:p-8 space-y-6"
      data-testid="note-output"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-heading text-xl md:text-2xl font-bold text-white tracking-tight">
              {note.title}
            </h2>
            {note.type && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-violet-600/20 border border-violet-500/30 text-violet-400 font-medium">
                {note.type}
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-500 mt-1">AI-generated summary</p>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 transition-colors duration-200"
            data-testid="close-note-output"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {/* Dynamic sections */}
      <div className="space-y-5">
        {sectionEntries.map(([key, items], idx) => (
          <React.Fragment key={key}>
            <Section sectionKey={key} items={items} />
            {idx < sectionEntries.length - 1 && (
              <div className="border-t border-white/5" />
            )}
          </React.Fragment>
        ))}
      </div>

      {/* Tags */}
      <div className="space-y-3">
        <p className="text-xs text-zinc-500 uppercase tracking-widest font-medium">Tags</p>
        <div className="flex flex-wrap gap-2">
          {tags.map((tag) => (
            <span key={tag} className="tag-pill">
              {tag}
              <button
                onClick={() => removeTag(tag)}
                className="hover:text-white transition-colors duration-200"
              >
                <X size={10} />
              </button>
            </span>
          ))}
          <div className="flex items-center gap-1">
            <Input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addTag()}
              placeholder="Add tag..."
              className="h-7 w-24 text-xs bg-transparent border-white/10 rounded-full px-3 text-zinc-300 placeholder:text-zinc-600"
              data-testid="tag-input"
            />
            <button
              onClick={addTag}
              className="w-6 h-6 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-zinc-400 hover:text-white transition-colors duration-200"
              data-testid="add-tag-btn"
            >
              <Plus size={12} />
            </button>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-3 pt-2">
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={handleSave}
          disabled={isSaving || saved}
          className={`px-6 py-2.5 rounded-full text-sm font-semibold transition-colors duration-300 ${
            saved
              ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30'
              : 'bg-violet-600 hover:bg-violet-500 text-white shadow-[0_0_20px_-5px_rgba(124,58,237,0.4)]'
          }`}
          data-testid="save-note-btn"
        >
          {isSaving ? 'Saving...' : saved ? (
            <span className="flex items-center gap-1.5"><Check size={14} /> Saved!</span>
          ) : 'Save Note'}
        </motion.button>

        <ExportButton note={{ ...note, sections }} />
      </div>
    </motion.div>
  );
};
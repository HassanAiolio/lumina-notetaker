import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { exportNote } from '../lib/obsidianExport';

export const ExportButton = ({ note, label = 'Export for Obsidian' }) => {
  // Fetching the cited slide pages takes a moment on a slow connection.
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!note || busy) return;
    setBusy(true);
    try {
      await exportNote(note);
    } catch (err) {
      toast.error('Could not export that note.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.button
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      onClick={run}
      disabled={busy}
      title="Markdown with properties and tags, plus the slide pages it cites"
      className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-medium bg-white/5 hover:bg-white/10 text-zinc-300 border border-white/10 transition-colors duration-200 disabled:opacity-60"
      data-testid="export-btn"
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
      {label}
    </motion.button>
  );
};

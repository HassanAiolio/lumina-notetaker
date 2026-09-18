import React from 'react';
import { motion } from 'framer-motion';
import { Download } from 'lucide-react';
import { downloadMarkdown } from '../lib/notes';

export const ExportButton = ({ note, label = 'Export .md' }) => (
  <motion.button
    whileHover={{ scale: 1.02 }}
    whileTap={{ scale: 0.98 }}
    onClick={() => note && downloadMarkdown(note)}
    className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-medium bg-white/5 hover:bg-white/10 text-zinc-300 border border-white/10 transition-colors duration-200"
    data-testid="export-btn"
  >
    <Download size={14} />
    {label}
  </motion.button>
);

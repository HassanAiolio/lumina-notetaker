import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Globe } from 'lucide-react';

export const AUTO_LANGUAGE = {
  code: 'auto',
  name: 'Detect automatically',
  native: 'Auto-detect',
  locale: 'en-US',
};

/**
 * Picks the transcription language. "Auto" is the default and is what most
 * people should leave it on; choosing explicitly helps when a recording is
 * short, noisy, or mixes languages.
 */
export const LanguageSelect = ({ value, onChange, languages = [], disabled }) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  const options = [AUTO_LANGUAGE, ...languages];
  const selected = options.find((option) => option.code === value) || AUTO_LANGUAGE;

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!containerRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        className={`flex items-center gap-2 px-3.5 py-2 rounded-full text-sm font-medium border transition-colors duration-200 ${
          disabled
            ? 'opacity-40 cursor-not-allowed border-white/5 text-zinc-400'
            : 'border-white/10 text-zinc-300 hover:text-white hover:border-white/20'
        }`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Transcription language: ${selected.native}`}
        data-testid="language-select"
      >
        <Globe size={14} className="text-violet-400" />
        <span className="truncate max-w-[9rem]">{selected.native}</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.ul
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="absolute left-0 mt-2 w-60 max-h-72 overflow-y-auto glass-card p-1.5 z-50"
            role="listbox"
            data-testid="language-options"
          >
            {options.map((option) => {
              const isSelected = option.code === selected.code;
              return (
                <li key={option.code}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(option.code);
                      setOpen(false);
                    }}
                    className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm transition-colors duration-150 ${
                      isSelected ? 'bg-violet-600/20 text-violet-300' : 'text-zinc-300 hover:bg-white/5'
                    }`}
                    role="option"
                    aria-selected={isSelected}
                    data-testid={`language-option-${option.code}`}
                  >
                    <span className="flex flex-col items-start text-left">
                      <span>{option.native}</span>
                      {option.name !== option.native && (
                        <span className="text-[11px] text-zinc-400">{option.name}</span>
                      )}
                    </span>
                    {isSelected && <Check size={14} className="flex-shrink-0" />}
                  </button>
                </li>
              );
            })}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
};

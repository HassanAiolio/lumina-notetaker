import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, RotateCcw, Shuffle, Undo2 } from 'lucide-react';
import { InlineText } from './BulletText';
import { buildDeck } from '../lib/notes';

const KIND_LABEL = {
  question: 'Question',
  definitions: 'Define',
  key_concepts: 'Explain',
  methods: 'Method',
};

const shuffled = (items) => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/**
 * Revise a note one card at a time: recall the answer, then check it.
 *
 * Cards come from the note's review questions and from every term it defines
 * or concept it explains. One you miss goes back to the end of the deck, so a
 * session ends with everything answered at least once from memory.
 */
export const ReviseDeck = ({ note }) => {
  const cards = useMemo(() => buildDeck(note), [note]);
  const [queue, setQueue] = useState(() => cards.map((_, index) => index));
  const [revealed, setRevealed] = useState(false);
  const [missed, setMissed] = useState(() => new Set());
  const [done, setDone] = useState(0);

  const restart = useCallback(
    (mix) => {
      const order = cards.map((_, index) => index);
      setQueue(mix ? shuffled(order) : order);
      setRevealed(false);
      setMissed(new Set());
      setDone(0);
    },
    [cards],
  );

  useEffect(() => restart(false), [restart]);

  const current = queue.length ? cards[queue[0]] : null;

  const grade = useCallback(
    (knew) => {
      if (!current) return;
      setRevealed(false);
      if (knew) {
        setDone((value) => value + 1);
        setQueue((value) => value.slice(1));
      } else {
        setMissed((value) => new Set(value).add(queue[0]));
        setQueue((value) => [...value.slice(1), value[0]]);
      }
    },
    [current, queue],
  );

  useEffect(() => {
    const onKey = (event) => {
      if (event.target.closest?.('input, textarea, [contenteditable="true"]')) return;
      if (!current) return;
      if (!revealed && (event.key === ' ' || event.key === 'Enter')) {
        event.preventDefault();
        setRevealed(true);
      } else if (revealed && (event.key === 'ArrowRight' || event.key === '1')) {
        grade(true);
      } else if (revealed && (event.key === 'ArrowLeft' || event.key === '2')) {
        grade(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, grade, revealed]);

  if (!cards.length) {
    return (
      <div className="text-center py-12 space-y-2" data-testid="deck-empty">
        <p className="text-sm text-zinc-300">Nothing to revise from in this note yet.</p>
        <p className="text-xs text-zinc-400 max-w-sm mx-auto leading-relaxed">
          Cards come from review questions and from defined terms. Notes generated from a lecture
          include both — regenerate an older note to get them.
        </p>
      </div>
    );
  }

  const total = cards.length;
  const firstTime = total - missed.size;

  if (!current) {
    return (
      <div className="text-center py-10 space-y-4" data-testid="deck-done">
        <div className="mx-auto w-12 h-12 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
          <Check size={20} className="text-emerald-400" />
        </div>
        <div>
          <p className="font-heading text-lg font-semibold text-white">Deck done</p>
          <p className="text-sm text-zinc-400 mt-1">
            {firstTime} of {total} right first time
            {missed.size > 0 && ` — ${missed.size} needed another go`}.
          </p>
        </div>
        <div className="flex justify-center gap-2">
          <button
            onClick={() => restart(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium bg-violet-600 hover:bg-violet-500 text-white transition-colors duration-200"
          >
            <Shuffle size={14} /> Again, shuffled
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="revise-deck">
      <div className="flex items-center justify-between text-xs text-zinc-400">
        <span>
          {done} / {total} done
          {missed.size > 0 && <span className="text-amber-400"> · {missed.size} to retry</span>}
        </span>
        <div className="flex items-center gap-3">
          <button onClick={() => restart(true)} className="flex items-center gap-1 hover:text-white transition-colors">
            <Shuffle size={12} /> Shuffle
          </button>
          <button onClick={() => restart(false)} className="flex items-center gap-1 hover:text-white transition-colors">
            <RotateCcw size={12} /> Restart
          </button>
        </div>
      </div>
      <div className="h-1 rounded-full bg-white/5 overflow-hidden">
        <motion.div
          className="h-full bg-violet-500"
          animate={{ width: `${(done / total) * 100}%` }}
          transition={{ duration: 0.3 }}
        />
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={`${queue[0]}-${done}-${missed.size}`}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          transition={{ duration: 0.2 }}
          className="rounded-2xl border border-white/10 bg-black/40 p-6 md:p-8 min-h-[220px] flex flex-col"
          data-testid="deck-card"
        >
          <span className="text-[11px] uppercase tracking-widest text-violet-300/80 font-medium">
            {KIND_LABEL[current.kind] || 'Card'}
          </span>
          <p className="mt-3 text-lg md:text-xl text-white font-medium leading-snug">
            <InlineText text={current.front} />
          </p>

          <div className="flex-1" />

          {revealed ? (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-6 space-y-5">
              <p className="text-sm md:text-base text-zinc-200 leading-relaxed border-l-2 border-violet-500/50 pl-4">
                <InlineText text={current.back} />
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => grade(true)}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 transition-colors"
                  data-testid="deck-knew"
                >
                  <Check size={14} /> Got it <kbd className="ml-1 text-[10px] opacity-60">→</kbd>
                </button>
                <button
                  onClick={() => grade(false)}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium bg-white/5 hover:bg-white/10 text-zinc-300 border border-white/10 transition-colors"
                  data-testid="deck-again"
                >
                  <Undo2 size={14} /> Again <kbd className="ml-1 text-[10px] opacity-60">←</kbd>
                </button>
              </div>
            </motion.div>
          ) : (
            <button
              onClick={() => setRevealed(true)}
              className="mt-6 self-start px-4 py-2 rounded-full text-sm font-medium bg-violet-600 hover:bg-violet-500 text-white transition-colors"
              data-testid="deck-reveal"
            >
              Show answer <kbd className="ml-1 text-[10px] opacity-70">space</kbd>
            </button>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
};

import React, { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, MicOff, Square, Sparkles, FileText, Loader2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Textarea } from '../components/ui/textarea';

const WaveformVisualizer = () => (
  <div className="flex items-center gap-[3px] h-8" data-testid="waveform-visualizer">
    {[...Array(12)].map((_, i) => (
      <div
        key={i}
        className="w-[3px] bg-violet-500 rounded-full waveform-bar"
        style={{
          animationDelay: `${i * 0.08}s`,
          animationDuration: `${0.5 + Math.random() * 0.5}s`,
        }}
      />
    ))}
  </div>
);

export const Recorder = ({
  transcript,
  interimText,
  isListening,
  isSupported,
  isSummarizing,
  onStartListening,
  onStopListening,
  onSummarize,
  onTranscriptChange,
}) => {
  const [mode, setMode] = useState('voice'); // 'voice' | 'text'
  const hasContent = (transcript + interimText).trim().length > 0;

  const handleSummarize = useCallback(() => {
    if (isListening) onStopListening();
    onSummarize();
  }, [isListening, onStopListening, onSummarize]);

  return (
    <div className="w-full space-y-6">
      {/* Mode Toggle */}
      <div className="flex items-center gap-2" data-testid="mode-toggle">
        <button
          onClick={() => setMode('voice')}
          className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-colors duration-200 ${
            mode === 'voice'
              ? 'bg-violet-600/20 text-violet-300 border border-violet-500/30'
              : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
          }`}
          data-testid="voice-mode-btn"
        >
          <Mic size={14} />
          Voice
        </button>
        <button
          onClick={() => setMode('text')}
          className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-colors duration-200 ${
            mode === 'text'
              ? 'bg-violet-600/20 text-violet-300 border border-violet-500/30'
              : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
          }`}
          data-testid="text-mode-btn"
        >
          <FileText size={14} />
          Text
        </button>
      </div>

      {mode === 'voice' ? (
        <div className="space-y-6">
          {/* Record Button */}
          <div className="flex flex-col items-center gap-4">
            <div className="relative">
              {isListening && (
                <>
                  <div className="absolute inset-0 rounded-full bg-violet-500/20 recording-pulse" />
                  <div className="absolute inset-0 rounded-full bg-violet-500/10 recording-pulse" style={{ animationDelay: '0.5s' }} />
                </>
              )}
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={isListening ? onStopListening : onStartListening}
                disabled={!isSupported}
                className={`relative z-10 w-20 h-20 rounded-full flex items-center justify-center transition-colors duration-300 ${
                  isListening
                    ? 'bg-red-500/20 border-2 border-red-500 text-red-400'
                    : 'bg-violet-600/20 border-2 border-violet-500 text-violet-400 hover:bg-violet-600/30'
                } ${!isSupported ? 'opacity-40 cursor-not-allowed' : ''}`}
                data-testid="record-btn"
              >
                {isListening ? <Square size={28} /> : <Mic size={28} />}
              </motion.button>
            </div>

            <AnimatePresence>
              {isListening && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="flex flex-col items-center gap-2"
                >
                  <WaveformVisualizer />
                  <span className="text-xs text-red-400 font-medium uppercase tracking-widest">Recording</span>
                </motion.div>
              )}
            </AnimatePresence>

            {!isSupported && (
              <p className="text-xs text-zinc-500">
                Voice recording not supported in this browser. Use text mode instead.
              </p>
            )}
          </div>

          {/* Live Transcript */}
          <AnimatePresence>
            {(transcript || interimText) && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="glass-card glass-card-highlight p-5"
                data-testid="live-transcript"
              >
                <p className="text-xs text-zinc-500 uppercase tracking-widest mb-3 font-medium">Live Transcript</p>
                <p className="text-zinc-200 leading-relaxed text-sm">
                  {transcript}
                  {interimText && <span className="text-zinc-500 italic">{interimText}</span>}
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ) : (
        /* Text Input Mode */
        <div className="space-y-4">
          <Textarea
            value={transcript}
            onChange={(e) => onTranscriptChange(e.target.value)}
            placeholder="Paste your raw notes or meeting transcript here..."
            className="min-h-[200px] bg-black/50 border-white/10 text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30 resize-none rounded-xl"
            data-testid="text-input"
          />
        </div>
      )}

      {/* Summarize Button */}
      <AnimatePresence>
        {hasContent && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
          >
            <Button
              onClick={handleSummarize}
              disabled={isSummarizing || !hasContent}
              className="w-full h-12 rounded-full bg-violet-600 hover:bg-violet-500 text-white font-semibold text-sm shadow-[0_0_30px_-5px_rgba(124,58,237,0.5)] transition-colors duration-300"
              data-testid="summarize-btn"
            >
              {isSummarizing ? (
                <span className="flex items-center gap-2">
                  <Loader2 size={16} className="animate-spin" />
                  AI is thinking...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Sparkles size={16} />
                  Stop & Summarize
                </span>
              )}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

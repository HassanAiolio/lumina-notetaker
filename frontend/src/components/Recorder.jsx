import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle, Download, FileText, Loader2, Mic, Pause, Play, RotateCcw, Sparkles, Square, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { LanguageSelect } from './LanguageSelect';
import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import { formatDuration, toWavChunks } from '../lib/audio';
import { errorMessage, transcribeChunk } from '../services/api';
import { languageName } from '../lib/notes';

const LevelMeter = ({ levels, paused }) => (
  <div className="flex items-center justify-center gap-[3px] h-10" aria-hidden data-testid="level-meter">
    {levels.map((level, index) => (
      <div
        key={index}
        className={`w-[3px] rounded-full transition-[height,background-color] duration-75 ${
          paused ? 'bg-zinc-600' : 'bg-violet-500'
        }`}
        style={{ height: `${Math.max(3, level * 40)}px` }}
      />
    ))}
  </div>
);

export const Recorder = ({
  transcript,
  onTranscriptChange,
  language,
  onLanguageChange,
  languages,
  isSummarizing,
  onSummarize,
  onRecordingChange,
  onTranscribingChange,
  onDetectedLanguage,
  audioLevelRef,
}) => {
  const [mode, setMode] = useState('voice');
  const [stage, setStage] = useState('idle'); // idle | encoding | transcribing
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [pipelineError, setPipelineError] = useState('');
  // The last recording is kept so a failed transcription can be retried, or the
  // audio downloaded, instead of asking someone to say it all again.
  const [pendingAudio, setPendingAudio] = useState(null);

  const recorder = useAudioRecorder({
    levelRef: audioLevelRef,
    onMaxDuration: () => {
      toast.warning('Maximum recording length reached — wrapping up.');
      handleStop();
    },
  });
  const speech = useSpeechRecognition();
  const abortRef = useRef(null);

  const busy = stage !== 'idle';
  const hasTranscript = transcript.trim().length > 0;

  useEffect(() => {
    onRecordingChange?.(recorder.isRecording && !recorder.isPaused);
  }, [recorder.isRecording, recorder.isPaused, onRecordingChange]);

  // The 3D scene has the pen write while a transcript is being produced.
  useEffect(() => {
    onTranscribingChange?.(busy);
  }, [busy, onTranscribingChange]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const localeFor = useCallback(
    (code) => languages.find((entry) => entry.code === code)?.locale || 'en-US',
    [languages],
  );

  /** Send the recording to the server one chunk at a time. */
  const runTranscription = useCallback(
    async (blob) => {
      setPipelineError('');
      setStage('encoding');

      let chunks;
      try {
        chunks = await toWavChunks(blob);
      } catch (err) {
        setStage('idle');
        setPipelineError(err.message || 'The recording could not be prepared for transcription.');
        return;
      }

      setStage('transcribing');
      setProgress({ done: 0, total: chunks.length });

      const controller = new AbortController();
      abortRef.current = controller;

      const pieces = [];
      let context = '';
      let detected = '';

      try {
        for (let index = 0; index < chunks.length; index += 1) {
          const result = await transcribeChunk({
            blob: chunks[index].blob,
            language,
            context,
            signal: controller.signal,
          });
          if (result.text) {
            pieces.push(result.text);
            context = result.text;
          }
          if (!detected && result.language && result.language !== 'auto') {
            detected = result.language;
          }
          setProgress({ done: index + 1, total: chunks.length });
        }
      } catch (err) {
        if (controller.signal.aborted) {
          setStage('idle');
          return;
        }
        setStage('idle');
        // Whatever came back before the failure is still worth keeping.
        if (pieces.length) {
          onTranscriptChange([transcript, pieces.join(' ')].filter(Boolean).join(' ').trim());
          setPipelineError(
            'Only part of the recording could be transcribed. The text so far is below, and the audio is kept if you want to retry.',
          );
        } else {
          setPipelineError(errorMessage(err, 'Transcription failed.'));
        }
        return;
      } finally {
        abortRef.current = null;
      }

      setStage('idle');
      const text = pieces.join(' ').trim();

      if (!text) {
        setPipelineError('No speech was detected in that recording.');
        return;
      }

      setPendingAudio(null);
      if (detected) onDetectedLanguage?.(detected);
      onTranscriptChange([transcript, text].filter(Boolean).join(' ').trim());
      toast.success(
        detected ? `Transcribed (${languageName(detected) || detected})` : 'Transcribed',
      );
    },
    [language, onDetectedLanguage, onTranscriptChange, transcript],
  );

  const handleStart = useCallback(async () => {
    setPipelineError('');
    setPendingAudio(null);
    speech.reset();
    const started = await recorder.start();
    if (started) speech.start(localeFor(language));
  }, [language, localeFor, recorder, speech]);

  const handleStop = useCallback(async () => {
    speech.stop();
    const blob = await recorder.stop();
    if (!blob) {
      setPipelineError('Nothing was recorded. Check that your microphone is working.');
      return;
    }
    setPendingAudio(blob);
    await runTranscription(blob);
  }, [recorder, runTranscription, speech]);

  const handleDiscard = useCallback(async () => {
    speech.stop();
    await recorder.cancel();
    setPendingAudio(null);
    setPipelineError('');
  }, [recorder, speech]);

  const handleDownloadAudio = useCallback(() => {
    if (!pendingAudio) return;
    const url = URL.createObjectURL(pendingAudio);
    const link = document.createElement('a');
    link.href = url;
    link.download = `recording-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.webm`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [pendingAudio]);

  const liveText = `${speech.captions}${speech.interim}`.trim();
  const nearLimit = recorder.seconds > recorder.maxSeconds - 120;

  return (
    <div className="w-full space-y-6">
      {/* Mode + language */}
      <div className="flex flex-wrap items-center gap-2" data-testid="mode-toggle">
        {[
          { id: 'voice', label: 'Voice', icon: Mic },
          { id: 'text', label: 'Text', icon: FileText },
        ].map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setMode(id)}
            disabled={recorder.isRecording || busy}
            className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium border transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed ${
              mode === id
                ? 'bg-violet-600/20 text-violet-300 border-violet-500/30'
                : 'text-zinc-400 hover:text-white border-transparent'
            }`}
            data-testid={`${id}-mode-btn`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}

        <div className="ml-auto">
          <LanguageSelect
            value={language}
            onChange={onLanguageChange}
            languages={languages}
            disabled={recorder.isRecording || busy}
          />
        </div>
      </div>

      {mode === 'voice' ? (
        <div className="space-y-6">
          <div className="flex flex-col items-center gap-4">
            <div className="relative">
              {recorder.isRecording && !recorder.isPaused && (
                <>
                  <div className="absolute inset-0 rounded-full bg-violet-500/20 recording-pulse" />
                  <div
                    className="absolute inset-0 rounded-full bg-violet-500/10 recording-pulse"
                    style={{ animationDelay: '0.5s' }}
                  />
                </>
              )}
              <motion.button
                whileHover={{ scale: busy ? 1 : 1.05 }}
                whileTap={{ scale: busy ? 1 : 0.95 }}
                onClick={recorder.isRecording ? handleStop : handleStart}
                disabled={!recorder.isSupported || busy}
                className={`relative z-10 w-20 h-20 rounded-full flex items-center justify-center transition-colors duration-300 ${
                  recorder.isRecording
                    ? 'bg-red-500/20 border-2 border-red-500 text-red-400'
                    : 'bg-violet-600/20 border-2 border-violet-500 text-violet-400 hover:bg-violet-600/30'
                } ${!recorder.isSupported || busy ? 'opacity-40 cursor-not-allowed' : ''}`}
                aria-label={recorder.isRecording ? 'Stop recording' : 'Start recording'}
                data-testid="record-btn"
              >
                {busy ? (
                  <Loader2 size={28} className="animate-spin" />
                ) : recorder.isRecording ? (
                  <Square size={28} />
                ) : (
                  <Mic size={28} />
                )}
              </motion.button>
            </div>

            <AnimatePresence mode="wait">
              {recorder.isRecording && (
                <motion.div
                  key="recording"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="flex flex-col items-center gap-3 w-full"
                >
                  <LevelMeter levels={recorder.levels} paused={recorder.isPaused} />
                  <div className="flex items-center gap-3">
                    <span
                      className={`font-mono text-sm tabular-nums ${nearLimit ? 'text-amber-400' : 'text-zinc-300'}`}
                      data-testid="record-timer"
                    >
                      {formatDuration(recorder.seconds)}
                    </span>
                    <span
                      className={`text-[11px] font-medium uppercase tracking-widest ${
                        recorder.isPaused ? 'text-zinc-400' : 'text-red-400'
                      }`}
                    >
                      {recorder.isPaused ? 'Paused' : 'Recording'}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={recorder.isPaused ? recorder.resume : recorder.pause}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white/5 hover:bg-white/10 text-zinc-300 border border-white/10 transition-colors duration-200"
                      data-testid="pause-btn"
                    >
                      {recorder.isPaused ? <Play size={12} /> : <Pause size={12} />}
                      {recorder.isPaused ? 'Resume' : 'Pause'}
                    </button>
                    <button
                      onClick={handleDiscard}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white/5 hover:bg-red-500/10 text-zinc-400 hover:text-red-400 border border-white/10 transition-colors duration-200"
                      data-testid="discard-btn"
                    >
                      <Trash2 size={12} />
                      Discard
                    </button>
                  </div>
                </motion.div>
              )}

              {busy && (
                <motion.div
                  key="busy"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="flex flex-col items-center gap-2"
                  data-testid="transcribe-progress"
                >
                  <span className="text-sm text-zinc-300">
                    {stage === 'encoding'
                      ? 'Preparing audio…'
                      : progress.total > 1
                        ? `Transcribing part ${progress.done + 1} of ${progress.total}…`
                        : 'Transcribing…'}
                  </span>
                  {stage === 'transcribing' && progress.total > 1 && (
                    <div className="w-48 h-1 rounded-full bg-white/5 overflow-hidden">
                      <motion.div
                        className="h-full bg-violet-500"
                        animate={{ width: `${(progress.done / progress.total) * 100}%` }}
                        transition={{ duration: 0.3 }}
                      />
                    </div>
                  )}
                  <button
                    onClick={() => abortRef.current?.abort()}
                    className="text-xs text-zinc-400 hover:text-white transition-colors duration-200"
                  >
                    Cancel
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            {!recorder.isSupported && (
              <p className="text-xs text-zinc-400 text-center max-w-sm">
                This browser cannot record audio. Switch to the Text tab and paste your notes
                instead.
              </p>
            )}
          </div>

          {/* Live captions while recording — a preview, not the saved transcript */}
          <AnimatePresence>
            {recorder.isRecording && liveText && (
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="glass-card glass-card-highlight p-5"
                data-testid="live-captions"
              >
                <p className="text-xs text-zinc-400 uppercase tracking-widest mb-3 font-medium">
                  Live preview
                </p>
                <p className="text-zinc-300 leading-relaxed text-sm">
                  {speech.captions}
                  {speech.interim && <span className="text-zinc-400 italic">{speech.interim}</span>}
                </p>
                <p className="text-[11px] text-zinc-400 mt-3">
                  A rough preview from your browser. The saved transcript is produced from the audio
                  when you stop.
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ) : (
        <Textarea
          value={transcript}
          onChange={(event) => onTranscriptChange(event.target.value)}
          placeholder="Paste your raw notes or meeting transcript here…"
          className="min-h-[220px] bg-black/50 border-white/10 text-zinc-200 placeholder:text-zinc-400 focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30 resize-y rounded-xl"
          data-testid="text-input"
        />
      )}

      {/* Errors, with the escape hatches that keep a recording from being lost */}
      <AnimatePresence>
        {(pipelineError || recorder.error) && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="flex flex-col gap-3 text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3"
            role="alert"
            data-testid="recorder-error"
          >
            <div className="flex items-start gap-2">
              <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />
              <span className="leading-relaxed">{pipelineError || recorder.error}</span>
            </div>
            {pendingAudio && (
              <div className="flex flex-wrap gap-2 pl-6">
                <button
                  onClick={() => runTranscription(pendingAudio)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white/5 hover:bg-white/10 text-zinc-200 border border-white/10 transition-colors duration-200"
                  data-testid="retry-transcription-btn"
                >
                  <RotateCcw size={12} />
                  Retry transcription
                </button>
                <button
                  onClick={handleDownloadAudio}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white/5 hover:bg-white/10 text-zinc-200 border border-white/10 transition-colors duration-200"
                >
                  <Download size={12} />
                  Save the audio
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Transcript, editable before summarizing */}
      <AnimatePresence>
        {mode === 'voice' && hasTranscript && !recorder.isRecording && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="glass-card glass-card-highlight p-5 space-y-3"
            data-testid="transcript-panel"
          >
            <div className="flex items-center justify-between">
              <p className="text-xs text-zinc-400 uppercase tracking-widest font-medium">
                Transcript
              </p>
              <button
                onClick={() => onTranscriptChange('')}
                className="text-xs text-zinc-400 hover:text-red-400 transition-colors duration-200"
                data-testid="clear-transcript-btn"
              >
                Clear
              </button>
            </div>
            <Textarea
              value={transcript}
              onChange={(event) => onTranscriptChange(event.target.value)}
              className="min-h-[140px] bg-black/40 border-white/10 text-zinc-200 focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30 resize-y rounded-lg text-sm"
              data-testid="transcript-editor"
            />
            <p className="text-[11px] text-zinc-400">
              Fix anything that came out wrong before generating your notes.
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {hasTranscript && !recorder.isRecording && (
          <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }}>
            <Button
              onClick={onSummarize}
              disabled={isSummarizing || busy}
              className="w-full h-12 rounded-full bg-violet-600 hover:bg-violet-500 text-white font-semibold text-sm shadow-[0_0_30px_-5px_rgba(124,58,237,0.5)] transition-colors duration-300"
              data-testid="summarize-btn"
            >
              {isSummarizing ? (
                <span className="flex items-center gap-2">
                  <Loader2 size={16} className="animate-spin" />
                  Structuring your notes…
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Sparkles size={16} />
                  Generate notes
                </span>
              )}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

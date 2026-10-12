import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle, Download, FileText, Loader2, Mic, Pause, Play, RotateCcw, Sparkles, Square, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { LanguageSelect } from './LanguageSelect';
import { SlidesPicker } from './Slides';
import { DeviceRecordings } from './DeviceRecordings';
import { useAuth } from '../contexts/AuthContext';
import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import {
  AudioDecodeError,
  chunkSecondsForConnection,
  createSegmentQueue,
  estimateChunkCount,
  formatDuration,
  toSingleWav,
} from '../lib/audio';
import { freshProgress, isCancel, transcribeSegments } from '../lib/transcription';
import {
  deleteRecording,
  keepRecording,
  listRecordings,
  loadRecording,
  pruneRecordings,
} from '../lib/recordingStore';
import { errorMessage } from '../services/api';
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

/**
 * What to tell someone when the audio never got as far as the server. These
 * failures all used to read "could not be decoded by this browser", which sent
 * people looking for a browser problem when they had really just recorded for
 * longer than the device could prepare in one go.
 */
const decodeErrorMessage = (err) => {
  switch (err?.reason) {
    case 'empty':
      return 'That recording contains no audio. Check that your microphone is working.';
    case 'unsupported':
      return 'This browser cannot process audio. Try Chrome, Edge, Firefox or Safari, or use the Text tab.';
    case 'exhausted':
      return 'This device ran out of memory while preparing the audio. Your recording is kept — save it, close some tabs, and try again.';
    default:
      return err?.message || 'The recording could not be prepared for transcription.';
  }
};

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
  onSessionChange,
  deck,
  onDeck,
  audioLevelRef,
}) => {
  const [mode, setMode] = useState('voice');
  const [stage, setStage] = useState('idle'); // idle | transcribing
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [pipelineError, setPipelineError] = useState('');
  // The live run gave up mid-recording; whatever is left is done after stop.
  const [liveStalled, setLiveStalled] = useState(false);
  // The last recording is kept so a failed transcription can be retried, or the
  // audio downloaded, instead of asking someone to say it all again. It holds
  // the capture segments rather than one blob, which is also what the
  // transcription pipeline wants back on a retry.
  const [pendingRecording, setPendingRecording] = useState(null);
  // Joining segments into one file decodes the whole recording, so it is not
  // instant on a long one and needs to say so.
  const [joining, setJoining] = useState(null);
  // Discard asks twice: one stray tap used to throw away a whole lecture.
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Recordings kept on this device (lib/recordingStore), and the one whose
  // audio is being read back, if any.
  const { user } = useAuth();
  const owner = user?.id || '';
  const [stored, setStored] = useState([]);
  const [working, setWorking] = useState(null);
  const refreshStored = useCallback(async () => setStored(await listRecordings(owner)), [owner]);
  useEffect(() => {
    refreshStored();
  }, [refreshStored]);

  // The transcription run in progress while recording: segments go into its
  // queue as they close, and it works through them as the lecture goes on.
  const liveRef = useRef(null);
  // Where the recording under way is being kept, second by second.
  const keepRef = useRef(null);

  const recorder = useAudioRecorder({
    levelRef: audioLevelRef,
    onSegment: (blob) => liveRef.current?.queue.push(blob),
    onData: (blob, segment) => keepRef.current?.add(blob, segment),
    onMaxDuration: () => {
      toast.warning('Maximum recording length reached — wrapping up.');
      handleStop();
    },
  });
  const speech = useSpeechRecognition();
  const abortRef = useRef(null);
  const stoppingRef = useRef(false);

  // Chunks land one at a time, often long after the render that started the
  // run, so appending goes through a ref rather than a stale `transcript`.
  const transcriptRef = useRef(transcript);
  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);
  const writeTranscript = useCallback(
    (value) => {
      transcriptRef.current = value;
      onTranscriptChange(value);
    },
    [onTranscriptChange],
  );
  // Each chunk goes into the transcript (and so the saved draft) as soon as it
  // is back, so a tab that dies an hour in still leaves an hour of text.
  const appendText = useCallback(
    (text) => {
      if (text) writeTranscript([transcriptRef.current, text].filter(Boolean).join(' ').trim());
    },
    [writeTranscript],
  );
  const onChunk = useCallback(
    (text, { done }) => {
      appendText(text);
      setProgress((previous) => ({ done, total: Math.max(previous.total, done) }));
    },
    [appendText],
  );

  const busy = stage !== 'idle';
  const hasTranscript = transcript.trim().length > 0;

  useEffect(() => {
    onRecordingChange?.(recorder.isRecording && !recorder.isPaused);
  }, [recorder.isRecording, recorder.isPaused, onRecordingChange]);

  // The 3D scene has the pen write while a transcript is being produced.
  useEffect(() => {
    onTranscribingChange?.(busy);
  }, [busy, onTranscribingChange]);

  // Paused counts too: leaving this view unmounts the recorder, which stops
  // the microphone and drops the audio.
  useEffect(() => {
    onSessionChange?.(recorder.isRecording || busy);
  }, [busy, onSessionChange, recorder.isRecording]);

  useEffect(() => {
    if (recorder.isRecording && recorder.seconds) keepRef.current?.update({ seconds: recorder.seconds });
  }, [recorder.isRecording, recorder.seconds]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      liveRef.current?.controller.abort();
      liveRef.current?.queue.close();
      keepRef.current?.close();
    },
    [],
  );

  const localeFor = useCallback(
    (code) => languages.find((entry) => entry.code === code)?.locale || 'en-US',
    [languages],
  );

  /**
   * A recording is fully transcribed: keep its audio and report. Notes are not
   * made from it until the user asks, so there is time to add slides or fix
   * the transcript first.
   */
  const finishRecording = useCallback(
    (recording, progress) => {
      recording.keep?.update({ progress, complete: !!progress.context });
      recording.keep?.close().then(refreshStored);
      // context only ever holds text a chunk returned, so empty means silence.
      if (!progress.context) {
        setPendingRecording({ ...recording, progress });
        setPipelineError('No speech was detected in that recording.');
        return;
      }
      // The audio stays until the next recording, so a transcript that came
      // out wrong can still be saved and redone.
      setPendingRecording({ ...recording, progress, complete: true });
      if (progress.detected) onDetectedLanguage?.(progress.detected);
      toast.success(
        progress.detected
          ? `Transcribed (${languageName(progress.detected) || progress.detected})`
          : 'Transcribed',
        { description: 'Review it, add slides if you have them, then Generate notes.' },
      );
    },
    [onDetectedLanguage, refreshStored],
  );

  /**
   * A run stopped part-way. Every chunk it finished is already in the
   * transcript, so the recording remembers where it got to and a retry only
   * does the rest - transcribing from the top used to append the opening of
   * the recording a second time.
   */
  const failRecording = useCallback((recording, err, fallbackProgress) => {
    const progress = err?.progress || fallbackProgress;
    recording.keep?.update({ progress });
    recording.keep?.close().then(refreshStored);
    setPendingRecording({ ...recording, progress });
    if (isCancel(err)) {
      setPipelineError('Transcription stopped. The text so far is kept; retry to do the rest.');
    } else if (err instanceof AudioDecodeError) {
      setPipelineError(decodeErrorMessage(err));
    } else if (progress.done > 0) {
      setPipelineError(
        `${errorMessage(err, 'Transcription failed.')} The text so far is below, and retrying picks up where it stopped.`,
      );
    } else {
      setPipelineError(errorMessage(err, 'Transcription failed.'));
    }
  }, [refreshStored]);

  /** Transcribe a finished recording, from wherever an earlier run stopped. */
  const runTranscription = useCallback(
    async (recording) => {
      const segments = recording?.segments || [];
      if (!segments.length) {
        setPipelineError('Nothing was recorded. Check that your microphone is working.');
        return;
      }
      // The chunk length is pinned with the progress, so the cut points line
      // up with the earlier run even if the connection has changed since.
      const start = recording.progress || freshProgress(chunkSecondsForConnection());

      setPipelineError('');
      setStage('transcribing');
      // Chunks arrive lazily, so the real total is only known at the end. The
      // recorded length estimates it to within one chunk.
      setProgress({ done: start.done, total: estimateChunkCount(recording.seconds, start.chunkSeconds) });

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const progress = await transcribeSegments(segments, {
          language,
          progress: start,
          signal: controller.signal,
          onChunk: (text, chunkProgress) => {
            recording.keep?.chunk(text, chunkProgress);
            onChunk(text, chunkProgress);
          },
        });
        finishRecording(recording, progress);
      } catch (err) {
        failRecording(recording, err, start);
      } finally {
        abortRef.current = null;
        setStage('idle');
      }
    },
    [failRecording, finishRecording, language, onChunk],
  );

  /**
   * Start transcribing while the recording is still going.
   *
   * Each segment is chunked and sent the moment the recorder closes it, so by
   * the end of a lecture all but its last few minutes are already text. This
   * used to wait for stop and then do the whole recording in series - half an
   * hour of chunks one after another for a two hour lecture.
   */
  const startLive = useCallback((keep) => {
    const controller = new AbortController();
    const live = {
      queue: createSegmentQueue(),
      controller,
      // Kept so discarding the recording can take its text back out.
      base: transcriptRef.current,
      progress: freshProgress(chunkSecondsForConnection()),
      error: null,
    };
    live.promise = transcribeSegments(live.queue, {
      language,
      progress: live.progress,
      signal: controller.signal,
      // The lecture has time to spare; a dropped connection should not hand
      // the rest of it back to the end.
      retries: 2,
      onChunk: (text, progress) => {
        live.progress = progress;
        keep?.chunk(text, progress);
        onChunk(text, progress);
      },
    }).catch((err) => {
      live.error = err;
      if (err.progress) live.progress = err.progress;
      if (!controller.signal.aborted) setLiveStalled(true);
    });
    liveRef.current = live;
  }, [language, onChunk]);

  /** After stop: let the live run do the last stretch, or pick up where it failed. */
  const finishLive = useCallback(
    async (recording, live) => {
      setStage('transcribing');
      setProgress({
        done: live.progress.done,
        total: Math.max(live.progress.done, estimateChunkCount(recording.seconds, live.progress.chunkSeconds)),
      });
      abortRef.current = live.controller;
      live.queue.close();
      await live.promise;
      abortRef.current = null;
      setStage('idle');
      setLiveStalled(false);

      if (!live.error) {
        finishRecording(recording, live.progress);
      } else if (isCancel(live.error) || live.error instanceof AudioDecodeError) {
        failRecording(recording, live.error, live.progress);
      } else {
        // It already retried during the lecture, but that was minutes ago.
        await runTranscription({ ...recording, progress: live.progress });
      }
    },
    [failRecording, finishRecording, runTranscription],
  );

  const handleStart = useCallback(async () => {
    setPipelineError('');
    setPendingRecording(null);
    setLiveStalled(false);
    setProgress({ done: 0, total: 0 });
    setConfirmDiscard(false);
    speech.reset();
    // Room for this one among the recordings kept on the device.
    await pruneRecordings();
    const keep = keepRecording({
      owner,
      onError: () =>
        toast.warning('This device has no room left to keep a copy of the recording.', {
          description: 'Recording and transcription carry on as normal.',
        }),
    });
    keepRef.current = keep;
    // Ready before the recorder starts, so no segment can arrive to nobody.
    startLive(keep);
    const started = await recorder.start();
    if (started) {
      speech.start(localeFor(language));
    } else {
      liveRef.current?.controller.abort();
      liveRef.current?.queue.close();
      liveRef.current = null;
      keepRef.current = null;
      keep.close().then(() => deleteRecording(keep.id));
    }
    refreshStored();
  }, [language, localeFor, owner, recorder, refreshStored, speech, startLive]);

  const handleStop = useCallback(async () => {
    // The button stays live until the recorder has finished closing, and a
    // second press would split the segments between two transcriptions.
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    try {
      speech.stop();
      // Stopping banks the final segment, which goes to the live run's queue.
      const stopped = await recorder.stop();
      const live = liveRef.current;
      liveRef.current = null;
      // Only now: the recorder hands over its last second while stopping.
      const keep = keepRef.current;
      keepRef.current = null;
      if (!stopped) {
        live?.controller.abort();
        live?.queue.close();
        keep?.close().then(() => deleteRecording(keep.id));
        setPipelineError('Nothing was recorded. Check that your microphone is working.');
        return;
      }
      keep?.update({ seconds: stopped.seconds });
      keep?.flush();
      const recording = { ...stopped, id: keep?.id, keep };
      setPendingRecording(recording);
      if (live) await finishLive(recording, live);
      else await runTranscription(recording);
    } finally {
      stoppingRef.current = false;
    }
  }, [finishLive, recorder, runTranscription, speech]);

  const handleDiscard = useCallback(async () => {
    setConfirmDiscard(false);
    speech.stop();
    const live = liveRef.current;
    liveRef.current = null;
    live?.controller.abort();
    live?.queue.close();
    await recorder.cancel();
    // What the live run already wrote belongs to the recording being thrown away.
    if (live) writeTranscript(live.base);
    setPendingRecording(null);
    setPipelineError('');
    setLiveStalled(false);
    setProgress({ done: 0, total: 0 });
    // Gone from the screen, but not yet from the device: a discard can be a
    // mistake, and this is the only copy of the lecture.
    const keep = keepRef.current;
    keepRef.current = null;
    if (keep) {
      keep.update({ discarded: true });
      await keep.close();
      refreshStored();
      toast('Recording discarded', {
        description: 'A copy stays under "Kept on this device" in case you need it.',
      });
    }
  }, [recorder, refreshStored, speech, writeTranscript]);

  /** Clear the transcript, with a way back for a few seconds. */
  const handleClear = useCallback(() => {
    const previous = transcriptRef.current;
    writeTranscript('');
    toast('Transcript cleared', {
      duration: 10000,
      action: {
        label: 'Undo',
        onClick: () => writeTranscript([previous, transcriptRef.current].filter(Boolean).join('\n\n')),
      },
    });
  }, [writeTranscript]);

  /**
   * Put a kept recording's transcript back in the editor. Added after what is
   * there rather than over it, and skipped if it is already there.
   */
  const restoreText = useCallback(
    (meta, { quiet = false } = {}) => {
      const text = (meta.text || '').trim();
      if (!text) return;
      if (meta.progress?.detected) onDetectedLanguage?.(meta.progress.detected);
      const previous = transcriptRef.current;
      if (previous.includes(text)) {
        if (!quiet) toast('That transcript is already in the editor.');
        return;
      }
      writeTranscript([previous.trim(), text].filter(Boolean).join('\n\n'));
      if (!quiet) {
        toast.success('Transcript restored', {
          action: { label: 'Undo', onClick: () => writeTranscript(previous) },
        });
      }
    },
    [onDetectedLanguage, writeTranscript],
  );


  const saveFile = useCallback((blob, name) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  /**
   * Save the recording as one file.
   *
   * Recording happens in segments, but nobody wants sixteen of them in their
   * downloads folder, and stitching WebM containers back together by hand does
   * not produce a playable file. So the segments are decoded and written out as
   * a single WAV. A recording short enough to be one segment is already one
   * file, and is saved untouched rather than re-encoded.
   */
  const handleDownloadAudio = useCallback(async (recording) => {
    const segments = recording?.segments || [];
    if (!segments.length || joining) return;

    const stamp = new Date(recording.meta?.startedAt || Date.now()).toISOString().slice(0, 19).replace(/[:T]/g, '-');

    if (segments.length === 1) {
      const extension = (recording.mimeType || '').includes('mp4') ? 'm4a' : 'webm';
      saveFile(segments[0], `recording-${stamp}.${extension}`);
      return;
    }

    setJoining({ done: 0, total: segments.length });
    try {
      const blob = await toSingleWav(segments, {
        onProgress: (done, total) => setJoining({ done, total }),
      });
      saveFile(blob, `recording-${stamp}.wav`);
    } catch (err) {
      setPipelineError(
        err instanceof AudioDecodeError
          ? decodeErrorMessage(err)
          : 'The recording could not be saved as one file.',
      );
    } finally {
      setJoining(null);
    }
  }, [joining, saveFile]);

  /** Read a kept recording's audio back off the device. */
  const readStored = useCallback(async (meta) => {
    setWorking(meta.id);
    try {
      const recording = await loadRecording(meta.id);
      if (!recording) toast.error('The audio of that recording could not be read back.');
      return recording;
    } finally {
      setWorking(null);
    }
  }, []);

  const saveStoredAudio = useCallback(
    async (meta) => {
      const recording = await readStored(meta);
      if (recording) await handleDownloadAudio(recording);
    },
    [handleDownloadAudio, readStored],
  );

  /**
   * Transcribe the rest of a kept recording - after a reload, a crash or a
   * discard - from the chunk it got to. What was already done is not sent again.
   */
  const continueStored = useCallback(
    async (meta) => {
      const loaded = await readStored(meta);
      if (!loaded) return;
      restoreText(meta, { quiet: true });
      setMode('voice');
      const keep = keepRecording({ meta: loaded.meta });
      keep.update({ discarded: false });
      const recording = { ...loaded, keep, progress: meta.progress || undefined };
      setPendingRecording(recording);
      await runTranscription(recording);
    },
    [readStored, restoreText, runTranscription],
  );

  const deleteStored = useCallback(
    async (meta) => {
      await deleteRecording(meta.id);
      refreshStored();
    },
    [refreshStored],
  );

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

        {onDeck && <SlidesPicker deck={deck} onDeck={onDeck} disabled={isSummarizing} />}

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

                  {(progress.done > 0 || liveStalled) && (
                    <p className="text-[11px] text-zinc-400 text-center" data-testid="live-progress">
                      {liveStalled
                        ? 'Live transcription paused — the rest is done when you stop.'
                        : `About ${Math.round((progress.done * (liveRef.current?.progress.chunkSeconds || 0)) / 60)} min already transcribed`}
                    </p>
                  )}

                  <div className="flex items-center gap-2">
                    <button
                      onClick={recorder.isPaused ? recorder.resume : recorder.pause}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white/5 hover:bg-white/10 text-zinc-300 border border-white/10 transition-colors duration-200"
                      data-testid="pause-btn"
                    >
                      {recorder.isPaused ? <Play size={12} /> : <Pause size={12} />}
                      {recorder.isPaused ? 'Resume' : 'Pause'}
                    </button>
                    {confirmDiscard ? (
                      <>
                        <button
                          onClick={handleDiscard}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/30 transition-colors duration-200"
                          data-testid="confirm-discard-btn"
                        >
                          <Trash2 size={12} />
                          Discard {formatDuration(recorder.seconds)}?
                        </button>
                        <button
                          onClick={() => setConfirmDiscard(false)}
                          className="px-3 py-1.5 rounded-full text-xs font-medium bg-white/5 hover:bg-white/10 text-zinc-300 border border-white/10 transition-colors duration-200"
                        >
                          Keep recording
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setConfirmDiscard(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white/5 hover:bg-red-500/10 text-zinc-400 hover:text-red-400 border border-white/10 transition-colors duration-200"
                        data-testid="discard-btn"
                      >
                        <Trash2 size={12} />
                        Discard
                      </button>
                    )}
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
                    {progress.total > 1
                      ? `Transcribing part ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
                      : 'Transcribing…'}
                  </span>
                  {progress.total > 1 && (
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
            {pendingRecording && !pendingRecording.complete && (
              <div className="flex flex-wrap gap-2 pl-6">
                <button
                  onClick={() => runTranscription(pendingRecording)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white/5 hover:bg-white/10 text-zinc-200 border border-white/10 transition-colors duration-200"
                  data-testid="retry-transcription-btn"
                >
                  <RotateCcw size={12} />
                  Retry transcription
                </button>
                <button
                  onClick={() => handleDownloadAudio(pendingRecording)}
                  disabled={!!joining}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white/5 hover:bg-white/10 text-zinc-200 border border-white/10 transition-colors duration-200"
                >
                  <Download size={12} />
                  {joining
                    ? `Preparing ${joining.done}/${joining.total}…`
                    : 'Save the audio'}
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
              <div className="flex items-center gap-4">
                {pendingRecording?.complete && (
                  <button
                    onClick={() => handleDownloadAudio(pendingRecording)}
                    disabled={!!joining}
                    className="flex items-center gap-1 text-xs text-zinc-400 hover:text-white transition-colors duration-200"
                    data-testid="save-audio-btn"
                  >
                    <Download size={12} />
                    {joining ? `Preparing ${joining.done}/${joining.total}…` : 'Save the audio'}
                  </button>
                )}
                <button
                  onClick={handleClear}
                  className="text-xs text-zinc-400 hover:text-red-400 transition-colors duration-200"
                  data-testid="clear-transcript-btn"
                >
                  Clear
                </button>
              </div>
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

      {!recorder.isRecording && (
        <DeviceRecordings
          recordings={stored.filter((meta) => meta.id !== pendingRecording?.id)}
          onRestoreText={restoreText}
          onContinue={continueStored}
          onSaveAudio={saveStoredAudio}
          onDelete={deleteStored}
          working={working}
          disabled={busy || isSummarizing}
        />
      )}
    </div>
  );
};

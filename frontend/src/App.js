import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BookOpen, Loader2, Volume2, WifiOff } from 'lucide-react';
import { Toaster, toast } from 'sonner';
import { Recorder, summaryLabel } from './components/Recorder';
import { NoteOutput } from './components/NoteOutput';
import { NoteHistory } from './components/NoteHistory';
import { SignIn } from './components/SignIn';
import { UserMenu } from './components/UserMenu';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useAuth } from './contexts/AuthContext';
import { SlidesProvider } from './components/Slides';
import {
  cancelNoteJob,
  errorMessage,
  getNote,
  getNoteJob,
  listNoteJobs,
  markNoteJobSeen,
  putSlidePage,
  saveNote,
  startNoteJob,
  summarizeTranscript,
  updateNote,
} from './services/api';
import { citedPages } from './lib/notes';
import { listRecordings, updateRecording } from './lib/recordingStore';
import { currentDeck, forgetCurrentDeck, loadDeckFile, rememberCurrentDeck, saveDeck } from './lib/deckStore';
import { openDeck } from './lib/slides';
import './App.css';

// A server job that is still going (backend pipeline.py). It goes on whether
// or not this tab stays open; the app only follows it.
const ACTIVE_JOB = ['receiving', 'running'];
const JOB_POLL_MS = 3000;

const Scene3D = lazy(() =>
  import('./components/Canvas3D/Scene3D').then((module) => ({ default: module.Scene3D })),
);

export const DRAFT_KEY = 'lumina.draft';

// What a note is saved with. The rest of the object on screen is for the
// screen only (why the AI fell short, say).
const SAVED_FIELDS = ['title', 'type', 'language', 'sections', 'labels', 'raw_transcript', 'tags', 'degraded', 'source', 'slides'];
const savedPart = (note) => Object.fromEntries(SAVED_FIELDS.filter((key) => note[key] !== undefined).map((key) => [key, note[key]]));
const LANGUAGE_KEY = 'lumina.language';

const readStored = (key, fallback = '') => {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch (err) {
    return fallback;
  }
};

const writeStored = (key, value) => {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch (err) {
    /* storage unavailable */
  }
};

function Workspace() {
  const { config, user } = useAuth();

  // The draft survives a reload or an accidental close — losing a transcript
  // you cannot re-record is the worst thing this app could do to someone.
  const [transcript, setTranscriptState] = useState(() => readStored(DRAFT_KEY));
  const [language, setLanguage] = useState(() => readStored(LANGUAGE_KEY, 'auto') || 'auto');
  // What the transcriber actually heard, used to keep the summary in that same
  // language without overriding the user's own "auto" choice.
  const [detectedLanguage, setDetectedLanguage] = useState('');
  // The job the server is finishing for this tab, as last heard: a recording
  // handed over at Stop, or a transcript sent with Generate notes. The note is
  // saved by the server when it is done, open tab or not.
  const [serverJob, setServerJob] = useState(null);
  const [startingJob, setStartingJob] = useState(false);
  // Notes written by the browser-held job, for a backend without server jobs.
  const [summarizingHere, setSummarizingHere] = useState(false);
  const [localProgress, setLocalProgress] = useState(null);
  const jobActive = !!serverJob && ACTIVE_JOB.includes(serverJob.status);
  const isSummarizing = startingJob || jobActive || summarizingHere;
  // How far the server has got: {stage, done, total}.
  const summaryProgress = serverJob?.progress || localProgress;
  const [isSaving, setIsSaving] = useState(false);
  const [savedCurrent, setSavedCurrent] = useState(false);
  const [currentNote, setCurrentNote] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  // A recording or its transcription is under way. Switching tabs unmounts
  // the recorder, which would end the recording and lose its audio.
  const [sessionActive, setSessionActive] = useState(false);
  const [airplaneFlying, setAirplaneFlying] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  // A link to a saved note (#note=<id>) opens on the Notes tab.
  const [activeTab, setActiveTab] = useState(() =>
    window.location.hash.startsWith('#note=') ? 'history' : 'record',
  );
  const [isOnline, setIsOnline] = useState(() => navigator.onLine !== false);
  // The lecture's slides (PDF), read in the browser. Kept on the device
  // (lib/deckStore), so they are still attached after a reload, and the pages
  // a note cites can be drawn whenever that note is ready.
  const [deck, setDeckState] = useState(null);
  const deckRef = useRef(null);
  const setDeck = useCallback(
    (next) => {
      deckRef.current = next;
      setDeckState(next);
      if (next) {
        saveDeck(next, user?.id);
        rememberCurrentDeck(next.hash, user?.id);
      } else {
        forgetCurrentDeck();
      }
    },
    [user],
  );

  // The slides attached before a reload are attached again.
  useEffect(() => {
    const hash = currentDeck(user?.id);
    if (!hash) return undefined;
    let cancelled = false;
    (async () => {
      const file = await loadDeckFile(hash);
      if (!file || cancelled || deckRef.current) return;
      try {
        const opened = await openDeck(file);
        if (cancelled || deckRef.current) {
          opened.close?.();
          return;
        }
        deckRef.current = opened;
        setDeckState(opened);
      } catch (err) {
        forgetCurrentDeck();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  /**
   * The deck a note was made with: the one attached, if it is that one, or
   * the copy kept on this device, opened for the purpose (`temporary`).
   */
  const deckFor = useCallback(async (slides) => {
    if (!slides?.hash) return null;
    if (deckRef.current?.hash === slides.hash) return { deck: deckRef.current, temporary: false };
    const file = await loadDeckFile(slides.hash);
    if (!file) return null;
    try {
      return { deck: await openDeck(file), temporary: true };
    } catch (err) {
      return null;
    }
  }, []);

  const airplaneTimerRef = useRef(null);
  const noteRef = useRef(null);
  // Live microphone amplitude, written by the recorder every frame and read by
  // the 3D scene. A ref rather than state so neither re-renders the other.
  const audioLevelRef = useRef(0);

  const languages = useMemo(() => config?.languages || [], [config]);

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  useEffect(() => () => clearTimeout(airplaneTimerRef.current), []);

  useEffect(() => writeStored(LANGUAGE_KEY, language), [language]);

  // Read by work that finishes long after the render that started it.
  const transcriptRef = useRef(transcript);
  const setTranscript = useCallback((value) => {
    transcriptRef.current = value;
    setTranscriptState(value);
    writeStored(DRAFT_KEY, value);
  }, []);

  // Warn before losing an unsaved transcript, or a recording still being
  // recorded or sent. Not while the server is finishing it: that carries on
  // without the tab, and saves the note itself.
  useEffect(() => {
    const hasUnsaved = sessionActive || (transcript.trim().length > 0 && !savedCurrent && !jobActive);
    if (!hasUnsaved) return undefined;
    const onBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [transcript, savedCurrent, sessionActive, jobActive]);

  /** Pictures of the cited slide pages, kept with the note so it can show them anywhere. */
  const keepSlides = useCallback(async (saved, source) => {
    const pages = saved.slides?.cited || [];
    if (!source || !pages.length || saved.slides?.hash !== source.hash) return;
    let failed = 0;
    for (const page of pages) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await putSlidePage(saved.id, page, await source.render(page));
      } catch (err) {
        failed += 1;
      }
    }
    if (failed) toast.warning(`${failed} slide page${failed > 1 ? 's' : ''} could not be kept with the note.`);
  }, []);

  /** Save a note the first time, then rewrite the same one. */
  const persistNote = useCallback(
    async (note, { quiet = false } = {}) => {
      setIsSaving(true);
      try {
        const saved = note.id ? await updateNote(note.id, savedPart(note)) : await saveNote(savedPart(note));
        setCurrentNote((current) => ({ ...current, ...saved, degraded_reason: current?.degraded_reason }));
        setSavedCurrent(true);
        setRefreshTrigger((value) => value + 1);
        if (!quiet) toast.success('Note saved');
        keepSlides(saved, deck);
      } catch (err) {
        toast.error(errorMessage(err, 'Could not save that note. It is still here — try Save again.'));
      } finally {
        setIsSaving(false);
      }
    },
    [deck, keepSlides],
  );

  /** Notes ready to look at: the airplane, and the note brought into view. */
  const celebrate = useCallback((degraded) => {
    if (degraded) {
      toast.warning('Your notes are saved, but the AI could not do all of them.', {
        description: 'Generate notes again later to fill in what is missing.',
      });
    } else {
      toast.success('Your notes are ready', { description: 'Saved to your notes.' });
      setAirplaneFlying(true);
      airplaneTimerRef.current = setTimeout(() => setAirplaneFlying(false), 3000);
    }
    // Bring the result into view rather than leaving it below the fold.
    setTimeout(() => noteRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
  }, []);

  const openSaved = useCallback((id) => {
    window.location.hash = `#note=${encodeURIComponent(id)}`;
    setActiveTab('history');
  }, []);

  /**
   * A server job has finished, whether or not this tab saw it start. Its note
   * is already saved; this only shows it - in place, when the transcript on
   * screen is the one it was made from, and as a link otherwise, so a draft
   * typed since is never replaced.
   */
  const settleJob = useCallback(
    async (job) => {
      try {
        if (job.status === 'done' && job.note_id) {
          const note = await getNote(job.note_id);
          const onScreen = transcriptRef.current.trim();
          if (!onScreen || (note.raw_transcript || '').startsWith(onScreen.slice(0, 2000))) {
            setCurrentNote({ ...note, degraded_reason: job.degraded_reason });
            setSavedCurrent(true);
            setTranscript(note.raw_transcript || '');
            celebrate(job.degraded);
          } else {
            toast.success(`Notes saved: ${note.title}`, {
              action: { label: 'Open', onClick: () => openSaved(note.id) },
            });
          }
          setRefreshTrigger((value) => value + 1);
          // Pictures of the cited pages, drawn from the slides kept on this
          // device - also for a note the server finished while the tab was shut.
          if (note.slides?.cited?.length) {
            const found = await deckFor(note.slides);
            if (found) {
              await keepSlides(note, found.deck);
              if (found.temporary) found.deck.close?.();
            }
          }
          // The copy kept on this device is fully transcribed now.
          const kept = (await listRecordings(user?.id)).find((meta) => meta.jobId === job.id);
          if (kept) updateRecording(kept.id, { complete: true, text: note.raw_transcript });
        } else if (job.status === 'failed') {
          toast.error(job.error || 'Your notes could not be finished.');
          if (!transcriptRef.current.trim()) {
            const full = await getNoteJob(job.id, { transcript: true });
            if (full.transcript) setTranscript(full.transcript);
          }
        }
      } catch (err) {
        toast.error(errorMessage(err, 'Your notes could not be shown here. Look for them under Notes.'));
      }
      markNoteJobSeen(job.id).catch(() => {});
    },
    [celebrate, deckFor, keepSlides, openSaved, setTranscript, user],
  );

  /** What the server finished while this tab was closed, and what it is still doing. */
  const refreshJobs = useCallback(async () => {
    let jobs;
    try {
      jobs = await listNoteJobs();
    } catch (err) {
      return; // offline, or a backend from before server jobs
    }
    // Oldest first, so the newest is the one left on screen.
    const finished = jobs.filter((job) => !ACTIVE_JOB.includes(job.status)).reverse();
    for (const job of finished) {
      // eslint-disable-next-line no-await-in-loop
      await settleJob(job);
    }
    const active = jobs.find((job) => ACTIVE_JOB.includes(job.status));
    if (active) setServerJob((current) => current || active);
  }, [settleJob]);

  const checkedJobsRef = useRef(false);
  useEffect(() => {
    if (checkedJobsRef.current) return;
    checkedJobsRef.current = true;
    refreshJobs();
  }, [refreshJobs]);

  // Follow the job until it finishes, then show it and look for the next.
  const settledRef = useRef(new Set());
  useEffect(() => {
    if (!serverJob) return undefined;
    if (!ACTIVE_JOB.includes(serverJob.status)) {
      setServerJob(null);
      if (!settledRef.current.has(serverJob.id)) {
        settledRef.current.add(serverJob.id);
        settleJob(serverJob).then(refreshJobs);
      }
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const next = await getNoteJob(serverJob.id);
        if (!cancelled) setServerJob(next);
      } catch (err) {
        if (cancelled) return;
        // Gone (it expired): stop. Anything else: ask again next round.
        if (err?.response?.status === 404) setServerJob(null);
        else setServerJob((job) => (job ? { ...job } : job));
      }
    }, JOB_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [serverJob, settleJob, refreshJobs]);

  /** The Recorder sent the rest of a recording: the server takes it from here. */
  const handleHandedOver = useCallback((job) => {
    setSavedCurrent(false);
    setServerJob(job);
    toast.success('Sent to the server', {
      description: 'Your notes are being written and will be saved by themselves. You can close this tab.',
    });
  }, []);

  const handleCancelJob = useCallback(async () => {
    if (!serverJob) return;
    try {
      setServerJob(await cancelNoteJob(serverJob.id));
      toast('Stopped. The transcript is kept.');
    } catch (err) {
      toast.error(errorMessage(err, 'Could not stop it.'));
    }
  }, [serverJob]);

  /** The old way, for a backend without server jobs: written and saved by this tab. */
  const summarizeHere = useCallback(async (text) => {
    setSummarizingHere(true);
    try {
      const summaryLanguage = language === 'auto' ? detectedLanguage || 'auto' : language;
      const slidesText = deck ? deck.pages.filter((page) => page.text) : [];
      const result = await summarizeTranscript(text, summaryLanguage, slidesText, {
        onProgress: setLocalProgress,
      });
      const note = {
        // Regenerating rewrites the note already saved, keeping its tags.
        id: currentNote?.id,
        tags: currentNote?.tags || [],
        title: result.title,
        type: result.type || '',
        language: result.language || detectedLanguage || language,
        sections: result.sections || {},
        labels: result.labels || {},
        raw_transcript: text,
        degraded: !!result.degraded,
        degraded_reason: result.degraded_reason || null,
        source: 'voice',
      };
      if (deck) {
        note.slides = { name: deck.name, pages: deck.pageCount, hash: deck.hash, cited: citedPages(note) };
      }
      setCurrentNote(note);
      // Saved straight away: notes that only existed on screen were lost to a
      // closed tab, and making them again costs a scarce AI request.
      persistNote(note, { quiet: true });

      celebrate(result.degraded);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not structure your notes.'));
    } finally {
      setSummarizingHere(false);
      setLocalProgress(null);
    }
  }, [language, detectedLanguage, deck, currentNote, persistNote, celebrate]);

  /**
   * Notes from the transcript on screen - a typed one, or a corrected one to
   * redo. Written and saved by the server, so this tab need not stay open.
   */
  const handleSummarize = useCallback(async () => {
    const text = transcript.trim();
    if (!text) {
      toast.error('There is nothing to summarize yet.');
      return;
    }
    setSavedCurrent(false);
    setStartingJob(true);
    try {
      const job = await startNoteJob({
        transcript: text,
        language,
        detected: detectedLanguage || '',
        slides: deck ? deck.pages.filter((page) => page.text) : [],
        deck: deck ? { name: deck.name, pages: deck.pageCount, hash: deck.hash } : null,
        // Regenerating rewrites the note already saved, keeping its tags.
        note_id: currentNote?.id || null,
        source: currentNote?.source || 'voice',
      });
      setServerJob(job);
    } catch (err) {
      // No such route: a backend from before server jobs.
      const missing = err?.response?.status === 405 || err?.response?.data?.detail === 'Not Found';
      if (missing) await summarizeHere(text);
      else toast.error(errorMessage(err, 'Could not start writing your notes.'));
    } finally {
      setStartingJob(false);
    }
  }, [transcript, language, detectedLanguage, deck, currentNote, summarizeHere]);

  const handleSave = useCallback((note) => persistNote(note), [persistNote]);

  // The transcript goes with the note only once the note is safely saved; a
  // note whose save failed would otherwise take its only source with it.
  const handleCloseOutput = useCallback(() => {
    setCurrentNote(null);
    setSavedCurrent(false);
    if (savedCurrent) {
      setTranscript('');
    } else if (transcript.trim()) {
      toast('The note was not saved, so its transcript is kept below.');
    }
  }, [savedCurrent, setTranscript, transcript]);

  const tabs = [
    { id: 'record', label: 'Record', icon: Volume2 },
    { id: 'history', label: 'Notes', icon: BookOpen },
  ];

  return (
    <div className="min-h-screen relative" data-testid="app-root">
      <div className="noise-overlay" />
      <div className="gradient-blob top-[-200px] left-[-200px] opacity-40" />
      <div className="gradient-blob bottom-[-200px] right-[-200px] opacity-20" />

      {/* The 3D scene is decoration: if WebGL is missing, the app carries on. */}
      <ErrorBoundary silent>
        <Suspense fallback={null}>
          <Scene3D
            isRecording={isRecording}
            isTranscribing={isTranscribing}
            isSummarizing={isSummarizing}
            airplaneFlying={airplaneFlying}
            audioLevelRef={audioLevelRef}
            active={activeTab === 'record'}
          />
        </Suspense>
      </ErrorBoundary>

      <div className="relative z-10 min-h-screen">
        <header className="px-4 sm:px-6 md:px-12 py-5 md:py-6">
          <nav className="max-w-7xl mx-auto flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-violet-600/20 border border-violet-500/30 flex items-center justify-center">
                <BookOpen size={18} className="text-violet-400" />
              </div>
              <span
                className="font-heading text-lg font-bold text-white tracking-tight hidden sm:inline"
                data-testid="app-logo"
              >
                Lumina Note
              </span>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1 bg-white/5 rounded-full p-1 border border-white/5">
                {tabs.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    onClick={() => setActiveTab(id)}
                    disabled={sessionActive && id !== activeTab}
                    title={
                      sessionActive && id !== activeTab
                        ? 'Stop the recording and let it finish transcribing first'
                        : undefined
                    }
                    className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed ${
                      activeTab === id
                        ? 'bg-violet-600/30 text-violet-300'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                    data-testid={`tab-${id}`}
                  >
                    <span className="flex items-center gap-1.5">
                      <Icon size={13} />
                      {label}
                    </span>
                  </button>
                ))}
              </div>
              <UserMenu />
            </div>
          </nav>
        </header>

        {!isOnline && (
          <div
            className="mx-4 sm:mx-6 md:mx-auto mb-4 max-w-3xl flex items-start gap-2 text-sm text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-2.5"
            role="status"
            data-testid="offline-banner"
          >
            <WifiOff size={15} />
            You are offline. Recording still works — transcription resumes when you reconnect.
          </div>
        )}

        <main className="px-4 sm:px-6 md:px-12 pb-20 safe-bottom">
          <div className="max-w-3xl mx-auto">
            <AnimatePresence mode="wait">
              {activeTab === 'record' ? (
                <motion.div
                  key="record"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ duration: 0.25 }}
                  className="space-y-8 md:space-y-12"
                >
                  <div className="pt-4 sm:pt-8 md:pt-16 text-left">
                    <motion.h1
                      initial={{ opacity: 0, y: 30 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                      className="font-heading text-4xl sm:text-5xl lg:text-6xl font-bold text-white tracking-tight leading-none"
                      data-testid="hero-title"
                    >
                      Capture ideas,
                      <br />
                      <span className="text-violet-400">effortlessly.</span>
                    </motion.h1>
                    <motion.p
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.6, delay: 0.15 }}
                      className="mt-4 text-base md:text-lg text-zinc-400 max-w-md leading-relaxed"
                    >
                      Record in any language or paste text. Lumina transcribes it, works out what
                      kind of notes it is, and structures them for you.
                    </motion.p>
                  </div>

                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.25 }}
                  >
                    <Recorder
                      transcript={transcript}
                      onTranscriptChange={setTranscript}
                      language={language}
                      onLanguageChange={setLanguage}
                      languages={languages}
                      isSummarizing={isSummarizing}
                      summaryProgress={summaryProgress}
                      onSummarize={handleSummarize}
                      onSessionChange={setSessionActive}
                      deck={deck}
                      onDeck={setDeck}
                      onRecordingChange={setIsRecording}
                      onTranscribingChange={setIsTranscribing}
                      onDetectedLanguage={setDetectedLanguage}
                      onHandedOver={handleHandedOver}
                      audioLevelRef={audioLevelRef}
                    />
                  </motion.div>

                  {jobActive && (
                    <div
                      className="glass-card p-4 flex items-start gap-3"
                      role="status"
                      data-testid="server-job-status"
                    >
                      <Loader2 size={16} className="animate-spin text-violet-400 mt-0.5 flex-shrink-0" />
                      <div className="flex-1 min-w-0 space-y-1">
                        <p className="text-sm text-zinc-200">{summaryLabel(serverJob.progress)}</p>
                        <p className="text-[11px] text-zinc-400 leading-relaxed">
                          This is happening on the server. You can close this tab: the note is saved to
                          your library when it is ready.
                        </p>
                      </div>
                      <button
                        onClick={handleCancelJob}
                        className="text-xs text-zinc-400 hover:text-white transition-colors duration-200 flex-shrink-0"
                        data-testid="cancel-server-job"
                      >
                        Stop
                      </button>
                    </div>
                  )}

                  <div ref={noteRef}>
                    <AnimatePresence>
                      {currentNote && (
                        <SlidesProvider deck={deck} note={currentNote}>
                          <NoteOutput
                            note={currentNote}
                            onSave={handleSave}
                            onClose={handleCloseOutput}
                            onOpenSaved={openSaved}
                            isSaving={isSaving}
                            saved={savedCurrent}
                          />
                        </SlidesProvider>
                      )}
                    </AnimatePresence>
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key="history"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ duration: 0.25 }}
                  className="pt-8 md:pt-12"
                >
                  <div className="mb-8">
                    <h2
                      className="font-heading text-2xl md:text-3xl font-bold text-white tracking-tight"
                      data-testid="history-title"
                    >
                      Your notes
                    </h2>
                    <p className="text-sm text-zinc-400 mt-1">
                      Private to your account. Search, filter and export anything you have saved.
                    </p>
                  </div>
                  <NoteHistory refreshTrigger={refreshTrigger} deck={deck} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </main>
      </div>
    </div>
  );
}

function BootScreen({ message, children }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 sm:px-6" data-testid="boot-screen">
      <div className="noise-overlay" />
      <div className="text-center space-y-4">
        <Loader2 size={24} className="animate-spin text-violet-400 mx-auto" />
        <p className="text-sm text-zinc-400">{message}</p>
        {children}
      </div>
    </div>
  );
}

export default function App() {
  const { status, isAuthenticated, error } = useAuth();

  if (status === 'loading') return <BootScreen message="Waking up Lumina…" />;

  if (status === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 sm:px-6">
        <div className="glass-card glass-card-highlight p-8 max-w-md text-center space-y-4">
          <h1 className="font-heading text-xl font-bold text-white">Can't reach the server</h1>
          <p className="text-sm text-zinc-400 leading-relaxed">
            {error || 'The API did not respond.'} Free hosting can take up to a minute to wake up
            after a quiet spell.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-5 py-2.5 rounded-full bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold transition-colors duration-200"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {isAuthenticated ? <Workspace /> : <SignIn />}
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: '#0f0f0f',
            border: '1px solid rgba(255,255,255,0.08)',
            color: '#fafafa',
          },
        }}
      />
    </>
  );
}

import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BookOpen, Loader2, Volume2, WifiOff } from 'lucide-react';
import { Toaster, toast } from 'sonner';
import { Recorder } from './components/Recorder';
import { NoteOutput } from './components/NoteOutput';
import { NoteHistory } from './components/NoteHistory';
import { SignIn } from './components/SignIn';
import { UserMenu } from './components/UserMenu';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useAuth } from './contexts/AuthContext';
import { errorMessage, saveNote, summarizeTranscript } from './services/api';
import './App.css';

const Scene3D = lazy(() =>
  import('./components/Canvas3D/Scene3D').then((module) => ({ default: module.Scene3D })),
);

const DRAFT_KEY = 'lumina.draft';
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
  const { config } = useAuth();

  // The draft survives a reload or an accidental close — losing a transcript
  // you cannot re-record is the worst thing this app could do to someone.
  const [transcript, setTranscriptState] = useState(() => readStored(DRAFT_KEY));
  const [language, setLanguage] = useState(() => readStored(LANGUAGE_KEY, 'auto') || 'auto');
  // What the transcriber actually heard, used to keep the summary in that same
  // language without overriding the user's own "auto" choice.
  const [detectedLanguage, setDetectedLanguage] = useState('');
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedCurrent, setSavedCurrent] = useState(false);
  const [currentNote, setCurrentNote] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [airplaneFlying, setAirplaneFlying] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [activeTab, setActiveTab] = useState('record');
  const [isOnline, setIsOnline] = useState(() => navigator.onLine !== false);

  const airplaneTimerRef = useRef(null);
  const noteRef = useRef(null);

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

  const setTranscript = useCallback((value) => {
    setTranscriptState(value);
    writeStored(DRAFT_KEY, value);
  }, []);

  // Warn before losing an unsaved transcript.
  useEffect(() => {
    const hasUnsaved = transcript.trim().length > 0 && !savedCurrent;
    if (!hasUnsaved) return undefined;
    const onBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [transcript, savedCurrent]);

  const handleSummarize = useCallback(async () => {
    const text = transcript.trim();
    if (!text) {
      toast.error('There is nothing to summarize yet.');
      return;
    }

    setIsSummarizing(true);
    setSavedCurrent(false);
    try {
      const summaryLanguage = language === 'auto' ? detectedLanguage || 'auto' : language;
      const result = await summarizeTranscript(text, summaryLanguage);
      setCurrentNote({
        title: result.title,
        type: result.type || '',
        language: result.language || detectedLanguage || language,
        sections: result.sections || {},
        labels: result.labels || {},
        raw_transcript: text,
        tags: [],
        degraded: !!result.degraded,
        degraded_reason: result.degraded_reason || null,
        source: 'voice',
      });

      if (result.degraded) {
        toast.warning('The AI was unavailable — notes were structured locally.');
      } else {
        toast.success('Your notes are ready');
        setAirplaneFlying(true);
        airplaneTimerRef.current = setTimeout(() => setAirplaneFlying(false), 3000);
      }

      // Bring the result into view rather than leaving it below the fold.
      setTimeout(() => noteRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not structure your notes.'));
    } finally {
      setIsSummarizing(false);
    }
  }, [transcript, language, detectedLanguage]);

  const handleSave = useCallback(async (note) => {
    setIsSaving(true);
    try {
      await saveNote(note);
      setSavedCurrent(true);
      setCurrentNote(note);
      setRefreshTrigger((value) => value + 1);
      toast.success('Note saved to your account');
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save that note.'));
    } finally {
      setIsSaving(false);
    }
  }, []);

  const handleCloseOutput = useCallback(() => {
    setCurrentNote(null);
    setSavedCurrent(false);
    setTranscript('');
  }, [setTranscript]);

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
            isSummarizing={isSummarizing}
            showResult={!!currentNote}
            airplaneFlying={airplaneFlying}
          />
        </Suspense>
      </ErrorBoundary>

      <div className="relative z-10 min-h-screen">
        <header className="px-6 md:px-12 py-6">
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
                    className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors duration-200 ${
                      activeTab === id
                        ? 'bg-violet-600/30 text-violet-300'
                        : 'text-zinc-500 hover:text-zinc-300'
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
            className="mx-6 md:mx-12 mb-4 max-w-3xl md:mx-auto flex items-center gap-2 text-sm text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-2.5"
            role="status"
            data-testid="offline-banner"
          >
            <WifiOff size={15} />
            You are offline. Recording still works — transcription resumes when you reconnect.
          </div>
        )}

        <main className="px-6 md:px-12 pb-20">
          <div className="max-w-3xl mx-auto">
            <AnimatePresence mode="wait">
              {activeTab === 'record' ? (
                <motion.div
                  key="record"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ duration: 0.25 }}
                  className="space-y-12"
                >
                  <div className="pt-8 md:pt-16 text-left">
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
                      onSummarize={handleSummarize}
                      onRecordingChange={setIsRecording}
                      onDetectedLanguage={setDetectedLanguage}
                    />
                  </motion.div>

                  <div ref={noteRef}>
                    <AnimatePresence>
                      {currentNote && (
                        <NoteOutput
                          note={currentNote}
                          onSave={handleSave}
                          onClose={handleCloseOutput}
                          isSaving={isSaving}
                          saved={savedCurrent}
                        />
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
                    <p className="text-sm text-zinc-500 mt-1">
                      Private to your account. Search, filter and export anything you have saved.
                    </p>
                  </div>
                  <NoteHistory refreshTrigger={refreshTrigger} />
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
    <div className="min-h-screen flex items-center justify-center px-6" data-testid="boot-screen">
      <div className="noise-overlay" />
      <div className="text-center space-y-4">
        <Loader2 size={24} className="animate-spin text-violet-400 mx-auto" />
        <p className="text-sm text-zinc-500">{message}</p>
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
      <div className="min-h-screen flex items-center justify-center px-6">
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

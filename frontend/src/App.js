import React, { useState, useCallback, lazy, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { BookOpen, Sparkles, Volume2 } from 'lucide-react';
import { Toaster, toast } from 'sonner';
import { useSpeechRecognition } from './hooks/useSpeechRecognition';
import { Recorder } from './components/Recorder';
import { NoteOutput } from './components/NoteOutput';
import { NoteHistory } from './components/NoteHistory';
import { summarizeTranscript, saveNote } from './services/api';
import './App.css';

const Scene3D = lazy(() =>
  import('./components/Canvas3D/Scene3D').then((m) => ({ default: m.Scene3D }))
);

function App() {
  const {
    transcript,
    interimText,
    isListening,
    isSupported,
    startListening,
    stopListening,
    resetTranscript,
    setTranscript,
  } = useSpeechRecognition();

  const [isSummarizing, setIsSummarizing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [currentNote, setCurrentNote] = useState(null);
  const [showResult, setShowResult] = useState(false);
  const [airplaneFlying, setAirplaneFlying] = useState(false); // For triggering airplane animation in Scene3D
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [activeTab, setActiveTab] = useState('record'); // 'record' | 'history'

  const handleSummarize = useCallback(async () => {
    const text = (transcript + ' ' + interimText).trim();
    if (!text) {
      toast.error('No transcript to summarize');
      return;
    }

    setIsSummarizing(true);
    setShowResult(false);

    try {
      const result = await summarizeTranscript(text);
      setCurrentNote({
        title: result.title,
        type: result.type || '',
        raw_transcript: text,
        sections: result.sections || {},
        // keep old fields as fallback for saved notes compatibility
        summary: result.summary || [],
        key_decisions: result.key_decisions || [],
        action_items: result.action_items || [],
        tags: [],
      });
      setShowResult(true);
      toast.success('Notes structured successfully!');
      setAirplaneFlying(true);
      setTimeout(() => setAirplaneFlying(false), 3000);
    } catch (err) {
      console.error('Summarize error:', err);
      toast.error(err.response?.data?.detail || 'Failed to summarize transcript');
    } finally {
      setIsSummarizing(false);
    }
  }, [transcript, interimText]);

  const handleSave = useCallback(async (noteData) => {
    setIsSaving(true);
    try {
      await saveNote(noteData);
      toast.success('Note saved!');
      setRefreshTrigger((prev) => prev + 1);
    } catch (err) {
      console.error('Save error:', err);
      toast.error('Failed to save note');
    } finally {
      setIsSaving(false);
    }
  }, []);

  const handleCloseOutput = useCallback(() => {
    setCurrentNote(null);
    setShowResult(false);
    resetTranscript();
  }, [resetTranscript]);

  return (
    <div className="min-h-screen relative" data-testid="app-root">
      {/* Noise overlay */}
      <div className="noise-overlay" />

      {/* Background blobs */}
      <div className="gradient-blob top-[-200px] left-[-200px] opacity-40" />
      <div className="gradient-blob bottom-[-200px] right-[-200px] opacity-20" />

      {/* 3D Background */}
      <Suspense fallback={null}>
        <Scene3D isRecording={isListening} isSummarizing={isSummarizing} showResult={showResult} airplaneFlying={airplaneFlying} />
      </Suspense>

      {/* Main Content */}
      <div className="relative z-10 min-h-screen">
        {/* Header */}
        <header className="px-6 md:px-12 py-6">
          <nav className="max-w-7xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-violet-600/20 border border-violet-500/30 flex items-center justify-center">
                <BookOpen size={18} className="text-violet-400" />
              </div>
              <span className="font-heading text-lg font-bold text-white tracking-tight" data-testid="app-logo">
                Lumina Note
              </span>
            </div>
            <div className="flex items-center gap-1 bg-white/5 rounded-full p-1 border border-white/5">
              <button
                onClick={() => setActiveTab('record')}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors duration-200 ${
                  activeTab === 'record' ? 'bg-violet-600/30 text-violet-300' : 'text-zinc-500 hover:text-zinc-300'
                }`}
                data-testid="tab-record"
              >
                <span className="flex items-center gap-1.5">
                  <Volume2 size={13} />
                  Record
                </span>
              </button>
              <button
                onClick={() => setActiveTab('history')}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors duration-200 ${
                  activeTab === 'history' ? 'bg-violet-600/30 text-violet-300' : 'text-zinc-500 hover:text-zinc-300'
                }`}
                data-testid="tab-history"
              >
                <span className="flex items-center gap-1.5">
                  <BookOpen size={13} />
                  Notes
                </span>
              </button>
            </div>
          </nav>
        </header>

        {/* Content */}
        <main className="px-6 md:px-12 pb-20">
          <div className="max-w-3xl mx-auto">
            <AnimatePresence mode="wait">
              {activeTab === 'record' ? (
                <motion.div
                  key="record"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ duration: 0.3 }}
                  className="space-y-12"
                >
                  {/* Hero */}
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
                      Record your voice or paste text. Our AI structures your notes with precision.
                    </motion.p>
                  </div>

                  {/* Recorder */}
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.3 }}
                  >
                    <Recorder
                      transcript={transcript}
                      interimText={interimText}
                      isListening={isListening}
                      isSupported={isSupported}
                      isSummarizing={isSummarizing}
                      onStartListening={startListening}
                      onStopListening={stopListening}
                      onSummarize={handleSummarize}
                      onTranscriptChange={setTranscript}
                    />
                  </motion.div>

                  {/* Result */}
                  <AnimatePresence>
                    {currentNote && showResult && (
                      <NoteOutput
                        note={currentNote}
                        onSave={handleSave}
                        onClose={handleCloseOutput}
                        isSaving={isSaving}
                      />
                    )}
                  </AnimatePresence>
                </motion.div>
              ) : (
                <motion.div
                  key="history"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ duration: 0.3 }}
                  className="pt-8 md:pt-12"
                >
                  <div className="mb-8">
                    <h2 className="font-heading text-2xl md:text-3xl font-bold text-white tracking-tight" data-testid="history-title">
                      Your Notes
                    </h2>
                    <p className="text-sm text-zinc-500 mt-1">Browse, search, and manage your saved notes.</p>
                  </div>
                  <NoteHistory refreshTrigger={refreshTrigger} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </main>
      </div>

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
    </div>
  );
}

export default App;

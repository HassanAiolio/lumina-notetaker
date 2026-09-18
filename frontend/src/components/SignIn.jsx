import React, { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { AlertCircle, BookOpen, Globe, Loader2, Mic, Sparkles } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

const FEATURES = [
  { icon: Mic, title: 'Record anywhere', body: 'Capture a meeting, a lecture or a thought in one tap.' },
  { icon: Globe, title: 'Speaks your language', body: 'French, English, Spanish and more — detected automatically.' },
  { icon: Sparkles, title: 'Structured for you', body: 'The AI picks the right sections for what you recorded.' },
];

export const SignIn = () => {
  const { renderSignInButton, error, signingIn } = useAuth();
  const buttonRef = useRef(null);

  // Re-render the button whenever it remounts - notably after a failed attempt,
  // when the spinner that replaced it goes away again.
  useEffect(() => {
    if (!signingIn) renderSignInButton(buttonRef.current);
  }, [renderSignInButton, signingIn]);

  return (
    <div className="min-h-screen relative flex items-center justify-center px-6 py-16" data-testid="sign-in">
      <div className="noise-overlay" />
      <div className="gradient-blob top-[-220px] left-[-180px] opacity-50" />
      <div className="gradient-blob bottom-[-240px] right-[-200px] opacity-25" />

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 w-full max-w-md"
      >
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-violet-600/20 border border-violet-500/30 flex items-center justify-center">
            <BookOpen size={20} className="text-violet-400" />
          </div>
          <span className="font-heading text-xl font-bold text-white tracking-tight">Lumina Note</span>
        </div>

        <h1 className="font-heading text-4xl sm:text-5xl font-bold text-white tracking-tight leading-[1.05]">
          Capture ideas,
          <br />
          <span className="text-violet-400">effortlessly.</span>
        </h1>
        <p className="mt-4 text-zinc-400 leading-relaxed">
          Sign in to record, transcribe and structure your notes. Everything you save stays in your
          own private space.
        </p>

        <div className="mt-10 glass-card glass-card-highlight p-6 space-y-6">
          <div className="space-y-4">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <div key={title} className="flex items-start gap-3">
                <div className="mt-0.5 w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center flex-shrink-0">
                  <Icon size={14} className="text-violet-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-zinc-200">{title}</p>
                  <p className="text-xs text-zinc-400 leading-relaxed">{body}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="border-t border-white/5 pt-6 space-y-3">
            <div className="flex justify-center min-h-[44px] items-center">
              {signingIn ? (
                <span className="flex items-center gap-2 text-sm text-zinc-400" data-testid="signing-in">
                  <Loader2 size={16} className="animate-spin" />
                  Signing you in…
                </span>
              ) : (
                <div ref={buttonRef} data-testid="google-signin-button" />
              )}
            </div>

            {error && (
              <div
                className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2"
                role="alert"
                data-testid="signin-error"
              >
                <AlertCircle size={14} className="flex-shrink-0 mt-px" />
                <span>{error}</span>
              </div>
            )}

            <p className="text-[11px] text-zinc-400 text-center leading-relaxed">
              We only read your name, email and profile picture from Google — just enough to keep
              your notes yours.
            </p>
            <p className="text-[11px] text-zinc-500 text-center leading-relaxed">
              Nothing happening when you click? Your browser may be blocking the Google
              sign-in window — check for a blocked-popup icon in the address bar.
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
};

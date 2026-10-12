import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { LogOut, User as UserIcon } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { listRecordings } from '../lib/recordingStore';

/** What signing out would delete from this device: the draft, and kept recordings. */
const localWork = async (owner) => {
  let draft = '';
  try {
    draft = window.localStorage.getItem('lumina.draft') || '';
  } catch (err) {
    /* storage unavailable */
  }
  const recordings = (await listRecordings(owner)).length;
  return draft.trim() || recordings ? { draft: !!draft.trim(), recordings } : null;
};

const describe = ({ draft, recordings }) =>
  [
    draft && 'your unsaved transcript',
    recordings && `${recordings} recording${recordings > 1 ? 's' : ''} kept on this device`,
  ]
    .filter(Boolean)
    .join(' and ');

export const UserMenu = () => {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  // Set when signing out would delete something, until confirmed or cancelled.
  const [atRisk, setAtRisk] = useState(null);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) setAtRisk(null);
  }, [open]);

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

  if (!user) return null;

  const initial = (user.name || user.email || '?').trim().charAt(0).toUpperCase();

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen((value) => !value)}
        className="tap w-9 h-9 rounded-full overflow-hidden border border-white/10 hover:border-violet-500/40 transition-colors duration-200 flex items-center justify-center bg-white/5"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        data-testid="user-menu-trigger"
      >
        {user.picture && !imageFailed ? (
          <img
            src={user.picture}
            alt=""
            className="w-full h-full object-cover"
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <span className="text-xs font-semibold text-violet-300">{initial}</span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 mt-2 w-[min(14rem,calc(100vw-3rem))] glass-card p-1.5 z-50"
            role="menu"
            data-testid="user-menu"
          >
            <div className="px-3 py-2.5 border-b border-white/5">
              <p className="text-sm font-medium text-zinc-200 truncate">{user.name || 'Signed in'}</p>
              <p className="text-xs text-zinc-400 truncate">{user.email}</p>
            </div>
            {atRisk ? (
              <div className="px-3 py-2.5 space-y-2" data-testid="sign-out-confirm">
                <p className="text-xs text-zinc-300 leading-relaxed">
                  Signing out deletes {describe(atRisk)} from this device.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setOpen(false);
                      signOut();
                    }}
                    className="px-2.5 py-1 rounded-full text-xs font-medium bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/30 transition-colors duration-150"
                    data-testid="confirm-sign-out-btn"
                  >
                    Sign out anyway
                  </button>
                  <button
                    onClick={() => setAtRisk(null)}
                    className="px-2.5 py-1 rounded-full text-xs font-medium bg-white/5 hover:bg-white/10 text-zinc-300 border border-white/10 transition-colors duration-150"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={async () => {
                  const work = await localWork(user.id);
                  if (work) {
                    setAtRisk(work);
                    return;
                  }
                  setOpen(false);
                  signOut();
                }}
                className="w-full flex items-center gap-2 px-3 py-2 mt-1 rounded-lg text-sm text-zinc-300 hover:bg-white/5 hover:text-white transition-colors duration-150"
                role="menuitem"
                data-testid="sign-out-btn"
              >
                <LogOut size={14} />
                Sign out
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export const UserAvatarFallback = () => (
  <div className="w-9 h-9 rounded-full bg-white/5 border border-white/10 flex items-center justify-center">
    <UserIcon size={14} className="text-zinc-400" />
  </div>
);

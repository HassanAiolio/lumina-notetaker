import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { LogOut, User as UserIcon } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

export const UserMenu = () => {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const containerRef = useRef(null);

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
        className="w-9 h-9 rounded-full overflow-hidden border border-white/10 hover:border-violet-500/40 transition-colors duration-200 flex items-center justify-center bg-white/5"
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
            className="absolute right-0 mt-2 w-56 glass-card p-1.5 z-50"
            role="menu"
            data-testid="user-menu"
          >
            <div className="px-3 py-2.5 border-b border-white/5">
              <p className="text-sm font-medium text-zinc-200 truncate">{user.name || 'Signed in'}</p>
              <p className="text-xs text-zinc-400 truncate">{user.email}</p>
            </div>
            <button
              onClick={() => {
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

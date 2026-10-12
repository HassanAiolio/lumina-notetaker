import React, { useState } from 'react';
import { ChevronDown, Download, FileText, HardDrive, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import { formatDuration } from '../lib/audio';
import { KEEP_DAYS, KEEP_RECORDINGS } from '../lib/recordingStore';

const when = (time) =>
  new Date(time).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const status = (meta) => {
  if (meta.discarded) return 'Discarded';
  if (meta.complete) return 'Transcribed';
  if (meta.text) return 'Partly transcribed';
  return 'Not transcribed';
};

const action =
  'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-white/5 hover:bg-white/10 text-zinc-300 border border-white/10 transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed';

/**
 * The recordings kept on this device, each with a way back: its transcript,
 * the rest of its transcription, or its audio. Collapsed by default - it is a
 * safety net, not something to look at every time.
 */
export const DeviceRecordings = ({ recordings, onRestoreText, onContinue, onSaveAudio, onDelete, working, disabled }) => {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(null);

  if (!recordings.length) return null;

  return (
    <div className="glass-card p-4 space-y-3" data-testid="device-recordings">
      <button
        onClick={() => setOpen((value) => !value)}
        className="w-full flex items-center gap-2 text-left text-xs text-zinc-400 hover:text-white transition-colors duration-200"
        aria-expanded={open}
      >
        <HardDrive size={13} />
        <span className="uppercase tracking-widest font-medium">Kept on this device ({recordings.length})</span>
        <ChevronDown size={14} className={`ml-auto transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          <p className="text-[11px] text-zinc-400 leading-relaxed">
            Your last {KEEP_RECORDINGS} recordings and their transcripts, saved in this browser only and
            never uploaded. Each is kept for {KEEP_DAYS} days, or until signing out.
          </p>
          <ul className="space-y-2">
            {recordings.map((meta) => {
              const busy = working === meta.id;
              return (
                <li key={meta.id} className="rounded-lg bg-black/30 border border-white/5 px-3 py-2.5 space-y-2">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
                    <span className="text-zinc-200">{when(meta.startedAt)}</span>
                    <span className="font-mono tabular-nums text-zinc-400">{formatDuration(meta.seconds || 0)}</span>
                    <span className="text-zinc-400">{status(meta)}</span>
                  </div>
                  {meta.text && (
                    <p className="text-[11px] text-zinc-400 line-clamp-2">{meta.text}</p>
                  )}
                  {confirming === meta.id ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] text-red-300">Delete this recording for good?</span>
                      <button
                        onClick={() => {
                          setConfirming(null);
                          onDelete(meta);
                        }}
                        className={`${action} hover:bg-red-500/10 text-red-300`}
                      >
                        Delete
                      </button>
                      <button onClick={() => setConfirming(null)} className={action}>
                        Keep
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {meta.text && (
                        <button onClick={() => onRestoreText(meta)} disabled={disabled} className={action}>
                          <FileText size={11} />
                          Restore transcript
                        </button>
                      )}
                      {!meta.complete && (
                        <button
                          onClick={() => onContinue(meta)}
                          disabled={disabled || busy}
                          className={action}
                          data-testid="continue-recording-btn"
                        >
                          <RotateCcw size={11} />
                          {meta.text ? 'Transcribe the rest' : 'Transcribe'}
                        </button>
                      )}
                      <button onClick={() => onSaveAudio(meta)} disabled={busy} className={action}>
                        {busy ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                        Save the audio
                      </button>
                      <button
                        onClick={() => setConfirming(meta.id)}
                        disabled={busy}
                        className={`${action} hover:text-red-400`}
                        aria-label="Delete recording"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
};

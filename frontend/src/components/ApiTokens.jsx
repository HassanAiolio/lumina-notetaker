import React, { useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import {
  API_ROOT, createApiToken, errorMessage, listApiTokens, revokeApiToken,
} from '../services/api';

// What the MCP server's LUMINA_API_URL should be: the backend, without /api.
const BACKEND_URL = API_ROOT.replace(/\/api$/, '');

const when = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

const CopyField = ({ label, value, testId }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      toast.error('Could not copy. Select the text and copy it instead.');
    }
  };
  return (
    <div className="space-y-1">
      <p className="text-[11px] uppercase tracking-widest text-zinc-400">{label}</p>
      <div className="flex items-center gap-2">
        <code
          className="flex-1 min-w-0 truncate text-xs text-zinc-200 bg-black/50 border border-white/10 rounded-lg px-3 py-2 select-all"
          data-testid={testId}
        >
          {value}
        </code>
        <button
          onClick={copy}
          className="tap flex-shrink-0 p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
};

/**
 * Personal tokens for the MCP server, so Claude can read the notes. They only
 * read; the token is shown once, when it is made.
 */
export const ApiTokens = ({ open, onOpenChange }) => {
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('Claude');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);
  const [confirming, setConfirming] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTokens(await listApiTokens());
    } catch (err) {
      toast.error(errorMessage(err, 'Could not load your tokens.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      load();
    } else {
      // The token is not kept anywhere once this closes.
      setCreated(null);
      setConfirming(null);
    }
  }, [open, load]);

  const create = async (event) => {
    event.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      const token = await createApiToken(name.trim());
      setCreated(token);
      setTokens((current) => [token, ...current]);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not create a token.'));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id) => {
    if (confirming !== id) {
      setConfirming(id);
      return;
    }
    try {
      await revokeApiToken(id);
      setTokens((current) => current.filter((token) => token.id !== id));
      if (created?.id === id) setCreated(null);
      toast.success('Token revoked');
    } catch (err) {
      toast.error(errorMessage(err, 'Could not revoke that token.'));
    } finally {
      setConfirming(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md bg-[#0f0f0f] border-white/10 text-zinc-200 rounded-2xl max-h-[90vh] overflow-y-auto"
        data-testid="api-tokens-dialog"
      >
        <DialogHeader>
          <DialogTitle className="font-heading text-white flex items-center gap-2">
            <KeyRound size={16} className="text-violet-400" />
            API tokens
          </DialogTitle>
          <DialogDescription className="text-zinc-400 leading-relaxed">
            Let Claude search and read your notes through the Lumina MCP server. Tokens can only
            read: nothing made with one can change or delete a note.
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-3 rounded-xl border border-violet-500/30 bg-violet-500/5 p-4" data-testid="new-token">
            <p className="text-xs text-violet-200 leading-relaxed">
              Copy this token now. It is not shown again; if you lose it, revoke it and make another.
            </p>
            <CopyField label="LUMINA_TOKEN" value={created.token} testId="new-token-value" />
            <CopyField label="LUMINA_API_URL" value={BACKEND_URL} testId="api-url-value" />
            <p className="text-[11px] text-zinc-400 leading-relaxed">
              Set both where you add the server to Claude. The README&apos;s &ldquo;Connect Claude&rdquo;
              section has the exact steps.
            </p>
          </div>
        ) : (
          <form onSubmit={create} className="flex items-center gap-2">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={60}
              placeholder="What it is for, e.g. Claude Desktop"
              className="flex-1 min-w-0 h-9 bg-black/50 border border-white/10 rounded-lg px-3 text-sm text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-violet-500/50"
              aria-label="Token name"
              data-testid="token-name-input"
            />
            <button
              type="submit"
              disabled={!name.trim() || creating}
              className="flex items-center gap-1.5 h-9 px-4 rounded-full text-sm font-medium bg-violet-600 hover:bg-violet-500 text-white transition-colors disabled:opacity-50"
              data-testid="create-token-btn"
            >
              {creating && <Loader2 size={14} className="animate-spin" />}
              Create
            </button>
          </form>
        )}

        <div className="space-y-2">
          <p className="text-[11px] uppercase tracking-widest text-zinc-400">Your tokens</p>
          {loading ? (
            <Loader2 size={16} className="animate-spin text-violet-400" />
          ) : tokens.length === 0 ? (
            <p className="text-xs text-zinc-500">None yet.</p>
          ) : (
            <ul className="space-y-1.5" data-testid="token-list">
              {tokens.map((token) => (
                <li
                  key={token.id}
                  className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-zinc-200 truncate">{token.name}</p>
                    <p className="text-[11px] text-zinc-500 truncate">
                      <code>{token.prefix}…</code> · made {when(token.created_at)} ·{' '}
                      {token.last_used_at ? `last used ${when(token.last_used_at)}` : 'never used'}
                    </p>
                  </div>
                  <button
                    onClick={() => revoke(token.id)}
                    className={`tap flex items-center gap-1 px-2.5 py-1 rounded-full text-xs transition-colors ${
                      confirming === token.id
                        ? 'bg-red-500/15 text-red-300 border border-red-500/30'
                        : 'text-zinc-400 hover:text-red-400'
                    }`}
                    data-testid={`revoke-token-${token.id}`}
                  >
                    <Trash2 size={12} />
                    {confirming === token.id ? 'Revoke?' : 'Revoke'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

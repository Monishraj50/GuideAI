'use client';

import { useState } from 'react';
import { LogOut, Lock, Ghost, User, ArrowRight, Save } from 'lucide-react';
import { useAuth } from '../../components/AuthProvider';
import { toast } from '../../components/Toast';
import { cn } from '../../lib/cn';

export function AuthSection() {
  const { state, signOut, changePassword, upgradeGuest } = useAuth();
  const [cur, setCur] = useState('');
  const [nxt, setNxt] = useState('');
  const [upUsername, setUpUsername] = useState('');
  const [upPassword, setUpPassword] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const user = state?.user;

  async function onSignOut() {
    if (!confirm('Sign out? You will need to sign in again to use the app.')) return;
    setBusy('signout');
    try { await signOut(); toast({ title: 'Signed out', variant: 'warn' }); window.location.href = '/signin'; }
    finally { setBusy(null); }
  }

  async function onChangePw() {
    if (!cur || !nxt) return;
    setBusy('pw');
    try {
      const r = await changePassword(cur, nxt);
      if (r.ok) { toast({ title: 'Password updated', variant: 'success' }); setCur(''); setNxt(''); }
      else toast({ title: 'Change failed', description: r.error, variant: 'error' });
    } finally { setBusy(null); }
  }

  async function onUpgrade() {
    if (!upUsername || !upPassword) return;
    setBusy('upgrade');
    try {
      const r = await upgradeGuest(upUsername, upPassword);
      if (r.ok) toast({ title: `Upgraded to ${upUsername}`, variant: 'success' });
      else toast({ title: 'Upgrade failed', description: r.error, variant: 'error' });
    } finally { setBusy(null); }
  }

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <User size={14} className="text-accent" />
        <span className="text-ink font-medium text-sm">Account</span>
        {user?.isGuest ? (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full border border-sonnet/40 text-sonnet bg-sonnet/10 flex items-center gap-1">
            <Ghost size={10} /> guest
          </span>
        ) : (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full border border-accent/40 text-accent bg-accent/10">
            signed in
          </span>
        )}
      </div>

      <div className="border border-line/70 rounded-lg bg-surface2/50 overflow-hidden">
        {/* Identity row */}
        <div className="p-4 border-b border-line/40 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-accent/60 to-sonnet/60 flex items-center justify-center text-bg text-sm font-semibold">
            {(user?.displayName ?? user?.username ?? '?').slice(0, 1).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-ink text-sm">{user?.displayName ?? user?.username ?? '—'}</div>
            <div className="text-dim2 text-[11px] font-mono">{user?.username ?? '—'}</div>
          </div>
          <button
            onClick={onSignOut}
            disabled={busy === 'signout'}
            className="flex items-center gap-1 px-3 py-1.5 rounded-md border border-err/40 text-err text-xs disabled:opacity-40 hover:bg-err/10"
          >
            <LogOut size={11} /> sign out
          </button>
        </div>

        {/* Change password — only for real accounts */}
        {!user?.isGuest && (
          <div className="p-4 border-b border-line/40">
            <div className="text-dim2 text-[10px] uppercase tracking-wider mb-2 flex items-center gap-1"><Lock size={10} /> Change password</div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 items-end">
              <input
                type="password"
                value={cur}
                onChange={(e) => setCur(e.target.value)}
                placeholder="current"
                className="bg-bg/60 border border-line/70 rounded-md px-2 py-1.5 text-xs text-ink outline-none focus:border-accent/60"
              />
              <input
                type="password"
                value={nxt}
                onChange={(e) => setNxt(e.target.value)}
                placeholder="new (≥6 chars)"
                className="bg-bg/60 border border-line/70 rounded-md px-2 py-1.5 text-xs text-ink outline-none focus:border-accent/60"
              />
              <button
                onClick={onChangePw}
                disabled={busy === 'pw' || !cur || !nxt}
                className="flex items-center justify-center gap-1 px-3 py-1.5 rounded-md bg-accent text-bg text-xs font-medium disabled:opacity-40 hover:brightness-110"
              >
                <Save size={11} /> update
              </button>
            </div>
          </div>
        )}

        {/* Guest upgrade */}
        {user?.isGuest && (
          <div className="p-4 border-b border-line/40">
            <div className="text-dim2 text-[10px] uppercase tracking-wider mb-2 flex items-center gap-1"><ArrowRight size={10} /> Upgrade to a real account</div>
            <div className="text-dim text-[11px] mb-2">Keep your current session — just register a username and password.</div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 items-end">
              <input
                value={upUsername}
                onChange={(e) => setUpUsername(e.target.value.toLowerCase())}
                placeholder="username"
                className="bg-bg/60 border border-line/70 rounded-md px-2 py-1.5 text-xs text-ink font-mono outline-none focus:border-accent/60"
              />
              <input
                type="password"
                value={upPassword}
                onChange={(e) => setUpPassword(e.target.value)}
                placeholder="password (≥6 chars)"
                className="bg-bg/60 border border-line/70 rounded-md px-2 py-1.5 text-xs text-ink outline-none focus:border-accent/60"
              />
              <button
                onClick={onUpgrade}
                disabled={busy === 'upgrade' || !upUsername || !upPassword}
                className="flex items-center justify-center gap-1 px-3 py-1.5 rounded-md bg-accent text-bg text-xs font-medium disabled:opacity-40 hover:brightness-110"
              >
                <ArrowRight size={11} /> upgrade
              </button>
            </div>
          </div>
        )}

        <div className="p-4 text-dim2 text-[11px]">
          {user?.isGuest
            ? 'Guest mode runs the local mock adapter — no Claude calls. Convert above to keep your work.'
            : 'Briefs run against the host Claude CLI session. Sign in is local-only; your password is hashed with scrypt and stored in SQLite.'}
        </div>
      </div>
    </section>
  );
}

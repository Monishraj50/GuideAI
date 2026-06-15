'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Sparkles, User, Lock, Ghost, CheckCircle2, AlertTriangle, Loader2,
  ArrowRight, LogIn, UserPlus,
} from 'lucide-react';
import { useAuth } from '../../components/AuthProvider';
import { cn } from '../../lib/cn';

type Mode = 'signin' | 'signup' | 'guest';

const TABS: { id: Mode; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: 'signin', label: 'Sign in',  icon: LogIn },
  { id: 'signup', label: 'Sign up',  icon: UserPlus },
  { id: 'guest',  label: 'Guest',    icon: Ghost },
];

export function SignInClient() {
  const { signIn, signUp, signInAsGuest } = useAuth();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('signin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      let res: { ok: true } | { ok: false; error: string };
      if (mode === 'signup') {
        if (password !== confirm) { setError('Passwords do not match.'); setBusy(false); return; }
        res = await signUp(username, password, displayName || undefined);
      } else if (mode === 'signin') {
        res = await signIn(username, password);
      } else {
        res = await signInAsGuest(displayName || undefined);
      }
      if (res.ok) router.replace('/');
      else setError(res.error);
    } finally { setBusy(false); }
  }

  const canSubmit = (() => {
    if (mode === 'guest') return true;
    if (mode === 'signin') return !!username && !!password;
    return !!username && !!password && !!confirm;
  })();

  return (
    <div className="min-h-screen w-full flex">
      {/* Left — branding */}
      <aside className="hidden md:flex w-2/5 flex-col justify-between p-10 border-r border-line/70 glass relative overflow-hidden">
        <div className="absolute -top-20 -left-20 w-80 h-80 rounded-full bg-accent/15 blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 right-0 w-72 h-72 rounded-full bg-sonnet/15 blur-3xl pointer-events-none" />
        <div className="relative">
          <div className="flex items-center gap-2 mb-6">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-accent to-sonnet flex items-center justify-center shadow-glow">
              <Sparkles size={16} strokeWidth={2.4} className="text-bg" />
            </div>
            <span className="text-ink text-lg font-semibold tracking-tight">GuideAI</span>
          </div>
          <h2 className="text-2xl font-semibold tracking-tight text-ink leading-snug max-w-xs">
            Your company,<br />run by agents.
          </h2>
          <p className="text-dim text-sm mt-3 max-w-sm">
            You&apos;re in charge. Brief them. Review their work. Ship faster than ever.
          </p>
        </div>
        <ul className="relative space-y-2 text-xs text-dim">
          <li className="flex gap-2"><CheckCircle2 size={12} className="text-accent mt-0.5" /> Sequential phase pipeline · pass@k evals</li>
          <li className="flex gap-2"><CheckCircle2 size={12} className="text-accent mt-0.5" /> 154-agent marketplace · custom designations</li>
          <li className="flex gap-2"><CheckCircle2 size={12} className="text-accent mt-0.5" /> Local-first · accounts stored on disk</li>
          <li className="flex gap-2"><CheckCircle2 size={12} className="text-accent mt-0.5" /> Killswitch + audit log for every action</li>
        </ul>
      </aside>

      {/* Right — auth form */}
      <main className="flex-1 flex items-center justify-center p-6 overflow-y-auto">
        <div className="w-full max-w-md my-8">
          <div className="mb-6">
            <div className="text-dim2 text-[10px] uppercase tracking-[0.2em] mb-2">welcome</div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink">
              {mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Continue as guest'}
            </h1>
            <p className="text-dim text-sm mt-1">
              {mode === 'guest'
                ? 'Browse the app with mock agents — no account needed.'
                : 'Local accounts stored on this machine.'}
            </p>
          </div>

          {/* Tabs */}
          <div className="flex p-1 rounded-md bg-bg/60 border border-line/70 mb-5">
            {TABS.map((t) => {
              const active = mode === t.id;
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  onClick={() => { setMode(t.id); setError(null); }}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-all',
                    active ? 'bg-line2/80 text-ink shadow-soft' : 'text-dim hover:text-ink',
                  )}
                >
                  <Icon size={12} /> {t.label}
                </button>
              );
            })}
          </div>

          <div className="space-y-3">
            {(mode === 'signin' || mode === 'signup') && (
              <Field label={<span className="flex items-center gap-1.5"><User size={11} /> Username</span>}>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. monish"
                  autoComplete="username"
                  autoFocus
                  className="w-full bg-bg/60 border border-line/70 rounded-md px-3 py-2 text-sm text-ink font-mono outline-none focus:border-accent/60"
                />
              </Field>
            )}

            {(mode === 'signin' || mode === 'signup') && (
              <Field
                label={<span className="flex items-center gap-1.5"><Lock size={11} /> Password</span>}
                hint={mode === 'signup' ? 'At least 6 characters. Stored as a scrypt hash locally.' : undefined}
              >
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && mode === 'signin') submit(); }}
                  placeholder="••••••••"
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  className="w-full bg-bg/60 border border-line/70 rounded-md px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
                />
              </Field>
            )}

            {mode === 'signup' && (
              <Field label={<span className="flex items-center gap-1.5"><Lock size={11} /> Confirm password</span>}>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                  placeholder="••••••••"
                  autoComplete="new-password"
                  className="w-full bg-bg/60 border border-line/70 rounded-md px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
                />
              </Field>
            )}

            {(mode === 'signup' || mode === 'guest') && (
              <Field label="Display name" hint="Shown in the feed when you submit briefs.">
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && mode === 'guest') submit(); }}
                  placeholder={mode === 'guest' ? 'e.g. Guest' : 'e.g. Monish Raj'}
                  autoFocus={mode === 'guest'}
                  className="w-full bg-bg/60 border border-line/70 rounded-md px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
                />
              </Field>
            )}

            {mode === 'guest' && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-sonnet/40 bg-sonnet/[0.06] text-xs">
                <Ghost size={12} className="text-sonnet mt-0.5" />
                <div className="flex-1 text-dim">
                  Guest mode runs a local mock adapter. Briefs still execute the full pipeline, but every AI response is deterministic and free. You can convert to a real account later from Settings.
                </div>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-err/40 bg-err/[0.06] text-err text-xs">
                <AlertTriangle size={12} className="mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              onClick={submit}
              disabled={busy || !canSubmit}
              className={cn(
                'w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-md font-medium text-sm transition-all',
                'bg-gradient-to-br from-accent to-accent2 text-bg shadow-glow',
                'disabled:opacity-40 disabled:shadow-none disabled:cursor-not-allowed',
                'hover:brightness-110',
              )}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
              {busy ? 'working…' :
                mode === 'signin' ? 'sign in' :
                mode === 'signup' ? 'create account' :
                'continue as guest'}
            </button>

            <div className="text-dim2 text-[11px] text-center pt-2">
              Local-first. Your password never leaves this machine.
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function Field({ label, hint, children }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <label className="text-ink text-xs font-medium">{label}</label>
      </div>
      {children}
      {hint && <div className="text-dim2 text-[10px] mt-1">{hint}</div>}
    </div>
  );
}

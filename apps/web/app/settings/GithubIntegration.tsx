'use client';

import { useEffect, useState } from 'react';
import {
  GitBranch as Github, KeyRound, CheckCircle2, AlertTriangle, Save, Trash2, RefreshCw,
  Link2, Link2Off, Terminal, User,
} from 'lucide-react';
import { useWorkspaceId } from '../../components/WorkspaceProvider';
import { toast } from '../../components/Toast';
import { cn } from '../../lib/cn';

interface GithubState {
  username?: string;
  ghCliDetected: boolean;
  ghCliVersion?: string;
  ghCliBinaryPath?: string;
  ghCliAuthenticated: boolean;
  ghCliLoggedInUser?: string;
  ghCliAuthError?: string;
  ghConnected: boolean;
  ghConnectedAt?: number;
  patSet: boolean;
  patHint?: string;
  patSavedAt?: number;
  defaultOwner?: string;
  ready: boolean;
}

export function GithubIntegration() {
  const workspaceId = useWorkspaceId();
  const [state, setState] = useState<GithubState | null>(null);
  const [patDraft, setPatDraft] = useState('');
  const [ownerDraft, setOwnerDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const base = `/api/workspaces/${workspaceId}/integrations/github`;

  async function refresh() {
    if (!workspaceId) return;
    const r = await fetch(base);
    if (r.ok) {
      const j = await r.json();
      setState(j);
      setOwnerDraft(j.defaultOwner ?? '');
    }
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 6000); return () => clearInterval(t); }, [workspaceId]);

  async function connectCli() {
    if (!state?.ghCliDetected) return;
    if (!confirm(`Connect Atrune to your local \`gh\` CLI session?\n\nVersion: ${state.ghCliVersion ?? 'detected'}\nLogged in as: ${state.ghCliLoggedInUser ?? 'unknown'}\n\nWorkspace repo operations will run as whoever is currently logged in via \`gh auth login\`.`)) return;
    setBusy('cli-connect');
    try {
      const r = await fetch(`${base}/cli/connect`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `http ${r.status}`);
      setState(j);
      toast({ title: 'Connected to gh CLI', description: j.ghCliLoggedInUser, variant: 'success' });
    } catch (e: any) { toast({ title: 'Connect failed', description: e?.message, variant: 'error' }); }
    finally { setBusy(null); }
  }

  async function disconnectCli() {
    if (!confirm('Disconnect from the gh CLI session? Repo operations will fall back to PAT (if set) or fail.')) return;
    setBusy('cli-disconnect');
    try {
      const r = await fetch(`${base}/cli/disconnect`, { method: 'POST' });
      const j = await r.json();
      setState(j);
      toast({ title: 'gh CLI disconnected', variant: 'warn' });
    } finally { setBusy(null); }
  }

  async function savePat() {
    if (!patDraft.trim() && !ownerDraft.trim()) return;
    setBusy('pat-save');
    try {
      const body: any = {};
      if (patDraft.trim()) body.pat = patDraft.trim();
      if (ownerDraft !== (state?.defaultOwner ?? '')) body.defaultOwner = ownerDraft.trim();
      const r = await fetch(`${base}/pat`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'save failed');
      setState(j); setPatDraft('');
      toast({ title: 'GitHub settings saved', variant: 'success' });
    } catch (e: any) { toast({ title: 'Save failed', description: e?.message, variant: 'error' }); }
    finally { setBusy(null); }
  }

  async function clearPat() {
    if (!confirm('Remove your stored GitHub PAT?')) return;
    setBusy('pat-clear');
    try {
      const r = await fetch(`${base}/pat`, { method: 'DELETE' });
      const j = await r.json();
      setState(j);
      toast({ title: 'PAT cleared', variant: 'warn' });
    } finally { setBusy(null); }
  }

  if (!state) {
    return (
      <section>
        <SectionHeader icon={<Github size={14} className="text-accent" />} title="GitHub" />
        <div className="h-24 shimmer bg-line/20 rounded-lg" />
      </section>
    );
  }

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Github size={14} className={state.ready ? 'text-accent' : 'text-dim'} />
        <span className="text-ink font-medium text-sm">GitHub</span>
        {state.ready
          ? <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-accent/40 text-accent bg-accent/10">ready</span>
          : <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-line/70 text-dim2">not configured</span>}
        <button onClick={refresh} className="ml-auto text-dim2 hover:text-ink text-xs flex items-center gap-1">
          <RefreshCw size={11} /> refresh
        </button>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        {/* gh CLI card */}
        <div className={cn('border rounded-lg p-3 bg-surface2/50',
          state.ghConnected ? 'border-accent/40 shadow-glow' : state.ghCliDetected ? 'border-line/70' : 'border-line/40')}>
          <div className="flex items-center gap-2 mb-1.5">
            <Terminal size={13} className={state.ghConnected ? 'text-accent' : 'text-dim'} />
            <span className="text-ink text-sm font-medium">gh CLI</span>
            {state.ghCliDetected ? (
              <span className="text-[10px] font-mono text-dim2 ml-auto">{state.ghCliVersion}</span>
            ) : (
              <span className="text-[10px] uppercase tracking-wider text-dim2 ml-auto">not detected</span>
            )}
          </div>
          {state.ghCliDetected ? (
            <>
              <div className="text-dim text-[11px] mb-2 flex items-center gap-1">
                {state.ghCliAuthenticated ? (
                  <><User size={10} className="text-accent" /> logged in as <span className="font-mono text-ink2">{state.ghCliLoggedInUser ?? '(unknown)'}</span></>
                ) : (
                  <><AlertTriangle size={10} className="text-warn" /> installed but not logged in — run <code className="font-mono text-ink2">gh auth login</code></>
                )}
              </div>
              {state.ghCliAuthError && <div className="text-warn text-[10px] mb-2">{state.ghCliAuthError}</div>}
              {state.ghConnected ? (
                <button
                  onClick={disconnectCli}
                  disabled={busy === 'cli-disconnect'}
                  className="flex items-center gap-1 px-2 py-1 rounded-md border border-line/70 text-ink2 hover:text-ink hover:border-line2 text-xs disabled:opacity-40"
                >
                  <Link2Off size={11} /> disconnect
                </button>
              ) : (
                <button
                  onClick={connectCli}
                  disabled={!state.ghCliAuthenticated || busy === 'cli-connect'}
                  className="flex items-center gap-1 px-2 py-1 rounded-md bg-accent text-bg text-xs font-medium shadow-glow disabled:opacity-40"
                >
                  <Link2 size={11} /> {busy === 'cli-connect' ? 'connecting…' : 'connect gh CLI'}
                </button>
              )}
            </>
          ) : (
            <div className="text-dim2 text-[11px]">
              Install <code className="font-mono text-ink2">gh</code> from <a href="https://cli.github.com" target="_blank" rel="noreferrer" className="text-accent hover:underline">cli.github.com</a> and run <code className="font-mono text-ink2">gh auth login</code>.
            </div>
          )}
        </div>

        {/* PAT card */}
        <div className={cn('border rounded-lg p-3 bg-surface2/50',
          state.patSet ? 'border-info/40' : 'border-line/70')}>
          <div className="flex items-center gap-2 mb-1.5">
            <KeyRound size={13} className={state.patSet ? 'text-info' : 'text-dim'} />
            <span className="text-ink text-sm font-medium">Personal access token</span>
            {state.patSet && (
              <span className="ml-auto text-[10px] font-mono text-dim2">{state.patHint}</span>
            )}
          </div>
          <div className="text-dim text-[11px] mb-2">
            Used as fallback when gh CLI isn't connected. Needs <code className="font-mono text-ink2">repo</code> scope to create repos + issues. Stored locally, chmod 600.
          </div>
          <input
            type="password"
            value={patDraft}
            onChange={(e) => setPatDraft(e.target.value)}
            placeholder={state.patSet ? '••••••••' : 'github_pat_…'}
            className="w-full bg-bg/60 border border-line/70 rounded-md px-2 py-1.5 text-xs text-ink font-mono outline-none focus:border-accent/60 mb-2"
          />
          <div className="text-dim2 text-[10px] uppercase tracking-wider mb-0.5">Default owner (optional)</div>
          <input
            value={ownerDraft}
            onChange={(e) => setOwnerDraft(e.target.value)}
            placeholder="your-username-or-org"
            className="w-full bg-bg/60 border border-line/70 rounded-md px-2 py-1 text-xs text-ink outline-none focus:border-accent/60 mb-2"
          />
          <div className="flex items-center gap-2 justify-end">
            {state.patSet && (
              <button
                onClick={clearPat}
                disabled={busy === 'pat-clear'}
                className="flex items-center gap-1 px-2 py-1 rounded-md border border-err/40 text-err text-xs hover:bg-err/10 disabled:opacity-40"
              >
                <Trash2 size={11} /> clear
              </button>
            )}
            <button
              onClick={savePat}
              disabled={busy === 'pat-save' || (!patDraft.trim() && ownerDraft === (state.defaultOwner ?? ''))}
              className="flex items-center gap-1 px-3 py-1 rounded-md bg-accent text-bg text-xs font-medium shadow-glow disabled:opacity-40"
            >
              <Save size={11} /> save
            </button>
          </div>
        </div>
      </div>

      <div className="mt-2 text-dim2 text-[10px] flex items-center gap-1">
        <CheckCircle2 size={10} /> Repo operations prefer gh CLI when both are set.
      </div>
    </section>
  );
}

function SectionHeader({ title, icon }: { title: string; icon: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      {icon}
      <span className="text-ink font-medium text-sm">{title}</span>
    </div>
  );
}

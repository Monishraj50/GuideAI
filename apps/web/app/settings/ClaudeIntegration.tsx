'use client';

import { useEffect, useState } from 'react';
import {
  Terminal, KeyRound, CheckCircle2, AlertTriangle, Save, Trash2, RefreshCw,
  ExternalLink, Link2, Link2Off, Plug, Cpu, FolderTree, Users, ScrollText, Lock, Puzzle,
} from 'lucide-react';
import { useWorkspaceId } from '../../components/WorkspaceProvider';
import { toast } from '../../components/Toast';
import { cn } from '../../lib/cn';

interface ClaudeDetails {
  binaryPath?: string;
  homeDir: string;
  defaultModel?: string;
  effortLevel?: string;
  statusLineConfigured: boolean;
  credentialsPresent: boolean;
  plugins: string[];
  agents: { count: number; sample: string[] };
  mcpServers: number;
  projects: number;
  sessions: number;
  policyLimits?: { maxConcurrentSessions?: number; maxToolsPerCall?: number };
}

interface ClaudeState {
  username?: string;
  cliDetected: boolean;
  cliVersion?: string;
  cliBinaryPath?: string;
  cliConnected: boolean;
  cliConnectedAt?: number;
  cliConnectedVersion?: string;
  details?: ClaudeDetails;
  apiKeySet: boolean;
  apiKeyHint?: string;
  apiKeySavedAt?: number;
  ready: boolean;
}

export function ClaudeIntegration() {
  const workspaceId = useWorkspaceId();
  const [state, setState] = useState<ClaudeState | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const base = `/api/workspaces/${workspaceId}/integrations/claude`;

  async function refresh() {
    if (!workspaceId) return;
    const r = await fetch(base);
    if (r.ok) setState(await r.json());
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, [workspaceId]);

  async function connectCli() {
    if (!state?.cliDetected) return;
    if (!confirm(
      `Connect Atrune to your local Claude CLI session?\n\nVersion: ${state.cliVersion ?? 'detected'}\n\nBriefs will execute against the credentials and subscription of whoever is currently logged in via \`claude /login\`. You can disconnect at any time.`,
    )) return;
    setBusy('cli-connect');
    try {
      const r = await fetch(`${base}/cli/connect`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `http ${r.status}`);
      setState(j);
      toast({ title: 'Connected to Claude CLI', description: j.cliVersion, variant: 'success' });
    } catch (e: any) { toast({ title: 'Connect failed', description: e?.message, variant: 'error' }); }
    finally { setBusy(null); }
  }

  async function disconnectCli() {
    if (!confirm('Disconnect from the Claude CLI session? Briefs will fail until you connect the CLI again or save an API key.')) return;
    setBusy('cli-disconnect');
    try {
      const r = await fetch(`${base}/cli/disconnect`, { method: 'POST' });
      const j = await r.json();
      setState(j);
      toast({ title: 'CLI disconnected', variant: 'warn' });
    } finally { setBusy(null); }
  }

  async function saveKey() {
    if (!keyDraft.trim()) return;
    if (!confirm('Save this Anthropic API key? It will be stored locally and forwarded to the Claude CLI as ANTHROPIC_API_KEY for every brief.')) return;
    setBusy('save');
    try {
      const r = await fetch(`${base}/apikey`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: keyDraft.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `http ${r.status}`);
      toast({ title: 'API key saved', description: j.apiKeyHint, variant: 'success' });
      setKeyDraft('');
      setState(j);
    } catch (e: any) { toast({ title: 'Save failed', description: e?.message, variant: 'error' }); }
    finally { setBusy(null); }
  }

  async function clearKey() {
    if (!confirm('Remove stored Anthropic API key? Atrune will fall back to the connected CLI session if any.')) return;
    setBusy('clear');
    try {
      const r = await fetch(`${base}/apikey`, { method: 'DELETE' });
      const j = await r.json();
      setState(j);
      toast({ title: 'API key cleared', variant: 'warn' });
    } finally { setBusy(null); }
  }

  const cliBadge = state?.cliConnected
    ? { label: 'connected', cls: 'border-accent/40 text-accent bg-accent/10' }
    : state?.cliDetected
      ? { label: 'available · not connected', cls: 'border-warn/40 text-warn bg-warn/10' }
      : { label: 'not detected', cls: 'border-line text-dim bg-line/20' };

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Plug size={14} className={state?.ready ? 'text-accent' : 'text-warn'} />
        <span className="text-ink font-medium text-sm">Claude integration</span>
        {state?.ready
          ? <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full border border-accent/40 text-accent bg-accent/10">connected</span>
          : <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full border border-warn/40 text-warn bg-warn/10">not connected</span>}
        <span className="text-dim2 text-[10px] font-mono ml-1">project · {workspaceId}</span>
        <button onClick={refresh} className="ml-auto text-dim2 hover:text-ink text-xs flex items-center gap-1"><RefreshCw size={11} /> refresh</button>
      </div>

      {!state?.ready && (
        <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-md border border-warn/40 bg-warn/[0.06] text-xs">
          <AlertTriangle size={12} className="text-warn mt-0.5" />
          <div className="flex-1 text-dim">
            <span className="text-warn">No integration is connected for this project.</span> Briefs will fail until you either connect the detected Claude CLI session or save an Anthropic API key below — your choice. <span className="text-dim2">Each project keeps its own integration, so different work can use different keys.</span>
          </div>
        </div>
      )}

      {state?.cliConnected && state?.cliConnectedAt && (
        <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-md border border-accent/40 bg-accent/[0.06] text-xs">
          <CheckCircle2 size={12} className="text-accent mt-0.5" />
          <div className="flex-1 text-dim">
            <span className="text-accent">CLI consent on file</span> for this project since <span className="text-ink">{new Date(state.cliConnectedAt).toLocaleString()}</span>{state.cliConnectedVersion ? <> · CLI <span className="font-mono text-ink">{state.cliConnectedVersion}</span></> : null}.
          </div>
        </div>
      )}

      <div className="border border-line/70 rounded-lg bg-surface2/50 overflow-hidden">
        {/* CLI row */}
        <div className="p-4 border-b border-line/40 flex items-start gap-3">
          <div className={cn(
            'w-9 h-9 rounded-md border flex items-center justify-center shrink-0',
            state?.cliConnected ? 'border-accent/40 bg-accent/10 text-accent' :
            state?.cliDetected  ? 'border-warn/40 bg-warn/10 text-warn' :
            'border-line/70 bg-bg/40 text-dim2',
          )}>
            <Terminal size={14} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-ink text-sm font-medium">Claude CLI</span>
              <span className={cn('text-[10px] font-mono px-1.5 py-0.5 rounded-full border', cliBadge.cls)}>{cliBadge.label}</span>
            </div>
            <div className="text-dim2 text-[11px] font-mono mt-0.5">
              {state?.cliVersion ?? 'no version'}
              {state?.cliConnected && state?.cliConnectedAt && (
                <span> · connected {new Date(state.cliConnectedAt).toLocaleDateString()}</span>
              )}
            </div>
            <div className="text-dim text-[11px] mt-1">
              {state?.cliConnected
                ? 'Briefs route through this CLI session. You can disconnect anytime.'
                : state?.cliDetected
                  ? 'A Claude CLI is installed but not connected. Click to opt in — briefs will use this session\'s credentials.'
                  : 'Install Claude Code, then run `claude /login`.'}
            </div>
          </div>
          {state?.cliConnected ? (
            <button
              onClick={disconnectCli}
              disabled={busy === 'cli-disconnect'}
              className="flex items-center gap-1 px-3 py-1.5 rounded-md border border-err/40 text-err text-xs disabled:opacity-40 hover:bg-err/10"
            >
              <Link2Off size={11} /> disconnect
            </button>
          ) : (
            <button
              onClick={connectCli}
              disabled={!state?.cliDetected || busy === 'cli-connect'}
              className={cn(
                'flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium',
                state?.cliDetected
                  ? 'bg-accent text-bg hover:brightness-110 shadow-glow'
                  : 'border border-line/70 text-dim2 cursor-not-allowed',
                'disabled:opacity-40',
              )}
            >
              <Link2 size={11} /> connect
            </button>
          )}
        </div>

        {/* Connected-only details panel */}
        {state?.cliConnected && state?.details && (
          <div className="px-4 pb-4 border-b border-line/40 animate-fadeIn">
            <div className="text-dim2 text-[10px] uppercase tracking-wider mt-1 mb-2">CLI details</div>
            <div className="grid md:grid-cols-2 gap-2 text-xs">
              <DetailRow icon={<Terminal size={11} />} label="Binary"        value={state.details.binaryPath ?? '—'} mono />
              <DetailRow icon={<FolderTree size={11} />} label="Home"        value={state.details.homeDir} mono />
              <DetailRow icon={<Cpu size={11} />}        label="Default model" value={state.details.defaultModel ?? '—'} accent={!!state.details.defaultModel} />
              <DetailRow icon={<ScrollText size={11} />} label="Effort"      value={state.details.effortLevel ?? '—'} />
              <DetailRow
                icon={<Lock size={11} />}
                label="Credentials"
                value={state.details.credentialsPresent ? 'present (.credentials.json)' : 'not found'}
                accent={state.details.credentialsPresent}
              />
              <DetailRow
                icon={<Plug size={11} />}
                label="Status line"
                value={state.details.statusLineConfigured ? 'configured' : 'default'}
              />
              <DetailRow
                icon={<Users size={11} />}
                label="Installed agents"
                value={state.details.agents.count > 0
                  ? `${state.details.agents.count}${state.details.agents.sample.length ? ` · ${state.details.agents.sample.slice(0, 3).join(', ')}${state.details.agents.sample.length > 3 ? '…' : ''}` : ''}`
                  : 'none'}
              />
              <DetailRow
                icon={<Puzzle size={11} />}
                label="MCP servers"
                value={state.details.mcpServers > 0 ? state.details.mcpServers.toString() : 'none'}
              />
              <DetailRow
                icon={<FolderTree size={11} />}
                label="Projects"
                value={state.details.projects.toString()}
              />
              <DetailRow
                icon={<ScrollText size={11} />}
                label="Sessions"
                value={state.details.sessions.toString()}
              />
            </div>
            {state.details.plugins.length > 0 && (
              <div className="mt-3">
                <div className="text-dim2 text-[10px] uppercase tracking-wider mb-1.5 flex items-center gap-1">
                  <Puzzle size={10} /> enabled plugins ({state.details.plugins.length})
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {state.details.plugins.map((p) => (
                    <span key={p} className="text-[10px] font-mono px-2 py-0.5 rounded-full border border-line/70 bg-bg/40 text-ink2">{p}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* API key row */}
        <div className="p-4">
          <div className="flex items-start gap-3 mb-3">
            <div className={cn(
              'w-9 h-9 rounded-md border flex items-center justify-center shrink-0',
              state?.apiKeySet ? 'border-accent/40 bg-accent/10 text-accent' : 'border-line/70 bg-bg/40 text-dim2',
            )}>
              <KeyRound size={14} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-ink text-sm font-medium">Anthropic API key</span>
                <span className={cn(
                  'text-[10px] font-mono px-1.5 py-0.5 rounded-full border',
                  state?.apiKeySet ? 'border-accent/40 text-accent bg-accent/10' : 'border-line text-dim bg-line/20',
                )}>
                  {state?.apiKeySet ? `stored · ${state.apiKeyHint}` : 'not set'}
                </span>
              </div>
              <div className="text-dim text-[11px] mt-1">
                Overrides the CLI session when set. Forwarded to <code className="font-mono text-ink2">ANTHROPIC_API_KEY</code>. Get a key at{' '}
                <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="text-accent inline-flex items-center gap-0.5 underline">
                  console.anthropic.com <ExternalLink size={9} />
                </a>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder={state?.apiKeySet ? 'replace key…' : 'sk-ant-…'}
              className="flex-1 bg-bg/60 border border-line/70 rounded-md px-3 py-1.5 text-xs text-ink font-mono outline-none focus:border-accent/60"
            />
            <button
              onClick={saveKey}
              disabled={busy === 'save' || !keyDraft.trim()}
              className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-accent text-bg text-xs font-medium disabled:opacity-40 hover:brightness-110"
            >
              <Save size={11} /> save
            </button>
            {state?.apiKeySet && (
              <button
                onClick={clearKey}
                disabled={busy === 'clear'}
                className="flex items-center gap-1 px-3 py-1.5 rounded-md border border-err/40 text-err text-xs disabled:opacity-40 hover:bg-err/10"
              >
                <Trash2 size={11} /> clear
              </button>
            )}
          </div>
          <div className="text-dim2 text-[10px] mt-2">
            Stored in <code className="font-mono text-ink2">~/.guideai/integrations/claude.json</code> · chmod 600. Never leaves your machine.
          </div>
        </div>
      </div>
    </section>
  );
}

function DetailRow({ icon, label, value, mono, accent }: { icon: React.ReactNode; label: string; value: string; mono?: boolean; accent?: boolean }) {
  return (
    <div className="flex items-center gap-2 border border-line/70 bg-bg/40 rounded-md px-2 py-1.5 min-w-0">
      <span className="text-dim2 shrink-0">{icon}</span>
      <span className="text-dim2 text-[10px] uppercase tracking-wider shrink-0">{label}</span>
      <span
        className={cn(
          'truncate ml-auto text-xs',
          mono && 'font-mono',
          accent ? 'text-accent' : 'text-ink',
        )}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import {
  KeyRound, Save, Trash2, RefreshCw, CheckCircle2, Sparkles,
} from 'lucide-react';
import { useWorkspaceId } from '../../components/WorkspaceProvider';
import { toast } from '../../components/Toast';
import { cn } from '../../lib/cn';

interface OpenAIState {
  username?: string;
  apiKeySet: boolean;
  apiKeyHint?: string;
  apiKeySavedAt?: number;
  modelOverrides: { haiku?: string; sonnet?: string; opus?: string };
  ready: boolean;
}

export function OpenAIIntegration() {
  const workspaceId = useWorkspaceId();
  const [state, setState] = useState<OpenAIState | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [overrides, setOverrides] = useState({ haiku: '', sonnet: '', opus: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const base = `/api/workspaces/${workspaceId}/integrations/openai`;

  async function refresh() {
    if (!workspaceId) return;
    const r = await fetch(base);
    if (r.ok) {
      const j = await r.json();
      setState(j);
      setOverrides({
        haiku:  j.modelOverrides?.haiku  ?? '',
        sonnet: j.modelOverrides?.sonnet ?? '',
        opus:   j.modelOverrides?.opus   ?? '',
      });
    }
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 6000); return () => clearInterval(t); }, [workspaceId]);

  async function save() {
    setBusy('save');
    try {
      const body: any = {};
      if (keyDraft.trim()) body.apiKey = keyDraft.trim();
      body.modelOverrides = {
        haiku:  overrides.haiku.trim() || undefined,
        sonnet: overrides.sonnet.trim() || undefined,
        opus:   overrides.opus.trim()  || undefined,
      };
      const r = await fetch(base, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'save failed');
      setState(j); setKeyDraft('');
      toast({ title: 'OpenAI settings saved', variant: 'success' });
    } catch (e: any) { toast({ title: 'Save failed', description: e?.message, variant: 'error' }); }
    finally { setBusy(null); }
  }

  async function clearKey() {
    if (!confirm('Clear the stored OpenAI API key for this project?')) return;
    setBusy('clear');
    try {
      const r = await fetch(base, { method: 'DELETE' });
      const j = await r.json();
      setState(j);
      toast({ title: 'API key cleared', variant: 'warn' });
    } finally { setBusy(null); }
  }

  if (!state) {
    return (
      <section>
        <Header />
        <div className="h-24 shimmer bg-line/20 rounded-lg" />
      </section>
    );
  }

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Sparkles size={14} className={state.ready ? 'text-accent' : 'text-dim'} />
        <span className="text-ink font-medium text-sm">OpenAI (cross-vendor review)</span>
        {state.ready
          ? <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-accent/40 text-accent bg-accent/10">ready</span>
          : <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-line/70 text-dim2">not configured</span>}
        <button onClick={refresh} className="ml-auto text-dim2 hover:text-ink text-xs flex items-center gap-1">
          <RefreshCw size={11} /> refresh
        </button>
      </div>

      <div className={cn('border rounded-lg p-3 bg-surface2/50',
        state.apiKeySet ? 'border-info/40' : 'border-line/70')}>
        <div className="flex items-center gap-2 mb-1.5">
          <KeyRound size={13} className={state.apiKeySet ? 'text-info' : 'text-dim'} />
          <span className="text-ink text-sm font-medium">API key</span>
          {state.apiKeySet && (
            <span className="ml-auto text-[10px] font-mono text-dim2">{state.apiKeyHint}</span>
          )}
        </div>
        <div className="text-dim text-[11px] mb-2">
          Used for the cross-vendor review pass when a workspace enables second opinion + the brief is security-tagged.
          Stored locally, chmod 600. Never leaves this machine.
        </div>
        <input
          type="password"
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          placeholder={state.apiKeySet ? '••••••••' : 'sk-…'}
          className="w-full bg-bg/60 border border-line/70 rounded-md px-2 py-1.5 text-xs text-ink font-mono outline-none focus:border-accent/60 mb-3"
        />

        <div className="text-dim2 text-[10px] uppercase tracking-wider mb-1.5">Model overrides (optional)</div>
        <div className="grid grid-cols-3 gap-2 mb-2">
          {(['haiku', 'sonnet', 'opus'] as const).map((tier) => (
            <div key={tier}>
              <div className="text-dim2 text-[10px] uppercase tracking-wider mb-0.5">{tier}</div>
              <input
                value={overrides[tier]}
                onChange={(e) => setOverrides({ ...overrides, [tier]: e.target.value })}
                placeholder={tier === 'haiku' ? 'gpt-5-mini' : 'gpt-5'}
                className="w-full bg-bg/60 border border-line/70 rounded-md px-2 py-1 text-xs text-ink font-mono outline-none focus:border-accent/60"
              />
            </div>
          ))}
        </div>
        <div className="text-dim2 text-[10px] mb-3">
          Leave blank to fall back to the Atrium defaults (mini for haiku, full for sonnet/opus).
        </div>

        <div className="flex items-center gap-2 justify-end">
          {state.apiKeySet && (
            <button
              onClick={clearKey}
              disabled={busy === 'clear'}
              className="flex items-center gap-1 px-2 py-1 rounded-md border border-err/40 text-err text-xs hover:bg-err/10 disabled:opacity-40"
            >
              <Trash2 size={11} /> clear
            </button>
          )}
          <button
            onClick={save}
            disabled={busy === 'save' || (!keyDraft.trim() && state.apiKeySet === false && !overrides.haiku && !overrides.sonnet && !overrides.opus)}
            className="flex items-center gap-1 px-3 py-1 rounded-md bg-accent text-bg text-xs font-medium shadow-glow disabled:opacity-40"
          >
            <Save size={11} /> save
          </button>
        </div>
      </div>
      <div className="mt-2 text-dim2 text-[10px] flex items-center gap-1">
        <CheckCircle2 size={10} /> Each workspace also has a toggle on the project page — both this key AND the toggle must be set for cross-vendor review to fire.
      </div>
    </section>
  );
}

function Header() {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Sparkles size={14} className="text-dim" />
      <span className="text-ink font-medium text-sm">OpenAI (cross-vendor review)</span>
    </div>
  );
}

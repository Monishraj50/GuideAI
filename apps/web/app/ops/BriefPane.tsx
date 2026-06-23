'use client';

import { useEffect, useState } from 'react';
import { Send, ShieldAlert, Cpu, Loader2 } from 'lucide-react';
import { toast } from '../../components/Toast';
import { cn } from '../../lib/cn';

interface RuntimeListing {
  id: 'claude' | 'codex' | 'copilot' | 'gemini';
  displayName: string;
  availability: 'ready' | 'coming-soon';
  description: string;
}

export function BriefPane({ workspaceId }: { workspaceId: string }) {
  const [text, setText] = useState('');
  const [securityTagged, setSecurityTagged] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeListing['id']>('claude');
  const [runtimes, setRuntimes] = useState<RuntimeListing[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/runtimes').then((r) => r.json()).then((j) => setRuntimes(j.runtimes ?? []));
  }, []);

  async function submit() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/briefs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Direct-dispatch from /ops or the project page composer runs end-to-end.
        // Plan-approval flows are the only path that uses mode='pending'
        // (set inside the orchestrator; not exposed here).
        body: JSON.stringify({ body: text, securityTagged, mode: 'auto' }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `http ${res.status}`);
      toast({
        title: `Brief dispatched`,
        description: `${j.briefId}${j.securityTagged ? ' · review runs pass@3' : ''}`,
        variant: 'success',
      });
      setText('');
    } catch (e: any) {
      toast({ title: 'Brief failed', description: e?.message ?? String(e), variant: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-ink text-sm font-medium">Brief the team</div>
          <div className="text-dim2 text-[11px]">Sent to Chief of Staff · sequential pipeline</div>
        </div>
      </div>
      <textarea
        className={cn(
          'bg-bg/70 border border-line/70 rounded-lg p-3 text-sm text-ink resize-none h-28',
          'outline-none focus:border-accent/60 focus:bg-bg transition-colors',
          'disabled:opacity-50 placeholder:text-dim2',
        )}
        placeholder="e.g. plan the migration from chokidar to fs-watch"
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
        }}
      />
      <label className="flex items-center gap-2 text-xs text-dim cursor-pointer select-none px-1">
        <input
          type="checkbox"
          checked={securityTagged}
          onChange={(e) => setSecurityTagged(e.target.checked)}
          className="accent-accent"
        />
        <ShieldAlert size={12} className={securityTagged ? 'text-warn' : 'text-dim2'} />
        <span className={securityTagged ? 'text-ink' : 'text-dim'}>security · review runs pass@3</span>
      </label>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-dim flex-1">
          <Cpu size={12} className="text-dim2" />
          <select
            value={runtime}
            onChange={(e) => setRuntime(e.target.value as RuntimeListing['id'])}
            className="flex-1 bg-bg/70 border border-line/70 rounded-md px-2 py-1.5 text-ink text-xs font-mono outline-none focus:border-accent/60"
          >
            {runtimes.map((rt) => (
              <option key={rt.id} value={rt.id} disabled={rt.availability !== 'ready'}>
                {rt.displayName}{rt.availability === 'coming-soon' ? ' (soon)' : ''}
              </option>
            ))}
            {runtimes.length === 0 && <option value="claude">Claude Code</option>}
          </select>
        </label>
        <kbd className="px-1.5 py-0.5 rounded bg-bg/60 border border-line/70 text-[10px] text-dim font-mono">⌘↵</kbd>
        <button
          onClick={submit}
          disabled={busy || !text.trim()}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium',
            'bg-gradient-to-br from-accent to-accent2 text-bg shadow-glow',
            'disabled:opacity-40 disabled:shadow-none disabled:cursor-not-allowed',
            'hover:brightness-110 transition-all',
          )}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          send
        </button>
      </div>
    </div>
  );
}

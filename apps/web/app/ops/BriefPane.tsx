'use client';

import { useEffect, useState } from 'react';

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
  const [last, setLast] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/runtimes').then((r) => r.json()).then((j) => setRuntimes(j.runtimes ?? []));
  }, []);

  async function submit() {
    if (!text.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/briefs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: text, securityTagged }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `http ${res.status}`);
      const securityNote = j.securityTagged ? ' · review runs pass@3' : '';
      setLast(`brief ${j.briefId} dispatched · pipeline running${securityNote}`);
      setText('');
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-ink font-medium text-sm">Brief the team</div>
      <textarea
        className="bg-bg border border-line rounded p-2 text-sm text-ink resize-none h-32 outline-none focus:border-accent disabled:opacity-50"
        placeholder="What should the team do? e.g. 'plan the migration from chokidar to fs-watch'"
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
        }}
      />
      <label className="flex items-center gap-2 text-xs text-dim cursor-pointer select-none">
        <input
          type="checkbox"
          checked={securityTagged}
          onChange={(e) => setSecurityTagged(e.target.checked)}
          className="accent-accent"
        />
        <span>security review (review phase runs pass@3)</span>
      </label>
      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-xs text-dim">
          <span>runtime</span>
          <select
            value={runtime}
            onChange={(e) => setRuntime(e.target.value as RuntimeListing['id'])}
            className="bg-bg border border-line rounded px-2 py-1 text-ink text-xs font-mono"
          >
            {runtimes.map((rt) => (
              <option key={rt.id} value={rt.id} disabled={rt.availability !== 'ready'}>
                {rt.displayName}{rt.availability === 'coming-soon' ? ' (soon)' : ''}
              </option>
            ))}
            {runtimes.length === 0 && <option value="claude">Claude Code</option>}
          </select>
        </label>
        <div className="flex items-center gap-2 ml-auto">
          <div className="text-dim text-xs">⌘↵</div>
          <button
            onClick={submit}
            disabled={busy || !text.trim()}
            className="px-3 py-1 text-sm rounded bg-accent text-bg font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110"
          >
            {busy ? 'briefing…' : 'send'}
          </button>
        </div>
      </div>
      {last && <div className="text-dim text-xs">{last}</div>}
      {err && <div className="text-err text-xs">{err}</div>}
    </div>
  );
}

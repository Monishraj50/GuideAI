'use client';

import { useState } from 'react';

export function BriefPane({ workspaceId }: { workspaceId: string }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!text.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/briefs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: text }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `http ${res.status}`);
      setLast(`brief ${j.briefId} dispatched · pipeline running (watch the feed for 5 phases)`);
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
      <div className="flex items-center justify-between">
        <div className="text-dim text-xs">⌘↵ to send</div>
        <button
          onClick={submit}
          disabled={busy || !text.trim()}
          className="px-3 py-1 text-sm rounded bg-accent text-bg font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110"
        >
          {busy ? 'briefing…' : 'send'}
        </button>
      </div>
      {last && <div className="text-dim text-xs">{last}</div>}
      {err && <div className="text-err text-xs">{err}</div>}
    </div>
  );
}

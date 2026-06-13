'use client';

import { useEffect, useState } from 'react';

interface Digest {
  date: string | null;
  text: string | null;
  summary: { briefs: number; phasesCompleted: number; tokensIn: number; tokensOut: number } | null;
  generatedAt?: number;
}

export function Home({ workspaceId }: { workspaceId: string }) {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    const r = await fetch(`/api/workspaces/${workspaceId}/digest`);
    if (r.ok) setDigest(await r.json());
  }
  async function triggerNow() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/digest`, { method: 'POST' });
      if (!r.ok) throw new Error('failed');
      await refresh();
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setBusy(false); }
  }
  useEffect(() => { refresh(); }, []);

  return (
    <div className="p-6 max-w-3xl">
      <div className="text-ink text-lg font-medium mb-1">Home</div>
      <div className="text-dim text-xs mb-6">workspace <span className="text-ink">{workspaceId}</span></div>

      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <div className="text-ink font-medium">Daily standup digest</div>
          <button
            onClick={triggerNow}
            disabled={busy}
            className="px-3 py-1 rounded bg-accent text-bg text-xs font-medium disabled:opacity-40 hover:brightness-110"
          >
            {busy ? 'running…' : 'run now'}
          </button>
        </div>
        {!digest?.date && <div className="text-dim text-xs italic">No digest yet. Click "run now" to generate one for the last 24h.</div>}
        {digest?.date && (
          <article className="border border-line rounded p-4 bg-bg">
            <div className="text-dim text-xs mb-2">
              {digest.date} · generated {digest.generatedAt ? new Date(digest.generatedAt).toLocaleString() : ''}
            </div>
            <pre className="whitespace-pre-wrap font-mono text-[13px] text-ink leading-relaxed">{digest.text}</pre>
          </article>
        )}
        {err && <div className="text-err text-xs mt-2">{err}</div>}
      </section>

      <section>
        <div className="text-ink font-medium mb-2">Quick links</div>
        <ul className="text-sm text-dim list-disc list-inside">
          <li><a className="text-accent underline" href="/ops">Ops</a> — live event feed + brief pane + approvals</li>
          <li><a className="text-accent underline" href="/hire">Hire</a> — 154-agent marketplace</li>
          <li><a className="text-accent underline" href="/org">Org Chart</a> — roster + performance reviews</li>
          <li><a className="text-accent underline" href="/settings">Settings</a> — auto-approval rules</li>
        </ul>
      </section>
    </div>
  );
}

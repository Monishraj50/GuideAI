'use client';

import { useEffect, useState } from 'react';
import {
  Brain, Plus, Trash2, Globe, Lock, EyeOff, RefreshCw, Save,
} from 'lucide-react';
import { toast } from '../../../components/Toast';
import { cn } from '../../../lib/cn';

type Share = 'all' | 'read-only' | 'deny';
interface MemoryEntry {
  id: string; role: string; sourceWorkspaceId: string;
  body: string; source: 'manual' | 'auto'; createdAt: number; updatedAt: number;
}

const SHARE_META: Record<Share, { icon: React.ComponentType<{ size?: number; className?: string }>; label: string; tint: string; description: string }> = {
  all:         { icon: Globe,   label: 'Share to all',  tint: 'text-accent border-accent/40 bg-accent/10', description: 'Notes added here are visible to agents working in any project.' },
  'read-only': { icon: Lock,    label: 'Read-only',     tint: 'text-info border-info/40 bg-info/10',       description: 'Other projects can read these notes; only this project can edit.' },
  deny:        { icon: EyeOff,  label: 'Don’t share', tint: 'text-dim border-line/70',                  description: 'These notes stay private to this project.' },
};

function fmtTs(ms: number) {
  const d = Date.now() - ms;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

export function MemorySection({ workspaceId }: { workspaceId: string }) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [share, setShare] = useState<Share>('read-only');
  const [draft, setDraft] = useState({ role: '', body: '' });
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/memory`);
      const j = await r.json();
      setEntries(j.entries ?? []);
      setShare(j.share ?? 'read-only');
    } catch {}
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 10000); return () => clearInterval(t); }, [workspaceId]);

  async function add() {
    if (!draft.role.trim() || !draft.body.trim()) return;
    setBusy('add');
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/memory`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'add failed');
      setDraft({ role: '', body: '' });
      await refresh();
      toast({ title: `Note saved for ${j.entry.role}`, variant: 'success' });
    } catch (e: any) { toast({ title: 'Save failed', description: e?.message, variant: 'error' }); }
    finally { setBusy(null); }
  }

  async function remove(id: string) {
    if (!confirm('Delete this memory note?')) return;
    setEntries((cur) => cur.filter((e) => e.id !== id));
    try {
      await fetch(`/api/memory/${id}`, { method: 'DELETE' });
    } catch { refresh(); }
  }

  async function saveShare(next: Share) {
    setBusy('share');
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/memory/share`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ share: next }),
      });
      const j = await r.json();
      setShare(j.share ?? next);
      toast({ title: `Share mode: ${j.share}`, variant: 'success' });
    } catch (e: any) { toast({ title: 'Failed', description: e?.message, variant: 'error' }); }
    finally { setBusy(null); }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Brain size={14} className="text-accent" />
        <span className="text-ink font-medium text-sm">Agent memory</span>
        <span className="text-dim2 text-[10px] font-mono ml-1">{entries.length} note{entries.length === 1 ? '' : 's'}</span>
        <button onClick={refresh} className="ml-auto text-dim2 hover:text-ink text-xs flex items-center gap-1">
          <RefreshCw size={11} /> refresh
        </button>
      </div>

      {/* Share mode */}
      <div className="border border-line/70 rounded-lg p-3 bg-surface2/40">
        <div className="text-dim2 text-[10px] uppercase tracking-wider mb-2">Cross-workspace sharing</div>
        <div className="grid md:grid-cols-3 gap-2">
          {(['all', 'read-only', 'deny'] as Share[]).map((s) => {
            const meta = SHARE_META[s];
            const Icon = meta.icon;
            const active = share === s;
            return (
              <button
                key={s}
                onClick={() => saveShare(s)}
                disabled={busy === 'share' || active}
                className={cn(
                  'text-left rounded-md border p-2 transition-all',
                  active ? `${meta.tint} shadow-glow` : 'border-line/70 bg-bg/30 hover:border-line2',
                )}
              >
                <div className="flex items-center gap-1.5">
                  <Icon size={12} />
                  <span className="text-ink text-xs font-medium">{meta.label}</span>
                  {active && <span className="ml-auto text-[10px] uppercase tracking-wider">active</span>}
                </div>
                <div className="text-dim text-[10px] mt-0.5">{meta.description}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Add form */}
      <div className="border border-line/70 rounded-lg p-3 bg-surface2/40 space-y-2">
        <div className="text-dim2 text-[10px] uppercase tracking-wider">Add note</div>
        <div className="grid md:grid-cols-3 gap-2">
          <input
            value={draft.role}
            onChange={(e) => setDraft({ ...draft, role: e.target.value })}
            placeholder="role (e.g. backend-developer)"
            className="bg-bg/60 border border-line/70 rounded-md px-2 py-1.5 text-xs text-ink font-mono outline-none focus:border-accent/60"
          />
          <input
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
            placeholder="what should this role remember next time?"
            className="md:col-span-2 bg-bg/60 border border-line/70 rounded-md px-2 py-1.5 text-xs text-ink outline-none focus:border-accent/60"
          />
        </div>
        <div className="flex justify-end">
          <button
            onClick={add}
            disabled={busy === 'add' || !draft.role.trim() || !draft.body.trim()}
            className="flex items-center gap-1 px-3 py-1 rounded-md bg-accent text-bg text-xs font-medium shadow-glow disabled:opacity-40"
          >
            <Plus size={11} /> add note
          </button>
        </div>
      </div>

      {/* Entry list */}
      {entries.length === 0 ? (
        <div className="border border-dashed border-line/70 rounded-lg p-3 text-dim2 text-[11px] italic">
          No memory notes yet. When you add a note for a role, it's prepended to that role's system prompt on the next phase — across every project that can read this workspace.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {entries.map((e) => (
            <li key={e.id} className="group border border-line/70 rounded-md p-2.5 bg-bg/30 flex items-start gap-2">
              <span className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-info/40 text-info bg-info/10 shrink-0">{e.role}</span>
              <div className="flex-1 min-w-0">
                <div className="text-ink2 text-[12.5px]">{e.body}</div>
                <div className="text-dim2 text-[10px] mt-0.5 font-mono">{e.source} · {fmtTs(e.updatedAt)}</div>
              </div>
              <button
                onClick={() => remove(e.id)}
                className="text-dim2 hover:text-err opacity-0 group-hover:opacity-100 transition-opacity"
                title="delete"
              >
                <Trash2 size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

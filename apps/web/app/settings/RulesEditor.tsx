'use client';

import { useEffect, useState } from 'react';
import { Check, Lock, HelpCircle, Trash2, Plus, ShieldCheck } from 'lucide-react';
import { toast } from '../../components/Toast';
import { cn } from '../../lib/cn';

interface Rule {
  id: string;
  description: string;
  match: { tool: string; argsPattern?: string };
  action: 'auto-approve' | 'always-ask' | 'deny';
  createdAt: number;
  synthesized?: boolean;
}
interface Policies {
  defaultAction: 'ask' | 'auto-approve' | 'deny';
  rules: Rule[];
}

const ACTION_META: Record<Rule['action'], { color: string; bg: string; icon: React.ComponentType<{ size?: number }> }> = {
  'auto-approve': { color: 'text-accent', bg: 'bg-accent/10 border-accent/30', icon: Check },
  'always-ask':   { color: 'text-warn',   bg: 'bg-warn/10 border-warn/30',     icon: HelpCircle },
  'deny':         { color: 'text-err',    bg: 'bg-err/10 border-err/30',       icon: Lock },
};

export function RulesEditor() {
  const [policies, setPolicies] = useState<Policies | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draftTool, setDraftTool] = useState('Bash');
  const [draftPattern, setDraftPattern] = useState('');
  const [draftAction, setDraftAction] = useState<Rule['action']>('auto-approve');

  async function refresh() {
    const r = await fetch('/api/policies');
    setPolicies(await r.json());
  }
  useEffect(() => { refresh(); }, []);

  async function addDraft() {
    if (!draftTool.trim()) return;
    setBusy('add');
    const id = `rule-user-${draftTool.toLowerCase()}-${Date.now().toString(36)}`;
    await fetch('/api/policies/rules', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id,
        description: `${draftAction} ${draftTool}${draftPattern ? '(' + draftPattern + ')' : ''}`,
        match: { tool: draftTool, ...(draftPattern ? { argsPattern: draftPattern } : {}) },
        action: draftAction,
      }),
    });
    toast({ title: `Rule added`, description: id, variant: 'success' });
    setDraftPattern('');
    await refresh();
    setBusy(null);
  }
  async function remove(id: string) {
    setBusy(id);
    await fetch(`/api/policies/rules/${id}`, { method: 'DELETE' });
    toast({ title: 'Rule removed', variant: 'warn' });
    await refresh();
    setBusy(null);
  }

  if (!policies) return <div className="space-y-2"><div className="h-4 w-32 shimmer bg-line/30 rounded" /><div className="h-12 w-full shimmer bg-line/20 rounded" /></div>;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="flex items-center gap-2 mb-2">
          <ShieldCheck size={14} className="text-accent" />
          <span className="text-ink font-medium text-sm">Auto-approval rules</span>
        </div>
        <div className="text-dim2 text-xs mb-3">
          Checked top-to-bottom; first match wins. No match → asks you.
        </div>
        <div className="border border-line/70 rounded-lg divide-y divide-line/40 bg-surface2/50 overflow-hidden">
          {policies.rules.length === 0 && (
            <div className="p-4 text-dim2 text-sm italic">No rules yet.</div>
          )}
          {policies.rules.map((r) => {
            const meta = ACTION_META[r.action];
            const Icon = meta.icon;
            return (
              <div key={r.id} className="p-3 flex items-center gap-3 text-sm hover:bg-line/20 transition-colors group">
                <div className={cn('flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] uppercase font-mono', meta.bg, meta.color)}>
                  <Icon size={10} /> {r.action}
                </div>
                <span className="font-mono text-xs text-ink">{r.match.tool}</span>
                {r.match.argsPattern && (
                  <span className="font-mono text-xs text-dim truncate">/{r.match.argsPattern}/</span>
                )}
                <span className="ml-auto text-dim2 text-xs truncate max-w-md">{r.description}</span>
                {r.synthesized && <span className="text-dim2 text-[10px] italic">synthesized</span>}
                <button
                  onClick={() => remove(r.id)}
                  disabled={busy === r.id}
                  className="text-dim2 hover:text-err opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-40"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <div className="text-dim2 text-[10px] uppercase tracking-wider mb-2">Add rule</div>
        <div className="flex flex-wrap items-center gap-2 text-sm border border-line/70 rounded-lg p-2 bg-surface2/50">
          <input
            value={draftTool}
            onChange={(e) => setDraftTool(e.target.value)}
            placeholder="tool name (e.g. Bash)"
            className="bg-bg/60 border border-line/70 rounded-md px-2 py-1 text-ink font-mono text-xs w-36 outline-none focus:border-accent/60"
          />
          <input
            value={draftPattern}
            onChange={(e) => setDraftPattern(e.target.value)}
            placeholder="args regex (optional, e.g. ^ls\b)"
            className="bg-bg/60 border border-line/70 rounded-md px-2 py-1 text-ink font-mono text-xs flex-1 min-w-[200px] outline-none focus:border-accent/60"
          />
          <select
            value={draftAction}
            onChange={(e) => setDraftAction(e.target.value as Rule['action'])}
            className="bg-bg/60 border border-line/70 rounded-md px-2 py-1 text-ink text-xs outline-none focus:border-accent/60"
          >
            <option value="auto-approve">auto-approve</option>
            <option value="always-ask">always-ask</option>
            <option value="deny">deny</option>
          </select>
          <button
            onClick={addDraft}
            disabled={busy === 'add'}
            className="flex items-center gap-1 px-3 py-1 rounded-md bg-accent text-bg font-medium text-xs disabled:opacity-40 hover:brightness-110 shadow-glow"
          >
            <Plus size={12} /> add
          </button>
        </div>
      </section>
    </div>
  );
}

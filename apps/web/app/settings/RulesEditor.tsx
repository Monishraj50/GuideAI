'use client';

import { useEffect, useState } from 'react';

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

const ACTION_COLOR: Record<Rule['action'], string> = {
  'auto-approve': 'text-accent',
  'always-ask': 'text-warn',
  'deny': 'text-err',
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
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id,
        description: `${draftAction} ${draftTool}${draftPattern ? '(' + draftPattern + ')' : ''}`,
        match: { tool: draftTool, ...(draftPattern ? { argsPattern: draftPattern } : {}) },
        action: draftAction,
      }),
    });
    setDraftPattern('');
    await refresh();
    setBusy(null);
  }

  async function remove(id: string) {
    setBusy(id);
    await fetch(`/api/policies/rules/${id}`, { method: 'DELETE' });
    await refresh();
    setBusy(null);
  }

  if (!policies) return <div className="text-dim text-sm">loading…</div>;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="text-ink font-medium text-sm mb-2">Auto-approval rules</div>
        <div className="text-dim text-xs mb-3">
          When an agent requests a tool, GuideAI checks each rule from top to bottom and applies the first match. No rule? → asks you.
        </div>
        <div className="border border-line rounded divide-y divide-line">
          {policies.rules.length === 0 && (
            <div className="p-3 text-dim text-xs italic">No rules yet.</div>
          )}
          {policies.rules.map((r) => (
            <div key={r.id} className="p-3 flex items-center gap-3 text-sm">
              <span className={`font-mono text-xs uppercase ${ACTION_COLOR[r.action]}`}>{r.action}</span>
              <span className="font-mono text-xs text-ink">{r.match.tool}</span>
              {r.match.argsPattern && (
                <span className="font-mono text-xs text-dim truncate">/{r.match.argsPattern}/</span>
              )}
              <span className="ml-auto text-dim text-xs">{r.description}</span>
              {r.synthesized && <span className="text-dim text-xs italic">synthesized</span>}
              <button
                onClick={() => remove(r.id)}
                disabled={busy === r.id}
                className="text-err text-xs hover:underline disabled:opacity-40"
              >
                remove
              </button>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="text-ink font-medium text-sm mb-2">Add rule</div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <input
            value={draftTool}
            onChange={(e) => setDraftTool(e.target.value)}
            placeholder="tool name (e.g. Bash)"
            className="bg-bg border border-line rounded px-2 py-1 text-ink font-mono text-xs w-40"
          />
          <input
            value={draftPattern}
            onChange={(e) => setDraftPattern(e.target.value)}
            placeholder="args regex (optional, e.g. ^ls\\b)"
            className="bg-bg border border-line rounded px-2 py-1 text-ink font-mono text-xs flex-1 min-w-[200px]"
          />
          <select
            value={draftAction}
            onChange={(e) => setDraftAction(e.target.value as Rule['action'])}
            className="bg-bg border border-line rounded px-2 py-1 text-ink text-xs"
          >
            <option value="auto-approve">auto-approve</option>
            <option value="always-ask">always-ask</option>
            <option value="deny">deny</option>
          </select>
          <button
            onClick={addDraft}
            disabled={busy === 'add'}
            className="px-3 py-1 rounded bg-accent text-bg font-medium text-xs disabled:opacity-40 hover:brightness-110"
          >
            add
          </button>
        </div>
      </section>
    </div>
  );
}

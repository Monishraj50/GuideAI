'use client';

import { useEffect, useState } from 'react';
import { X, Save, Loader2, Sparkles } from 'lucide-react';
import { toast } from './Toast';
import { cn } from '../lib/cn';

export interface AgentEditorAgent {
  id: string;
  role: string;
  displayName: string;
  systemPrompt?: string;
  toolWhitelist: string[];
  model?: string | null;
}

interface BaseProps {
  workspaceId: string;
  onClose: () => void;
  onSaved: () => void;
}

type Props = BaseProps & ({ mode: 'create' } | { mode: 'edit'; agent: AgentEditorAgent });

const ALL_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'] as const;
const MODELS = [
  { value: '',       label: 'auto (router picks)' },
  { value: 'haiku',  label: 'Haiku · fast / cheap' },
  { value: 'sonnet', label: 'Sonnet · default coding' },
  { value: 'opus',   label: 'Opus · deep reasoning' },
] as const;

export function AgentEditor(props: Props) {
  const isEdit = props.mode === 'edit';
  const initial = isEdit ? props.agent : null;

  const [displayName, setDisplayName] = useState(initial?.displayName ?? '');
  const [role, setRole] = useState(initial?.role ?? '');
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? '');
  const [tools, setTools] = useState<string[]>(initial?.toolWhitelist ?? ['Read', 'Glob', 'Grep']);
  const [model, setModel] = useState<string>(initial?.model ?? '');
  const [busy, setBusy] = useState(false);

  // Auto-derive role slug from displayName in create mode.
  useEffect(() => {
    if (isEdit) return;
    const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    setRole(slug);
  }, [displayName, isEdit]);

  function toggleTool(t: string) {
    setTools((cur) => cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]);
  }

  async function save() {
    if (!displayName.trim()) { toast({ title: 'Name required', variant: 'warn' }); return; }
    if (!systemPrompt.trim()) { toast({ title: 'System prompt required', variant: 'warn' }); return; }
    setBusy(true);
    try {
      const body = {
        displayName: displayName.trim(),
        systemPrompt: systemPrompt.trim(),
        toolWhitelist: tools,
        model: model || null,
        ...(isEdit ? {} : { role: role || undefined }),
      };
      const url = isEdit
        ? `/api/workspaces/${props.workspaceId}/agents/${props.agent.id}`
        : `/api/workspaces/${props.workspaceId}/agents/custom`;
      const res = await fetch(url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `http ${res.status}`);
      toast({
        title: isEdit ? `Saved ${j.displayName}` : `Created ${j.displayName}`,
        description: j.role,
        variant: 'success',
      });
      props.onSaved();
    } catch (e: any) {
      toast({ title: isEdit ? 'Save failed' : 'Create failed', description: e?.message, variant: 'error' });
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center animate-fadeIn">
      <div className="absolute inset-0 bg-bg/70 backdrop-blur-sm" onClick={props.onClose} />
      <div className="relative w-[640px] max-w-[92vw] max-h-[88vh] rounded-xl border border-line2 bg-surface2 shadow-soft flex flex-col overflow-hidden animate-slideUp">
        <header className="flex items-center justify-between px-5 py-3 border-b border-line/70">
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-accent" />
            <div>
              <div className="text-ink text-sm font-medium">
                {isEdit ? `Edit ${initial?.displayName ?? 'agent'}` : 'Create custom agent'}
              </div>
              <div className="text-dim2 text-[11px]">
                {isEdit ? `role: ${initial?.role}` : 'a new designation in your roster'}
              </div>
            </div>
          </div>
          <button onClick={props.onClose} className="text-dim hover:text-ink"><X size={14} /></button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          <Field label="Display name" hint="Shown in the org chart and feed.">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Database Admin"
              className="w-full bg-bg/60 border border-line/70 rounded-md px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
            />
          </Field>

          <Field label="Role slug" hint={isEdit ? 'Role is the identity — not editable after create.' : 'Auto-derived from name. Used in URLs and logs.'}>
            <input
              value={role}
              onChange={(e) => isEdit ? undefined : setRole(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              disabled={isEdit}
              placeholder="database-admin"
              className="w-full bg-bg/60 border border-line/70 rounded-md px-3 py-2 text-sm text-ink2 font-mono outline-none focus:border-accent/60 disabled:opacity-60"
            />
          </Field>

          <Field label="System prompt" hint="The persona and instructions the agent uses for every task.">
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="You are a database admin focused on PostgreSQL. Always check indexes before suggesting schema changes…"
              rows={8}
              className="w-full bg-bg/60 border border-line/70 rounded-md px-3 py-2 text-sm text-ink resize-y font-mono outline-none focus:border-accent/60"
            />
          </Field>

          <Field label="Tool whitelist" hint="Only these tools can be invoked.">
            <div className="flex flex-wrap gap-2">
              {ALL_TOOLS.map((t) => {
                const on = tools.includes(t);
                return (
                  <button
                    key={t}
                    onClick={() => toggleTool(t)}
                    className={cn(
                      'px-2 py-1 rounded-md text-xs font-mono border transition-all',
                      on
                        ? 'bg-accent/15 border-accent/40 text-accent'
                        : 'border-line/70 text-dim hover:border-line2 hover:text-ink2',
                    )}
                  >
                    {on ? '✓ ' : ''}{t}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label="Model" hint="Override the router. Leave on auto unless you have a reason.">
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full bg-bg/60 border border-line/70 rounded-md px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
            >
              {MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>
        </div>

        <footer className="px-5 py-3 border-t border-line/70 flex items-center justify-end gap-2 bg-bg/40">
          <button onClick={props.onClose} className="px-3 py-1.5 text-xs text-dim hover:text-ink">cancel</button>
          <button
            onClick={save}
            disabled={busy}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium',
              'bg-accent text-bg shadow-glow hover:brightness-110 disabled:opacity-40',
            )}
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {isEdit ? 'save changes' : 'create agent'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <label className="text-ink text-xs font-medium">{label}</label>
        {hint && <span className="text-dim2 text-[10px]">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

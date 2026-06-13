'use client';

import { useEffect, useMemo, useState } from 'react';
import { Search, Check, Plus, Trash2, Wrench, Cpu } from 'lucide-react';
import { toast } from '../../components/Toast';
import { cn } from '../../lib/cn';

interface Department { slug: string; label: string; count: number }
interface CatalogResp { fetchedAt: number; count: number; departments: Department[] }
interface AgentSummary { role: string; displayName: string; department: string; description: string; tools: string[]; model?: string }
interface AgentDetail extends AgentSummary { body: string }
interface RosterEntry { id: string; role: string; displayName: string; status: string; toolWhitelist: string[] }

const ACRONYMS = ['QA', 'API', 'AI', 'LLM', 'ML', 'CI', 'CD', 'AWS', 'SQL', 'CSS', 'HTML', 'JS', 'TS', 'PHP', 'CPP', 'IOT', 'UX', 'UI', 'SEO'];
function pretty(name: string) {
  return name.split(' ').map((w) => {
    const up = w.toUpperCase();
    return ACRONYMS.includes(up) ? up : w;
  }).join(' ');
}

export function HireMarketplace({ workspaceId }: { workspaceId: string }) {
  const [catalog, setCatalog] = useState<CatalogResp | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [dept, setDept] = useState<string | undefined>();
  const [q, setQ] = useState('');
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [hovered, setHovered] = useState<AgentDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadCatalog() {
    setError(null);
    const r = await fetch('/api/catalog');
    if (r.status === 503) { setError('Catalog not seeded. Run: pnpm --filter @guideai/agents-catalog seed'); return; }
    setCatalog(await r.json());
  }
  async function loadAgents() {
    const url = new URL(`/api/catalog/agents`, window.location.origin);
    if (dept) url.searchParams.set('dept', dept);
    if (q) url.searchParams.set('q', q);
    const r = await fetch(url.toString());
    if (!r.ok) return;
    const j = await r.json();
    setAgents(j.agents ?? []);
  }
  async function loadRoster() {
    const r = await fetch(`/api/workspaces/${workspaceId}/agents`);
    if (!r.ok) return;
    const j = await r.json();
    setRoster(j.roster ?? []);
  }
  useEffect(() => { loadCatalog(); loadRoster(); }, []);
  useEffect(() => { loadAgents(); }, [dept, q]);

  async function hire(role: string, name: string) {
    setBusy(role);
    try {
      await fetch(`/api/workspaces/${workspaceId}/agents`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      toast({ title: `Hired ${pretty(name)}`, variant: 'success' });
      await loadRoster();
    } finally { setBusy(null); }
  }
  async function retire(id: string, name: string) {
    setBusy(id);
    try {
      await fetch(`/api/workspaces/${workspaceId}/agents/${id}`, { method: 'DELETE' });
      toast({ title: `Retired ${pretty(name)}`, variant: 'warn' });
      await loadRoster();
    } finally { setBusy(null); }
  }
  async function preview(role: string) {
    const r = await fetch(`/api/catalog/agents/${role}`);
    if (r.ok) setHovered(await r.json());
  }

  const hiredRoles = useMemo(() => new Set(roster.map((r) => r.role)), [roster]);

  if (error) return <div className="p-6 text-err text-sm">{error}</div>;
  if (!catalog) {
    return (
      <div className="p-6 space-y-2">
        <div className="h-4 w-40 rounded shimmer bg-line/30" />
        <div className="h-3 w-72 rounded shimmer bg-line/20" />
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex">
      <aside className="w-56 border-r border-line/70 p-3 overflow-y-auto glass">
        <div className="text-dim2 text-[10px] uppercase tracking-wider mb-2 px-2">Departments</div>
        <button
          onClick={() => setDept(undefined)}
          className={cn(
            'w-full text-left px-2 py-1.5 rounded-md text-xs flex items-center justify-between',
            !dept ? 'bg-line2/60 text-ink' : 'text-dim hover:bg-line/40',
          )}
        >
          <span>All</span>
          <span className="text-dim2 font-mono">{catalog.count}</span>
        </button>
        {catalog.departments.map((d) => (
          <button
            key={d.slug}
            onClick={() => setDept(d.slug)}
            className={cn(
              'w-full text-left px-2 py-1.5 rounded-md text-xs flex items-center justify-between',
              dept === d.slug ? 'bg-line2/60 text-ink' : 'text-dim hover:bg-line/40',
            )}
          >
            <span className="truncate">{d.label}</span>
            <span className="text-dim2 font-mono">{d.count}</span>
          </button>
        ))}
        <div className="border-t border-line/70 my-4" />
        <div className="text-dim2 text-[10px] uppercase tracking-wider mb-2 px-2">Roster ({roster.length})</div>
        {roster.length === 0 && <div className="text-dim2 text-xs italic px-2">No agents hired yet.</div>}
        {roster.map((r) => (
          <div key={r.id} className="px-2 py-1 flex items-center justify-between text-xs group hover:bg-line/30 rounded">
            <span className="text-ink2 truncate">{pretty(r.displayName)}</span>
            <button
              onClick={() => retire(r.id, r.displayName)}
              disabled={busy === r.id}
              className="text-dim group-hover:text-err opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-40"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </aside>

      <main className="flex-1 min-w-0 flex flex-col">
        <div className="border-b border-line/70 px-4 py-2 flex items-center gap-2">
          <Search size={14} className="text-dim" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="search by role / description"
            className="flex-1 bg-transparent text-sm text-ink placeholder:text-dim2 outline-none"
          />
          <span className="text-dim2 text-[11px] font-mono">{agents.length} results</span>
        </div>
        <ol className="flex-1 min-h-0 overflow-y-auto divide-y divide-line/40">
          {agents.map((a) => {
            const isHired = hiredRoles.has(a.role);
            return (
              <li
                key={a.role}
                className="px-4 py-3 hover:bg-line/20 transition-colors group"
                onMouseEnter={() => preview(a.role)}
              >
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-ink truncate text-sm">{pretty(a.displayName)}</div>
                    <div className="text-dim text-xs truncate mt-0.5">{a.description}</div>
                  </div>
                  <div className="flex items-center gap-1 text-dim2 text-[10px] font-mono px-2 py-0.5 rounded-full border border-line/70">
                    <Wrench size={10} /> {a.tools.length}
                  </div>
                  <button
                    disabled={isHired || busy === a.role}
                    onClick={() => hire(a.role, a.displayName)}
                    className={cn(
                      'flex items-center gap-1 px-3 py-1 text-xs rounded-md font-medium whitespace-nowrap transition-all',
                      isHired
                        ? 'bg-line/40 text-dim cursor-default'
                        : 'bg-accent text-bg hover:brightness-110 shadow-glow disabled:opacity-40',
                    )}
                  >
                    {isHired ? <><Check size={12} /> hired</> : <><Plus size={12} /> hire</>}
                  </button>
                </div>
              </li>
            );
          })}
          {agents.length === 0 && (
            <li className="px-4 py-12 text-center text-dim text-sm italic">No agents match.</li>
          )}
        </ol>
      </main>

      <aside className="w-96 border-l border-line/70 p-4 overflow-y-auto hidden xl:block glass">
        <div className="text-dim2 text-[10px] uppercase tracking-wider mb-2">Preview</div>
        {!hovered && <div className="text-dim2 text-xs italic">Hover an agent to preview its system prompt.</div>}
        {hovered && (
          <div className="text-xs animate-fadeIn">
            <div className="text-ink font-mono">{hovered.role}</div>
            <div className="text-dim mt-1">{hovered.description}</div>
            <div className="text-dim2 mt-3 flex items-center gap-1"><Wrench size={10} /> {hovered.tools.join(', ') || '—'}</div>
            {hovered.model && <div className="text-dim2 mt-1 flex items-center gap-1"><Cpu size={10} /> {hovered.model}</div>}
            <pre className="mt-3 text-[11px] text-dim whitespace-pre-wrap font-mono bg-bg/60 p-3 rounded border border-line/70">{hovered.body.slice(0, 1500)}{hovered.body.length > 1500 ? '\n…' : ''}</pre>
          </div>
        )}
      </aside>
    </div>
  );
}

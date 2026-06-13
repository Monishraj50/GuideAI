'use client';

import { useEffect, useMemo, useState } from 'react';

interface Department { slug: string; label: string; count: number }
interface CatalogResp { fetchedAt: number; count: number; departments: Department[] }
interface AgentSummary { role: string; displayName: string; department: string; description: string; tools: string[]; model?: string }
interface AgentDetail extends AgentSummary { body: string }
interface RosterEntry { id: string; role: string; displayName: string; status: string; toolWhitelist: string[] }

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

  async function hire(role: string) {
    setBusy(role);
    try {
      await fetch(`/api/workspaces/${workspaceId}/agents`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      await loadRoster();
    } finally { setBusy(null); }
  }
  async function retire(id: string) {
    setBusy(id);
    try {
      await fetch(`/api/workspaces/${workspaceId}/agents/${id}`, { method: 'DELETE' });
      await loadRoster();
    } finally { setBusy(null); }
  }
  async function preview(role: string) {
    const r = await fetch(`/api/catalog/agents/${role}`);
    if (r.ok) setHovered(await r.json());
  }

  const hiredRoles = useMemo(() => new Set(roster.map((r) => r.role)), [roster]);

  if (error) return <div className="p-6 text-err text-sm">{error}</div>;
  if (!catalog) return <div className="p-6 text-dim text-sm">loading catalog…</div>;

  return (
    <div className="flex-1 min-h-0 flex">
      <aside className="w-56 border-r border-line p-3 overflow-y-auto">
        <div className="text-ink font-medium text-sm mb-2">Departments</div>
        <button
          onClick={() => setDept(undefined)}
          className={`block w-full text-left px-2 py-1 rounded text-xs ${!dept ? 'bg-line text-ink' : 'text-dim hover:bg-line'}`}
        >
          All <span className="text-dim">({catalog.count})</span>
        </button>
        {catalog.departments.map((d) => (
          <button
            key={d.slug}
            onClick={() => setDept(d.slug)}
            className={`block w-full text-left px-2 py-1 rounded text-xs ${dept === d.slug ? 'bg-line text-ink' : 'text-dim hover:bg-line'}`}
          >
            {d.label} <span className="text-dim">({d.count})</span>
          </button>
        ))}
        <div className="border-t border-line my-3" />
        <div className="text-ink font-medium text-sm mb-2">Your roster ({roster.length})</div>
        {roster.length === 0 && <div className="text-dim text-xs italic">No agents hired yet.</div>}
        {roster.map((r) => (
          <div key={r.id} className="flex items-center justify-between text-xs py-1">
            <span className="text-ink truncate">{r.displayName}</span>
            <button
              onClick={() => retire(r.id)}
              disabled={busy === r.id}
              className="text-err hover:underline disabled:opacity-40 ml-2"
            >
              retire
            </button>
          </div>
        ))}
      </aside>

      <main className="flex-1 min-w-0 flex flex-col">
        <div className="border-b border-line px-4 py-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="search by role / description"
            className="w-full bg-bg border border-line rounded px-2 py-1 text-sm text-ink outline-none focus:border-accent"
          />
        </div>
        <ol className="flex-1 min-h-0 overflow-y-auto divide-y divide-line">
          {agents.map((a) => {
            const isHired = hiredRoles.has(a.role);
            return (
              <li
                key={a.role}
                className="px-4 py-2 hover:bg-line cursor-pointer text-sm"
                onMouseEnter={() => preview(a.role)}
              >
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-ink truncate">{a.displayName}</div>
                    <div className="text-dim text-xs truncate">{a.description}</div>
                  </div>
                  <div className="text-dim text-xs font-mono whitespace-nowrap">{a.tools.length} tools</div>
                  <button
                    disabled={isHired || busy === a.role}
                    onClick={() => hire(a.role)}
                    className={`px-3 py-1 text-xs rounded font-medium whitespace-nowrap ${isHired ? 'bg-line text-dim cursor-default' : 'bg-accent text-bg disabled:opacity-40 hover:brightness-110'}`}
                  >
                    {isHired ? 'hired' : 'hire'}
                  </button>
                </div>
              </li>
            );
          })}
          {agents.length === 0 && (
            <li className="px-4 py-6 text-dim text-sm italic">No agents match.</li>
          )}
        </ol>
      </main>

      <aside className="w-96 border-l border-line p-3 overflow-y-auto hidden xl:block">
        <div className="text-ink font-medium text-sm mb-2">Preview</div>
        {!hovered && <div className="text-dim text-xs italic">Hover an agent to preview its system prompt.</div>}
        {hovered && (
          <div className="text-xs">
            <div className="text-ink font-mono">{hovered.role}</div>
            <div className="text-dim mt-1">{hovered.description}</div>
            <div className="text-dim mt-2">tools: <span className="text-ink">{hovered.tools.join(', ') || '—'}</span></div>
            {hovered.model && <div className="text-dim">model: <span className="text-ink">{hovered.model}</span></div>}
            <pre className="mt-3 text-[11px] text-dim whitespace-pre-wrap font-mono">{hovered.body.slice(0, 1500)}{hovered.body.length > 1500 ? '\n…' : ''}</pre>
          </div>
        )}
      </aside>
    </div>
  );
}

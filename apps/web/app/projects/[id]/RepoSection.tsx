'use client';

import { useEffect, useState } from 'react';
import {
  GitBranch as Github, Link2, Link2Off, GitBranch, UploadCloud, ListChecks, ExternalLink,
  Plus, AlertTriangle, RefreshCw, Lock, Globe, Clock,
} from 'lucide-react';
import { toast } from '../../../components/Toast';
import { cn } from '../../../lib/cn';

interface RepoBinding {
  workspaceId: string;
  owner: string; repo: string;
  provider: string;
  visibility: 'private' | 'public';
  defaultBranch: string;
  htmlUrl: string | null;
  linkedAt: number;
  lastPushedAt: number | null;
  lastSyncAt: number | null;
}

interface IntegrationState {
  ready: boolean;
  ghConnected: boolean;
  patSet: boolean;
  ghCliLoggedInUser?: string;
  defaultOwner?: string;
}

function fmtTs(ms: number | null) {
  if (!ms) return '—';
  const d = Date.now() - ms;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

export function RepoSection({ workspaceId }: { workspaceId: string }) {
  const [repo, setRepo] = useState<RepoBinding | null>(null);
  const [integ, setInteg] = useState<IntegrationState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<'idle' | 'link' | 'create'>('idle');
  const [linkDraft, setLinkDraft] = useState({ owner: '', repo: '', visibility: 'private' as 'private' | 'public', defaultBranch: 'main' });
  const [createDraft, setCreateDraft] = useState({ name: workspaceId, description: '', private: true });
  const [lastPush, setLastPush] = useState<{ pushed: { path: string; bytes: number }[]; errors: { path: string; error: string }[] } | null>(null);
  const [lastSync, setLastSync] = useState<{ created: any[]; updated: any[]; errors: any[] } | null>(null);

  async function refresh() {
    try {
      const [rr, ri] = await Promise.all([
        fetch(`/api/workspaces/${workspaceId}/repo`).then((r) => r.json()),
        fetch('/api/integrations/github').then((r) => r.ok ? r.json() : null).catch(() => null),
      ]);
      setRepo(rr.repo);
      setInteg(ri);
      if (rr.repo && !linkDraft.owner) {
        setLinkDraft((d) => ({ ...d, owner: rr.repo.owner, repo: rr.repo.repo, defaultBranch: rr.repo.defaultBranch }));
      }
    } catch {}
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 8000); return () => clearInterval(t); }, [workspaceId]);

  async function linkExisting() {
    if (!linkDraft.owner.trim() || !linkDraft.repo.trim()) return;
    setBusy('link');
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/repo/link`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(linkDraft),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'link failed');
      setRepo(j.repo); setMode('idle');
      toast({ title: `Linked ${j.repo.owner}/${j.repo.repo}`, variant: 'success' });
    } catch (e: any) { toast({ title: 'Link failed', description: e?.message, variant: 'error' }); }
    finally { setBusy(null); }
  }

  async function createNew() {
    if (!createDraft.name.trim()) return;
    setBusy('create');
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/repo/create`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createDraft),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'create failed');
      setRepo(j.repo); setMode('idle');
      toast({ title: `Created ${j.repo.owner}/${j.repo.repo}`, variant: 'success' });
    } catch (e: any) { toast({ title: 'Create failed', description: e?.message, variant: 'error' }); }
    finally { setBusy(null); }
  }

  async function unlink() {
    if (!confirm('Unlink this repo from the workspace? (The repo itself is not deleted.)')) return;
    setBusy('unlink');
    try {
      await fetch(`/api/workspaces/${workspaceId}/repo`, { method: 'DELETE' });
      setRepo(null);
      toast({ title: 'Repo unlinked', variant: 'warn' });
    } finally { setBusy(null); }
  }

  async function push() {
    setBusy('push');
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/repo/push`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'push failed');
      setLastPush(j);
      await refresh();
      toast({
        title: `Pushed ${j.pushed?.length ?? 0} files`,
        description: j.errors?.length ? `${j.errors.length} errors` : undefined,
        variant: j.errors?.length ? 'warn' : 'success',
      });
    } catch (e: any) { toast({ title: 'Push failed', description: e?.message, variant: 'error' }); }
    finally { setBusy(null); }
  }

  async function syncIssues() {
    setBusy('sync');
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/repo/sync-issues`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'sync failed');
      setLastSync(j);
      await refresh();
      toast({
        title: `Issues: ${j.created.length} created, ${j.updated.length} updated`,
        description: j.errors?.length ? `${j.errors.length} errors` : undefined,
        variant: j.errors?.length ? 'warn' : 'success',
      });
    } catch (e: any) { toast({ title: 'Sync failed', description: e?.message, variant: 'error' }); }
    finally { setBusy(null); }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Github size={14} className={repo ? 'text-accent' : 'text-dim'} />
        <span className="text-ink font-medium text-sm">GitHub</span>
        {!integ?.ready && (
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-warn/40 text-warn bg-warn/10">
            integration not configured
          </span>
        )}
        {repo && (
          <span className="text-[10px] font-mono text-dim2 ml-2">{repo.owner}/{repo.repo}</span>
        )}
        <button onClick={refresh} className="ml-auto text-dim2 hover:text-ink text-xs flex items-center gap-1">
          <RefreshCw size={11} /> refresh
        </button>
      </div>

      {!integ?.ready && (
        <div className="border border-dashed border-line/70 rounded-lg p-3 text-dim2 text-[11px] italic">
          Configure GitHub in Settings (connect gh CLI or save a PAT) before linking a repo.
        </div>
      )}

      {repo ? (
        <div className="border border-accent/30 rounded-lg p-4 bg-surface2/60 shadow-glow space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-ink font-medium text-sm truncate">{repo.owner}/{repo.repo}</span>
                {repo.visibility === 'public' ? (
                  <span className="text-[10px] flex items-center gap-1 text-info"><Globe size={10} /> public</span>
                ) : (
                  <span className="text-[10px] flex items-center gap-1 text-dim"><Lock size={10} /> private</span>
                )}
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-line/70 text-dim2 flex items-center gap-0.5">
                  <GitBranch size={9} /> {repo.defaultBranch}
                </span>
              </div>
              <div className="text-dim2 text-[10px] flex items-center gap-2 flex-wrap">
                <span><Clock size={9} className="inline mr-0.5" /> linked {fmtTs(repo.linkedAt)}</span>
                {repo.lastPushedAt && <span>· pushed {fmtTs(repo.lastPushedAt)}</span>}
                {repo.lastSyncAt && <span>· issues synced {fmtTs(repo.lastSyncAt)}</span>}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {repo.htmlUrl && (
                <a
                  href={repo.htmlUrl}
                  target="_blank" rel="noreferrer"
                  className="text-accent hover:underline text-xs flex items-center gap-1"
                >
                  open <ExternalLink size={11} />
                </a>
              )}
              <button
                onClick={unlink}
                disabled={busy === 'unlink'}
                className="flex items-center gap-1 px-2 py-1 rounded-md border border-line/70 text-dim2 hover:text-err hover:border-err/40 text-xs disabled:opacity-40"
                title="Unlink repo from workspace"
              >
                <Link2Off size={11} /> unlink
              </button>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-2">
            <button
              onClick={push}
              disabled={!integ?.ready || busy === 'push'}
              className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-md bg-accent text-bg text-sm font-medium shadow-glow disabled:opacity-40 hover:brightness-110"
            >
              <UploadCloud size={13} /> {busy === 'push' ? 'pushing…' : 'push deliverables'}
            </button>
            <button
              onClick={syncIssues}
              disabled={!integ?.ready || busy === 'sync'}
              className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-md border border-info/40 text-info text-sm font-medium bg-info/10 hover:bg-info/20 disabled:opacity-40"
            >
              <ListChecks size={13} /> {busy === 'sync' ? 'syncing…' : 'sync WBS → issues'}
            </button>
          </div>

          {lastPush && (
            <div className="border border-line/70 rounded-md p-2.5 bg-bg/30">
              <div className="text-dim2 text-[10px] uppercase tracking-wider mb-1">last push</div>
              <ul className="text-[11px] text-ink2 space-y-0.5 font-mono">
                {lastPush.pushed.map((p) => (
                  <li key={p.path} className="flex items-center gap-1">
                    <UploadCloud size={9} className="text-accent" />
                    {p.path}
                    <span className="text-dim2 ml-auto">{p.bytes}b</span>
                  </li>
                ))}
                {lastPush.errors.map((p) => (
                  <li key={p.path} className="flex items-center gap-1 text-err">
                    <AlertTriangle size={9} />
                    {p.path}: {p.error.slice(0, 80)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {lastSync && (
            <div className="border border-line/70 rounded-md p-2.5 bg-bg/30">
              <div className="text-dim2 text-[10px] uppercase tracking-wider mb-1">last sync</div>
              <div className="grid grid-cols-3 gap-1 text-[11px] font-mono">
                <SyncCol label="created" tint="text-accent" n={lastSync.created.length} />
                <SyncCol label="updated" tint="text-info"   n={lastSync.updated.length} />
                <SyncCol label="errors"  tint="text-err"    n={lastSync.errors.length} />
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {mode === 'idle' && integ?.ready && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setMode('link')}
                className="flex items-center gap-1 px-3 py-1.5 rounded-md border border-line/70 text-ink2 text-xs hover:border-line2 hover:text-ink"
              >
                <Link2 size={11} /> link existing repo
              </button>
              <button
                onClick={() => setMode('create')}
                className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-accent text-bg text-xs font-medium shadow-glow hover:brightness-110"
              >
                <Plus size={11} /> create new repo
              </button>
            </div>
          )}

          {mode === 'link' && (
            <div className="border border-line/70 rounded-lg p-3 bg-surface2/50 space-y-2">
              <div className="text-ink font-medium text-xs">Link existing repo</div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Owner">
                  <input
                    value={linkDraft.owner}
                    onChange={(e) => setLinkDraft({ ...linkDraft, owner: e.target.value })}
                    placeholder={integ?.defaultOwner ?? integ?.ghCliLoggedInUser ?? 'octocat'}
                    className="w-full bg-bg/60 border border-line/70 rounded-md px-2 py-1 text-xs text-ink font-mono outline-none focus:border-accent/60"
                  />
                </Field>
                <Field label="Repo">
                  <input
                    value={linkDraft.repo}
                    onChange={(e) => setLinkDraft({ ...linkDraft, repo: e.target.value })}
                    placeholder="my-project"
                    className="w-full bg-bg/60 border border-line/70 rounded-md px-2 py-1 text-xs text-ink font-mono outline-none focus:border-accent/60"
                  />
                </Field>
                <Field label="Default branch">
                  <input
                    value={linkDraft.defaultBranch}
                    onChange={(e) => setLinkDraft({ ...linkDraft, defaultBranch: e.target.value })}
                    placeholder="main"
                    className="w-full bg-bg/60 border border-line/70 rounded-md px-2 py-1 text-xs text-ink font-mono outline-none focus:border-accent/60"
                  />
                </Field>
                <Field label="Visibility">
                  <select
                    value={linkDraft.visibility}
                    onChange={(e) => setLinkDraft({ ...linkDraft, visibility: e.target.value as 'private' | 'public' })}
                    className="w-full bg-bg/60 border border-line/70 rounded-md px-2 py-1 text-xs text-ink outline-none focus:border-accent/60"
                  >
                    <option value="private">private</option>
                    <option value="public">public</option>
                  </select>
                </Field>
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setMode('idle')} className="text-dim2 hover:text-ink text-xs">cancel</button>
                <button
                  onClick={linkExisting}
                  disabled={busy === 'link' || !linkDraft.owner.trim() || !linkDraft.repo.trim()}
                  className="flex items-center gap-1 px-3 py-1 rounded-md bg-accent text-bg text-xs font-medium shadow-glow disabled:opacity-40"
                >
                  <Link2 size={11} /> link
                </button>
              </div>
            </div>
          )}

          {mode === 'create' && (
            <div className="border border-line/70 rounded-lg p-3 bg-surface2/50 space-y-2">
              <div className="text-ink font-medium text-xs">Create new repo</div>
              <div className="text-dim2 text-[10px]">Under your authed account ({integ?.ghCliLoggedInUser ?? 'PAT user'}).</div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Name">
                  <input
                    value={createDraft.name}
                    onChange={(e) => setCreateDraft({ ...createDraft, name: e.target.value })}
                    placeholder="my-project"
                    className="w-full bg-bg/60 border border-line/70 rounded-md px-2 py-1 text-xs text-ink font-mono outline-none focus:border-accent/60"
                  />
                </Field>
                <Field label="Visibility">
                  <select
                    value={createDraft.private ? 'private' : 'public'}
                    onChange={(e) => setCreateDraft({ ...createDraft, private: e.target.value === 'private' })}
                    className="w-full bg-bg/60 border border-line/70 rounded-md px-2 py-1 text-xs text-ink outline-none focus:border-accent/60"
                  >
                    <option value="private">private</option>
                    <option value="public">public</option>
                  </select>
                </Field>
              </div>
              <Field label="Description (optional)">
                <input
                  value={createDraft.description}
                  onChange={(e) => setCreateDraft({ ...createDraft, description: e.target.value })}
                  placeholder="What does this repo do?"
                  className="w-full bg-bg/60 border border-line/70 rounded-md px-2 py-1 text-xs text-ink outline-none focus:border-accent/60"
                />
              </Field>
              <div className="flex justify-end gap-2">
                <button onClick={() => setMode('idle')} className="text-dim2 hover:text-ink text-xs">cancel</button>
                <button
                  onClick={createNew}
                  disabled={busy === 'create' || !createDraft.name.trim()}
                  className="flex items-center gap-1 px-3 py-1 rounded-md bg-accent text-bg text-xs font-medium shadow-glow disabled:opacity-40"
                >
                  <Plus size={11} /> {busy === 'create' ? 'creating…' : 'create + link'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function SyncCol({ label, tint, n }: { label: string; tint: string; n: number }) {
  return (
    <div className="border border-line/70 rounded p-1.5 bg-bg/30 text-center">
      <div className={cn('text-[9px] uppercase tracking-wider', tint)}>{label}</div>
      <div className="font-mono text-ink mt-0.5">{n}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-dim2 text-[10px] uppercase tracking-wider mb-0.5">{label}</div>
      {children}
    </div>
  );
}

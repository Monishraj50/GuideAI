// Phase 3 — GitHub repo bootstrap.
//
// Per-workspace repo binding + two operations:
//   1) pushDeliverables — write README/EXPLAINER/docs/* from the brief's
//      auto-generated deliverables (Phase 6+7 output).
//   2) syncWorkItemsToIssues — open one issue per WBS item, persist the issue
//      number back so re-runs are idempotent. Closed-on-GitHub → done is left
//      for a future webhook wiring.
//
// Auth: prefers `gh` CLI (so the user's existing `gh auth login` is reused),
// falls back to a per-user PAT stored under ~/.guideai/integrations/github.json
// (chmod 600, same shape as claude.json).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@guideai/shared/db';
import { paths } from '@guideai/shared/paths';
import { appendEvent } from '@guideai/messaging/events';
import type { SystemChunk } from '@guideai/shared/chunks';
import {
  listDeliverables, type Deliverable,
} from './deliverables.js';
import { listWorkItems, updateWorkItem, type WorkItem } from './wbs.js';

// ---------- integration storage (per-workspace, ~/.guideai/integrations/github.json) ----------

const INTEG_FILE = path.join(paths.home, 'integrations', 'github.json');

export interface GitHubWorkspaceConsent {
  ghCliConnectedAt?: number;
  ghCliVersion?: string;
  pat?: string;
  patSavedAt?: number;
  defaultOwner?: string;
}
/** Legacy alias — shape unchanged. */
export type GitHubUserConsent = GitHubWorkspaceConsent;

export interface GitHubIntegration {
  workspaces?: Record<string, GitHubWorkspaceConsent>;
  /** Legacy per-user shape; folded into `workspaces.__default__` on first read. */
  users?: Record<string, GitHubWorkspaceConsent>;
}

function migrateLegacy(integ: GitHubIntegration): GitHubIntegration {
  if (!integ.users || integ.workspaces) return integ;
  const merged: GitHubWorkspaceConsent = {};
  for (const u of Object.values(integ.users)) {
    if (u?.pat && !merged.pat) merged.pat = u.pat;
    if (u?.patSavedAt && (!merged.patSavedAt || u.patSavedAt > merged.patSavedAt)) merged.patSavedAt = u.patSavedAt;
    if (u?.ghCliConnectedAt && (!merged.ghCliConnectedAt || u.ghCliConnectedAt > merged.ghCliConnectedAt)) {
      merged.ghCliConnectedAt = u.ghCliConnectedAt;
      merged.ghCliVersion = u.ghCliVersion;
    }
    if (u?.defaultOwner && !merged.defaultOwner) merged.defaultOwner = u.defaultOwner;
  }
  return { workspaces: { __default__: merged } };
}

export function readIntegration(): GitHubIntegration {
  try {
    if (!fs.existsSync(INTEG_FILE)) return { workspaces: {} };
    const raw = JSON.parse(fs.readFileSync(INTEG_FILE, 'utf8')) as GitHubIntegration;
    return migrateLegacy(raw);
  } catch { return { workspaces: {} }; }
}
export function writeIntegration(s: GitHubIntegration): void {
  fs.mkdirSync(path.dirname(INTEG_FILE), { recursive: true });
  const clean: GitHubIntegration = { workspaces: s.workspaces ?? {} };
  fs.writeFileSync(INTEG_FILE, JSON.stringify(clean, null, 2), { mode: 0o600 });
}
export function workspaceConsent(integ: GitHubIntegration, workspaceId: string): GitHubWorkspaceConsent {
  return integ.workspaces?.[workspaceId] ?? {};
}
export function setWorkspaceConsent(
  integ: GitHubIntegration, workspaceId: string, patch: GitHubWorkspaceConsent | null,
): GitHubIntegration {
  const workspaces = { ...(integ.workspaces ?? {}) };
  if (patch === null) delete workspaces[workspaceId];
  else workspaces[workspaceId] = patch;
  return { ...integ, workspaces };
}
// Back-compat shims so older callers keep compiling during the transition.
export const userConsent = workspaceConsent;
export const setUserConsent = setWorkspaceConsent;

// ---------- gh CLI detection ----------

export interface GhCliStatus {
  detected: boolean;
  version?: string;
  binaryPath?: string;
  authenticated?: boolean;
  loggedInUser?: string;
  authError?: string;
}

export function detectGhCli(): GhCliStatus {
  const bin = process.env.GUIDEAI_GH_BIN ?? 'gh';
  let version: string | undefined;
  let binaryPath: string | undefined;
  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 4000 });
    if (r.status !== 0) return { detected: false };
    version = (r.stdout ?? '').trim().split('\n')[0];
  } catch { return { detected: false }; }
  try {
    const w = spawnSync('which', [bin], { encoding: 'utf8', timeout: 2000 });
    if (w.status === 0) binaryPath = (w.stdout ?? '').trim() || undefined;
  } catch {}
  // `gh auth status` exits 0 only when logged in; stderr/stdout includes "Logged in to … as <user>".
  try {
    const a = spawnSync(bin, ['auth', 'status'], { encoding: 'utf8', timeout: 4000 });
    const text = `${a.stdout ?? ''}\n${a.stderr ?? ''}`;
    if (a.status === 0) {
      const m = text.match(/account\s+([A-Za-z0-9-]+)\b/i)
        ?? text.match(/Logged in to [^\s]+ as ([A-Za-z0-9-]+)/i);
      return { detected: true, version, binaryPath, authenticated: true, loggedInUser: m?.[1] };
    }
    return { detected: true, version, binaryPath, authenticated: false, authError: text.trim().split('\n').slice(0, 2).join(' ') };
  } catch {
    return { detected: true, version, binaryPath, authenticated: false };
  }
}

// ---------- HTTP wrapper ----------

export type GitHubAuthMode = 'gh-cli' | 'pat';

export interface GitHubAuth {
  mode: GitHubAuthMode;
  pat?: string;
}

/** Pick the best auth mode for a given workspace. Throws if none is usable. */
export function resolveAuth(workspaceId: string): GitHubAuth {
  const integ = readIntegration();
  const w = workspaceConsent(integ, workspaceId);
  const cli = detectGhCli();
  // gh-cli wins when authenticated AND this workspace has connected it
  // (consent is per-workspace so different projects can opt in independently).
  if (cli.detected && cli.authenticated && w.ghCliConnectedAt) {
    return { mode: 'gh-cli' };
  }
  if (w.pat) {
    return { mode: 'pat', pat: w.pat };
  }
  // Fall back: if the workspace hasn't explicitly connected the CLI but the CLI
  // is logged in machine-wide, allow it. Lower friction for the common case.
  if (cli.detected && cli.authenticated) {
    return { mode: 'gh-cli' };
  }
  throw new Error(
    `no GitHub auth available — either run \`gh auth login\` or save a PAT in Settings → GitHub`,
  );
}

interface ApiOpts {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: any;
  acceptText?: boolean;
}

/**
 * Single API entrypoint. Routes through `gh api` when CLI is auth'd, else uses
 * fetch with the user's PAT. Both paths return the parsed JSON body (or text
 * when `acceptText`).
 */
export async function ghApi(path: string, auth: GitHubAuth, opts: ApiOpts = {}): Promise<any> {
  const method = opts.method ?? 'GET';
  if (auth.mode === 'gh-cli') {
    return ghCliCall(path, method, opts.body);
  }
  if (!auth.pat) throw new Error('PAT auth selected but no token saved');
  const url = path.startsWith('http') ? path : `https://api.github.com${path.startsWith('/') ? '' : '/'}${path}`;
  const r = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${auth.pat}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'GuideAI',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`github ${method} ${path} → ${r.status}: ${text.slice(0, 240)}`);
  }
  if (opts.acceptText || !text) return text;
  try { return JSON.parse(text); } catch { return text; }
}

function ghCliCall(apiPath: string, method: string, body: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const bin = process.env.GUIDEAI_GH_BIN ?? 'gh';
    const args = ['api', apiPath, '-X', method, '-H', 'Accept: application/vnd.github+json'];
    if (body && typeof body === 'object') {
      // gh api supports `--input -` to read JSON from stdin.
      args.push('--input', '-');
    }
    const proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => reject(new Error(`gh CLI exec failed: ${e.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`gh api ${method} ${apiPath} → exit ${code}: ${err.trim() || out.trim()}`));
      try { resolve(out ? JSON.parse(out) : null); }
      catch { resolve(out); }
    });
    if (body && typeof body === 'object') {
      proc.stdin.write(JSON.stringify(body));
    }
    proc.stdin.end();
  });
}

// ---------- repo binding ----------

export interface WorkspaceRepo {
  workspaceId: string;
  owner: string;
  repo: string;
  provider: string;
  visibility: 'private' | 'public';
  defaultBranch: string;
  htmlUrl: string | null;
  linkedAt: number;
  lastPushedAt: number | null;
  lastSyncAt: number | null;
}

function rowToRepo(row: any): WorkspaceRepo {
  return {
    workspaceId: row.workspaceId, owner: row.owner, repo: row.repo,
    provider: row.provider,
    visibility: row.visibility as 'private' | 'public',
    defaultBranch: row.defaultBranch, htmlUrl: row.htmlUrl,
    linkedAt: row.linkedAt, lastPushedAt: row.lastPushedAt, lastSyncAt: row.lastSyncAt,
  };
}

export function getWorkspaceRepo(workspaceId: string): WorkspaceRepo | null {
  const db = getDb();
  const row = db.select().from(schema.workspaceRepos)
    .where(eq(schema.workspaceRepos.workspaceId, workspaceId)).all()[0];
  return row ? rowToRepo(row) : null;
}

export function linkRepo(args: {
  workspaceId: string; owner: string; repo: string;
  visibility?: 'private' | 'public'; defaultBranch?: string; htmlUrl?: string;
}): WorkspaceRepo {
  const db = getDb();
  const now = Date.now();
  const existing = db.select().from(schema.workspaceRepos)
    .where(eq(schema.workspaceRepos.workspaceId, args.workspaceId)).all()[0];
  const values = {
    workspaceId: args.workspaceId,
    owner: args.owner.trim(),
    repo: args.repo.trim(),
    provider: 'github',
    visibility: args.visibility ?? 'private',
    defaultBranch: args.defaultBranch ?? 'main',
    htmlUrl: args.htmlUrl ?? null,
    linkedAt: existing?.linkedAt ?? now,
  };
  if (existing) {
    db.update(schema.workspaceRepos).set(values as any)
      .where(eq(schema.workspaceRepos.workspaceId, args.workspaceId)).run();
  } else {
    db.insert(schema.workspaceRepos).values(values as any).run();
  }
  appendEvent(args.workspaceId, sys(args.workspaceId,
    `repo linked: ${args.owner}/${args.repo}`));
  return getWorkspaceRepo(args.workspaceId)!;
}

export function unlinkRepo(workspaceId: string): { ok: true } {
  const db = getDb();
  db.delete(schema.workspaceRepos)
    .where(eq(schema.workspaceRepos.workspaceId, workspaceId)).run();
  appendEvent(workspaceId, sys(workspaceId, `repo unlinked`, 'warn'));
  return { ok: true };
}

// ---------- create repo ----------

export async function createRepo(args: {
  workspaceId: string; name: string; description?: string; private?: boolean;
}): Promise<WorkspaceRepo> {
  const auth = resolveAuth(args.workspaceId);
  const body = {
    name: args.name,
    description: args.description ?? `GuideAI workspace: ${args.workspaceId}`,
    private: args.private ?? true,
    auto_init: true,
  };
  // /user/repos creates under the authenticated user. (For an org repo, the
  // user can link an existing repo instead.)
  const resp = await ghApi('/user/repos', auth, { method: 'POST', body });
  if (!resp?.full_name) throw new Error(`unexpected GitHub response: ${JSON.stringify(resp).slice(0, 200)}`);
  const [owner, repo] = (resp.full_name as string).split('/');
  if (!owner || !repo) throw new Error(`malformed full_name: ${resp.full_name}`);
  return linkRepo({
    workspaceId: args.workspaceId, owner, repo,
    visibility: resp.private ? 'private' : 'public',
    defaultBranch: resp.default_branch ?? 'main',
    htmlUrl: resp.html_url ?? null,
  });
}

// ---------- push deliverables ----------

interface FilePut {
  filePath: string;     // path in the repo
  content: string;      // raw text (we'll base64 it)
  message: string;
}

async function getFileSha(auth: GitHubAuth, owner: string, repo: string, branch: string, filePath: string): Promise<string | null> {
  try {
    const r = await ghApi(`/repos/${owner}/${repo}/contents/${encodeURI(filePath)}?ref=${branch}`, auth);
    return typeof r?.sha === 'string' ? r.sha : null;
  } catch (e: any) {
    if (/404/.test(String(e?.message ?? ''))) return null;
    // Re-throw real failures (auth, rate limit, etc.).
    throw e;
  }
}

async function putFile(auth: GitHubAuth, owner: string, repo: string, branch: string, f: FilePut): Promise<void> {
  const sha = await getFileSha(auth, owner, repo, branch, f.filePath);
  const body: any = {
    message: f.message,
    content: Buffer.from(f.content, 'utf8').toString('base64'),
    branch,
  };
  if (sha) body.sha = sha;
  await ghApi(`/repos/${owner}/${repo}/contents/${encodeURI(f.filePath)}`, auth, {
    method: 'PUT', body,
  });
}

export interface PushResult {
  pushed: { path: string; bytes: number }[];
  skipped: { path: string; reason: string }[];
  errors: { path: string; error: string }[];
}

/**
 * Push the brief's deliverables to the linked repo. Layout:
 *   README.md     ← slide deck
 *   EXPLAINER.md  ← explainer
 *   docs/{phase}.md  ← phase artifacts
 *   GUIDEAI.md    ← brief metadata header
 *
 * Idempotent — uses Contents API with sha lookup so re-pushes update in place.
 */
export async function pushDeliverables(args: {
  workspaceId: string; briefId?: string;
}): Promise<PushResult> {
  const repo = getWorkspaceRepo(args.workspaceId);
  if (!repo) throw new Error('workspace is not linked to a repo');
  const auth = resolveAuth(args.workspaceId);

  const all = listDeliverables(args.workspaceId, args.briefId ? { briefId: args.briefId } : undefined);
  const deck      = pickFirst(all, 'slide-deck');
  const explainer = pickFirst(all, 'explainer');
  const artifacts = all.filter((d) => d.kind === 'artifact');

  const files: FilePut[] = [];
  const briefTag = args.briefId ? ` (brief ${args.briefId})` : '';

  if (deck?.body)      files.push({ filePath: 'README.md',    content: deck.body,      message: `docs: refresh deck${briefTag}` });
  if (explainer?.body) files.push({ filePath: 'EXPLAINER.md', content: explainer.body, message: `docs: refresh explainer${briefTag}` });
  for (const a of artifacts) {
    if (!a.body || !a.phase) continue;
    files.push({
      filePath: `docs/${a.phase}.md`,
      content: a.body,
      message: `docs: ${a.phase}${briefTag}`,
    });
  }
  // Always write a small index so the repo isn't empty even with no deck.
  files.push({
    filePath: 'GUIDEAI.md',
    content: indexMarkdown(args.workspaceId, args.briefId, all),
    message: `docs: GuideAI index${briefTag}`,
  });

  const result: PushResult = { pushed: [], skipped: [], errors: [] };
  for (const f of files) {
    try {
      await putFile(auth, repo.owner, repo.repo, repo.defaultBranch, f);
      result.pushed.push({ path: f.filePath, bytes: f.content.length });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      result.errors.push({ path: f.filePath, error: msg });
    }
  }

  // Persist last_pushed_at on success.
  if (result.pushed.length > 0) {
    const db = getDb();
    db.update(schema.workspaceRepos).set({ lastPushedAt: Date.now() } as any)
      .where(eq(schema.workspaceRepos.workspaceId, args.workspaceId)).run();
  }
  appendEvent(args.workspaceId, sys(args.workspaceId,
    `repo push · ${result.pushed.length} pushed · ${result.errors.length} failed`));
  return result;
}

function pickFirst(items: Deliverable[], kind: Deliverable['kind']): Deliverable | undefined {
  // listDeliverables already sorts newest-first.
  return items.find((d) => d.kind === kind);
}

function indexMarkdown(workspaceId: string, briefId: string | undefined, items: Deliverable[]): string {
  const lines: string[] = [];
  lines.push(`# GuideAI workspace · ${workspaceId}`);
  lines.push('');
  if (briefId) lines.push(`_brief: ${briefId}_`); else lines.push('_all briefs_');
  lines.push('');
  lines.push('## Auto-generated docs');
  lines.push('- `README.md` — synthesized slide deck');
  lines.push('- `EXPLAINER.md` — plain-English walkthrough');
  lines.push('- `docs/{research,plan,implement,review,verify}.md` — phase artifacts');
  lines.push('');
  lines.push(`_generated ${new Date().toISOString()} · ${items.length} deliverables_`);
  return lines.join('\n');
}

// ---------- sync issues ----------

export interface IssueSyncResult {
  created: { workItemId: string; number: number; url: string }[];
  updated: { workItemId: string; number: number; status: string }[];
  skipped: { workItemId: string; reason: string }[];
  errors: { workItemId: string; error: string }[];
}

/**
 * Create one GitHub issue per WBS item that doesn't have one. For items that
 * already have an issue number, sync the issue's open/closed state to match
 * the work item's status (close on done/cancelled, reopen otherwise).
 */
export async function syncWorkItemsToIssues(args: {
  workspaceId: string; briefId?: string;
}): Promise<IssueSyncResult> {
  const repo = getWorkspaceRepo(args.workspaceId);
  if (!repo) throw new Error('workspace is not linked to a repo');
  const auth = resolveAuth(args.workspaceId);
  const items = listWorkItems(args.workspaceId, args.briefId ? { briefId: args.briefId } : undefined);

  const out: IssueSyncResult = { created: [], updated: [], skipped: [], errors: [] };

  for (const w of items) {
    try {
      if (w.status === 'cancelled') {
        out.skipped.push({ workItemId: w.id, reason: 'cancelled' });
        continue;
      }
      if ((w as any).githubIssueNumber) {
        const issueNum = (w as any).githubIssueNumber as number;
        const desiredState = (w.status === 'done') ? 'closed' : 'open';
        await ghApi(`/repos/${repo.owner}/${repo.repo}/issues/${issueNum}`, auth, {
          method: 'PATCH', body: { state: desiredState, body: issueBody(w) },
        });
        out.updated.push({ workItemId: w.id, number: issueNum, status: desiredState });
      } else {
        const created = await ghApi(`/repos/${repo.owner}/${repo.repo}/issues`, auth, {
          method: 'POST', body: {
            title: w.title,
            body: issueBody(w),
            labels: labelsFor(w),
          },
        });
        if (!created?.number || !created?.html_url) {
          throw new Error(`unexpected response: ${JSON.stringify(created).slice(0, 200)}`);
        }
        // Persist the issue number/url back on the work item.
        const db = getDb();
        db.update(schema.workItems).set({
          githubIssueNumber: created.number,
          githubIssueUrl: created.html_url,
          updatedAt: Date.now(),
        } as any).where(eq(schema.workItems.id, w.id)).run();

        // If the WBS item is already 'done' on creation, close the issue immediately.
        if (w.status === 'done') {
          await ghApi(`/repos/${repo.owner}/${repo.repo}/issues/${created.number}`, auth, {
            method: 'PATCH', body: { state: 'closed' },
          });
        }
        out.created.push({ workItemId: w.id, number: created.number, url: created.html_url });
      }
    } catch (e: any) {
      out.errors.push({ workItemId: w.id, error: String(e?.message ?? e) });
    }
  }

  const db = getDb();
  db.update(schema.workspaceRepos).set({ lastSyncAt: Date.now() } as any)
    .where(eq(schema.workspaceRepos.workspaceId, args.workspaceId)).run();
  appendEvent(args.workspaceId, sys(args.workspaceId,
    `issues sync · ${out.created.length} created · ${out.updated.length} updated · ${out.errors.length} errors`));
  return out;
}

function issueBody(w: WorkItem): string {
  const lines: string[] = [];
  if (w.description) lines.push(w.description, '');
  lines.push('---');
  lines.push(`- **phase**: ${w.phase ?? '—'}`);
  lines.push(`- **priority**: ${w.priority}`);
  if (w.assignedRole) lines.push(`- **assigned role**: \`${w.assignedRole}\``);
  if (w.briefId)      lines.push(`- **brief**: \`${w.briefId}\``);
  lines.push(`- **GuideAI work item**: \`${w.id}\``);
  lines.push('');
  lines.push('_Synced by GuideAI. Status edits in the dashboard will be re-synced; close-on-GitHub → done is not yet auto-mirrored._');
  return lines.join('\n');
}
function labelsFor(w: WorkItem): string[] {
  const ls: string[] = ['guideai'];
  if (w.phase) ls.push(`phase:${w.phase}`);
  if (w.priority && w.priority !== 'normal') ls.push(`priority:${w.priority}`);
  return ls;
}

// ---------- helpers ----------

function sys(workspaceId: string, text: string, level: SystemChunk['level'] = 'info'): SystemChunk {
  return { id: randomUUID(), ts: Date.now(), workspaceId, kind: 'system', level, text };
}

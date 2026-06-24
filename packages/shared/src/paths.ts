import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GUIDEAI_HOME = process.env.GUIDEAI_HOME ?? path.join(os.homedir(), '.guideai');

// ─── Workspace storage registry ──────────────────────────────────────────
//
// Each workspace has a "storage root" — the directory holding its
// events.jsonl, meta.json, briefs/, agents/, requirements.md, etc.
//
// Default root: `~/.guideai/workspaces/<id>/` (sandbox, no project folder)
// Configured root: `<targetFolder>/.atrune/` (the user's project folder)
//
// The mapping lives in `~/.guideai/registry.json` so it survives restarts
// and so the path helpers stay sync (no DB lookup per file write).

const REGISTRY_FILE = path.join(GUIDEAI_HOME, 'registry.json');
let _registry: Record<string, string> | null = null;

function loadRegistry(): Record<string, string> {
  if (_registry) return _registry;
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      _registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8')) as Record<string, string>;
    }
  } catch {}
  if (!_registry) _registry = {};
  return _registry;
}

function saveRegistry(): void {
  const reg = _registry ?? {};
  fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2), 'utf-8');
}

/** Register / re-register a workspace's storage root. */
export function setWorkspaceRoot(workspaceId: string, root: string): void {
  const reg = loadRegistry();
  reg[workspaceId] = root;
  saveRegistry();
}

/** Read the configured storage root for a workspace. */
export function getWorkspaceRoot(workspaceId: string): string {
  const reg = loadRegistry();
  return reg[workspaceId] ?? path.join(GUIDEAI_HOME, 'workspaces', workspaceId);
}

/**
 * Where the user-readable markdown files live (chat.md, requirements.md,
 * phase artifacts, analyses, agent summaries).
 *
 *   Project workspace (root = <targetFolder>/.atrune):
 *     → <targetFolder>/atrune   (sibling, visible — not hidden, not gitignored by default)
 *
 *   Sandbox workspace (root = ~/.guideai/workspaces/<id>):
 *     → same as the storage root; nothing to split.
 */
export function getWorkspaceMdRoot(workspaceId: string): string {
  const root = getWorkspaceRoot(workspaceId);
  const baseName = path.basename(root);
  if (baseName === '.atrune') {
    return path.join(path.dirname(root), 'atrune');
  }
  return root;
}

/** Drop the registration (only the entry; data stays on disk). */
export function dropWorkspaceRoot(workspaceId: string): void {
  const reg = loadRegistry();
  delete reg[workspaceId];
  saveRegistry();
}

/** Database file path. ONLY resolves to `ATRUNE_DB_PATH` (set by the VS Code
 *  extension after the user has granted folder consent). No global fallback —
 *  if the env var isn't set, all user data is supposed to live in the
 *  consented folder and nowhere else. Accessing `paths.db` without a path
 *  throws so callers can surface a clear error instead of silently writing
 *  to a default location. */
export function getDbPath(): string {
  const override = process.env.ATRUNE_DB_PATH?.trim();
  if (override) return override;
  throw new Error(
    'ATRUNE_DB_PATH is not set. Atrune only writes data into a user-consented ' +
    '<folder>/.atrune/. Click "Allow project storage" in the extension sidebar.',
  );
}

/** Cheap check: is per-project storage configured? Callers use this to bail
 *  out of DB-dependent code paths without throwing. */
export function hasDbPath(): boolean {
  return !!process.env.ATRUNE_DB_PATH?.trim();
}

export const paths = {
  home: GUIDEAI_HOME,
  get db() { return getDbPath(); },
  workspaces: path.join(GUIDEAI_HOME, 'workspaces'),
  skills: path.join(GUIDEAI_HOME, 'skills'),
  agentsCustom: path.join(GUIDEAI_HOME, 'agents', 'custom'),
  policiesJson: path.join(GUIDEAI_HOME, 'policies.json'),

  /** Resolved storage directory for a workspace (system state — db, events,
   *  meta, registry). Hidden directory in project repos (`.atrune/`). */
  workspaceDir(id: string) {
    return getWorkspaceRoot(id);
  },
  /** Resolved markdown / user-readable docs directory. Visible (not hidden)
   *  in project repos so users can browse and git-track them. */
  workspaceMdDir(id: string) {
    return getWorkspaceMdRoot(id);
  },
  agentDir(workspaceId: string, agentId: string) {
    return path.join(this.workspaceDir(workspaceId), 'agents', agentId);
  },
  agentInbox(workspaceId: string, agentId: string) {
    return path.join(this.agentDir(workspaceId, agentId), 'inbox.jsonl');
  },
  agentTranscript(workspaceId: string, agentId: string) {
    return path.join(this.agentDir(workspaceId, agentId), 'transcript.jsonl');
  },
  agentCwd(workspaceId: string, agentId: string) {
    return path.join(this.agentDir(workspaceId, agentId), 'cwd');
  },
  workspaceEvents(workspaceId: string) {
    return path.join(this.workspaceDir(workspaceId), 'events.jsonl');
  },
};

// Per-folder consent: gate for writing Atrune project data (.atrune/db.sqlite,
// events.jsonl, agents/, briefs/, transcripts, etc.) into the user's repo.
//
// The consent marker is INSIDE `.atrune/.consent.json` — the same folder it
// gates. This makes the contract obvious: rm -rf .atrune/ wipes both the
// project data AND the consent record, so the next extension activation
// reprompts the user from a clean slate.
//
// We deliberately do NOT mirror the consent into globalState. The .atrune/
// directory is the single source of truth.

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CONSENT_FILENAME = '.consent.json';
const SUBSCRIPTION_FILENAME = '.subscription-authorized.json';

// Legacy global pointer location. We DO NOT write to it anymore — each
// VS Code window must resolve scope purely from its own open folder, so
// that deleting `<repo>/.atrune` actually clears that repo's logs and
// nothing leaks across repos. We still read this on activation only to
// delete it (one-time cleanup).
const LEGACY_ACTIVE_FOLDER_FILE = path.join(
  process.env.GUIDEAI_HOME ?? path.join(os.homedir(), '.guideai'),
  'active-folder.json',
);

/** Delete the legacy global pointer if present. Called on activation so
 *  upgrading from a previous build flushes stale leak vectors. */
export function deleteLegacyActiveFolderPointer(): { removed: boolean } {
  try {
    if (fs.existsSync(LEGACY_ACTIVE_FOLDER_FILE)) {
      fs.rmSync(LEGACY_ACTIVE_FOLDER_FILE, { force: true });
      return { removed: true };
    }
  } catch {}
  return { removed: false };
}

/** Defensive normalization: if a caller hands us "/path/to/foo/.atrune"
 *  by mistake (e.g. the user picked .atrune itself in the open dialog),
 *  strip that suffix so we store the project folder, not the storage dir. */
function normalizeFolder(folder: string): string {
  const resolved = path.resolve(folder);
  if (path.basename(resolved) === '.atrune') return path.dirname(resolved);
  return resolved;
}

/** The folder we should treat as the active consented project.
 *  Strictly per-window: only the currently-open VS Code folder counts.
 *  If it has no `.atrune/.consent.json`, return null — never fall back
 *  to any other repo's data. Deleting `.atrune/` in the open repo
 *  cleanly clears the sidebar without leakage. */
export function getActiveConsentedFolder(): string | null {
  const open = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  if (!open) return null;
  const normalized = normalizeFolder(open);
  return hasConsent(normalized) ? normalized : null;
}

/** Back-compat shim — older callers expected this. Now a no-op since we
 *  don't persist any global pointer. */
export function clearActiveFolder(): void { /* no-op */ }

/**
 * Wipe every byte on the machine that could surface stale content for a
 * folder whose `.atrune/` no longer exists. Two invocation modes:
 *
 *   - `reapOrphanedClaudeSessions()` (no arg) — the activation path. Uses
 *     the currently-open VS Code folder; no-ops if `.atrune/` still exists.
 *   - `reapOrphanedClaudeSessions({ folder })` — mid-session path. Runs
 *     unconditionally against the given folder (caller has already decided
 *     `.atrune/` is gone). Used from `checkConsentAndSetContext` when
 *     consent transitions true → false, so `rm -rf .atrune/` on a live
 *     project immediately clears panels + global-home leftovers.
 */
export function reapOrphanedClaudeSessions(opts?: { folder?: string }): { reaped: number; folder: string | null } {
  const explicit = opts?.folder;
  const folder = explicit ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  if (!folder) return { reaped: 0, folder: null };
  // Only guard on `.atrune` existing when the CALLER didn't tell us to reap.
  // Explicit callers already checked; activation callers rely on this guard.
  if (!explicit && fs.existsSync(path.join(folder, '.atrune'))) return { reaped: 0, folder };

  // .atrune is gone — wipe every byte that could leak back into the UI.
  let reaped = 0;

  // 1. Claude session jsonls tied to this folder (the file dirs encode the
  //    cwd; subagent runs land under '<enc>--atrune-agents-…-cwd/').
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  const enc = path.resolve(folder).replace(/[/\\]/g, '-');
  if (fs.existsSync(projectsRoot)) {
    for (const child of fs.readdirSync(projectsRoot)) {
      if (child === enc || child.startsWith(enc + '--atrune-agents-')) {
        try { fs.rmSync(path.join(projectsRoot, child), { recursive: true, force: true }); reaped++; } catch {}
      }
    }
  }

  // 2. Global workspace registry entries whose meta.json.targetFolder
  //    matches this folder. ~/.guideai/workspaces/<id>/meta.json is the
  //    only pointer back from the global registry → the project folder,
  //    so this removes anything that could surface the deleted repo's
  //    workspace in another VS Code window.
  const guideaiHome = process.env.GUIDEAI_HOME ?? path.join(os.homedir(), '.guideai');
  const wsRoot = path.join(guideaiHome, 'workspaces');
  if (fs.existsSync(wsRoot)) {
    for (const child of fs.readdirSync(wsRoot)) {
      const metaFile = path.join(wsRoot, child, 'meta.json');
      try {
        if (!fs.existsSync(metaFile)) continue;
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
        if (typeof meta?.targetFolder === 'string' && path.resolve(meta.targetFolder) === path.resolve(folder)) {
          fs.rmSync(path.join(wsRoot, child), { recursive: true, force: true });
          reaped++;
        }
      } catch {}
    }
  }

  return { reaped, folder };
}

export interface ConsentRecord {
  /** Absolute folder path that was consented to (matches the .atrune parent). */
  folder: string;
  /** When the user clicked Allow. */
  grantedAt: number;
  /** UI version that wrote this — for forward-compat. */
  schemaVersion: 1;
}

function consentFile(folder: string): string {
  return path.join(folder, '.atrune', CONSENT_FILENAME);
}
function subscriptionFile(folder: string): string {
  return path.join(folder, '.atrune', SUBSCRIPTION_FILENAME);
}

/** True if this folder has the per-folder "subscription authorized" marker.
 *  Independent of folder consent — user can authorize subscription without
 *  yet granting storage, or vice versa. Both files live INSIDE .atrune/, so
 *  deleting that folder wipes both signals (true reset to initial). */
export function hasSubscriptionAuthorized(folder: string): boolean {
  try {
    return fs.existsSync(subscriptionFile(folder));
  } catch {
    return false;
  }
}

/** Record per-folder subscription authorization. Creates .atrune/ if missing
 *  — this is one of the two acts that establishes the folder's state. */
export function grantSubscriptionAuthorization(folder: string): void {
  const dir = path.join(folder, '.atrune');
  fs.mkdirSync(dir, { recursive: true });
  const rec = {
    folder: path.resolve(folder),
    grantedAt: Date.now(),
    schemaVersion: 1 as const,
  };
  fs.writeFileSync(subscriptionFile(folder), JSON.stringify(rec, null, 2), 'utf-8');
}

/** Remove just the subscription marker. Folder consent (and the rest of
 *  .atrune/) stays in place. Used by the modal's Disconnect handlers. */
export function revokeSubscriptionAuthorization(folder: string): void {
  try { fs.rmSync(subscriptionFile(folder), { force: true }); } catch {}
}

/** True if this folder has a written consent marker on disk. */
export function hasConsent(folder: string): boolean {
  try {
    return fs.existsSync(consentFile(folder));
  } catch {
    return false;
  }
}

/** Read the consent record. Returns null when no consent is on disk. */
export function readConsent(folder: string): ConsentRecord | null {
  try {
    const file = consentFile(folder);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (raw && typeof raw.folder === 'string' && typeof raw.grantedAt === 'number') {
      return raw as ConsentRecord;
    }
    return null;
  } catch {
    return null;
  }
}

/** Write the consent marker. Creates the .atrune/ directory if missing — the
 *  act of granting consent IS the act of creating the project storage root. */
export function grantConsent(folder: string): ConsentRecord {
  const dir = path.join(folder, '.atrune');
  fs.mkdirSync(dir, { recursive: true });
  const rec: ConsentRecord = {
    folder: path.resolve(folder),
    grantedAt: Date.now(),
    schemaVersion: 1,
  };
  fs.writeFileSync(consentFile(folder), JSON.stringify(rec, null, 2), 'utf-8');
  // No global pointer to update anymore — server reads scope per-window
  // from the open folder's `.atrune/.consent.json`. Keeps deletes clean.
  return rec;
}

/** Remove the entire .atrune/ folder — wipes DB, events, transcripts, consent.
 *  This is the "reset to initial state" path: the user can either click a
 *  command (atrune.revokeFolderConsent) or rm -rf .atrune/ themselves.
 *  Equivalent net result. */
export function revokeAndWipe(folder: string): {
  removed: boolean; path: string; claudeSessionsRemoved: number;
} {
  const dir = path.join(folder, '.atrune');
  let claudeSessionsRemoved = 0;
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      clearActiveFolder();
      // Also wipe every Claude session jsonl tied to this folder. They live
      // under ~/.claude/projects/<encoded-cwd>/ — the cwd is the user's
      // folder path with '/' replaced by '-'. Subagent runs land under
      // <encoded-cwd>--atrune-agents-…-cwd/ so we match a prefix.
      const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
      const enc = path.resolve(folder).replace(/[/\\]/g, '-');
      if (fs.existsSync(projectsRoot)) {
        for (const child of fs.readdirSync(projectsRoot)) {
          if (child === enc || child.startsWith(enc + '--atrune-agents-')) {
            try {
              fs.rmSync(path.join(projectsRoot, child), { recursive: true, force: true });
              claudeSessionsRemoved++;
            } catch {}
          }
        }
      }
      // Also drop the global workspace registry entries pointing at this
      // folder — otherwise a future VS Code window could re-surface them.
      const guideaiHome = process.env.GUIDEAI_HOME ?? path.join(os.homedir(), '.guideai');
      const wsRoot = path.join(guideaiHome, 'workspaces');
      if (fs.existsSync(wsRoot)) {
        for (const child of fs.readdirSync(wsRoot)) {
          const metaFile = path.join(wsRoot, child, 'meta.json');
          try {
            if (!fs.existsSync(metaFile)) continue;
            const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
            if (typeof meta?.targetFolder === 'string' && path.resolve(meta.targetFolder) === path.resolve(folder)) {
              fs.rmSync(path.join(wsRoot, child), { recursive: true, force: true });
            }
          } catch {}
        }
      }
      return { removed: true, path: dir, claudeSessionsRemoved };
    }
  } catch (e) {
    // Best-effort; report what we tried.
  }
  return { removed: false, path: dir, claudeSessionsRemoved };
}

/** Prompt the user for consent on the currently-open folder. Called from
 *  first-launch (after subscription connect) AND from the consent command.
 *
 *  Returns the consented folder path on success, null if the user declined
 *  or no folder is open. */
export async function promptForConsent(): Promise<string | null> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const initialFolder = folders[0]?.uri.fsPath ?? null;

  // Build the prompt text — show the actual path so the user knows what
  // they're consenting to.
  const promptForFolder = async (folder: string): Promise<'allow' | 'pick' | 'sandbox' | 'cancel'> => {
    const choice = await vscode.window.showInformationMessage(
      `Allow Atrune to store this project's history, logs, and configs?\n\n` +
      `Data location: ${folder}/.atrune/\n\n` +
      `Everything stays inside this folder. Deleting the .atrune/ folder ` +
      `at any time wipes all project data and resets Atrune to initial state.`,
      { modal: true },
      'Allow this folder',
      'Pick a different folder…',
      'Use sandbox (global storage)',
    );
    if (choice === 'Allow this folder') return 'allow';
    if (choice === 'Pick a different folder…') return 'pick';
    if (choice === 'Use sandbox (global storage)') return 'sandbox';
    return 'cancel';
  };

  // If no folder is open at all, offer just sandbox or pick.
  if (!initialFolder) {
    const choice = await vscode.window.showInformationMessage(
      `No folder open. Atrune needs a folder to store project data, or you ` +
      `can use the global sandbox.`,
      { modal: true },
      'Pick a folder…',
      'Use sandbox (global storage)',
    );
    if (choice === 'Pick a folder…') {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: 'Use this folder',
      });
      if (picked && picked[0]) {
        const p = picked[0].fsPath;
        grantConsent(p);
        return p;
      }
    }
    return null;
  }

  // Folder is open; ask permission.
  const choice = await promptForFolder(initialFolder);
  if (choice === 'allow') {
    grantConsent(initialFolder);
    return initialFolder;
  }
  if (choice === 'pick') {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
      openLabel: 'Use this folder',
      defaultUri: vscode.Uri.file(initialFolder),
    });
    if (picked && picked[0]) {
      const p = picked[0].fsPath;
      grantConsent(p);
      return p;
    }
  }
  // sandbox or cancel → no consented folder; server falls back to ~/.guideai
  return null;
}

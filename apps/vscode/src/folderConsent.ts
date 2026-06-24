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
import * as path from 'node:path';

const CONSENT_FILENAME = '.consent.json';
const SUBSCRIPTION_FILENAME = '.subscription-authorized.json';

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
  return rec;
}

/** Remove the entire .atrune/ folder — wipes DB, events, transcripts, consent.
 *  This is the "reset to initial state" path: the user can either click a
 *  command (atrune.revokeFolderConsent) or rm -rf .atrune/ themselves.
 *  Equivalent net result. */
export function revokeAndWipe(folder: string): { removed: boolean; path: string } {
  const dir = path.join(folder, '.atrune');
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      return { removed: true, path: dir };
    }
  } catch (e) {
    // Best-effort; report what we tried.
  }
  return { removed: false, path: dir };
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

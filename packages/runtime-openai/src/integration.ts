// Per-workspace OpenAI credentials. After the Phase 0 auth strip, integration
// files are keyed by workspaceId instead of username — different projects can
// use different keys. File still under ~/.guideai/integrations/openai.json,
// still chmod 600.

import fs from 'node:fs';
import path from 'node:path';
import { paths } from '@guideai/shared/paths';

const INTEG_FILE = path.join(paths.home, 'integrations', 'openai.json');

export interface OpenAIWorkspaceConsent {
  apiKey?: string;
  apiKeySavedAt?: number;
  /** Per-tier OpenAI model overrides. Falls back to DEFAULT_MODEL_FOR_TIER. */
  modelOverrides?: { haiku?: string; sonnet?: string; opus?: string };
}
/** Legacy alias kept for now — equivalent shape. */
export type OpenAIUserConsent = OpenAIWorkspaceConsent;

export interface OpenAIIntegration {
  /** Zero-config global default. Inherited by workspaces without overrides. */
  global?: OpenAIWorkspaceConsent;
  workspaces?: Record<string, OpenAIWorkspaceConsent>;
  /** Legacy per-user shape; migrated into `global` on first read. */
  users?: Record<string, OpenAIWorkspaceConsent>;
}

/** One-shot migration: fold legacy `users[*]` blocks into `global` so nothing
 *  is lost. The first non-legacy username's data wins if there are multiple. */
function migrateLegacy(integ: OpenAIIntegration): OpenAIIntegration {
  if (integ.global || integ.workspaces) return integ;
  if (!integ.users) return { workspaces: {} };
  const merged: OpenAIWorkspaceConsent = {};
  for (const u of Object.values(integ.users)) {
    if (u?.apiKey && !merged.apiKey) merged.apiKey = u.apiKey;
    if (u?.apiKeySavedAt && (!merged.apiKeySavedAt || u.apiKeySavedAt > merged.apiKeySavedAt)) {
      merged.apiKeySavedAt = u.apiKeySavedAt;
    }
    if (u?.modelOverrides && !merged.modelOverrides) merged.modelOverrides = u.modelOverrides;
  }
  return { global: merged, workspaces: {} };
}

export function readIntegration(): OpenAIIntegration {
  try {
    if (!fs.existsSync(INTEG_FILE)) return { workspaces: {} };
    const raw = JSON.parse(fs.readFileSync(INTEG_FILE, 'utf8')) as OpenAIIntegration;
    return migrateLegacy(raw);
  } catch { return { workspaces: {} }; }
}

export function writeIntegration(s: OpenAIIntegration): void {
  fs.mkdirSync(path.dirname(INTEG_FILE), { recursive: true });
  // Strip legacy `users` on write so the file is clean post-migration.
  const clean: OpenAIIntegration = { global: s.global, workspaces: s.workspaces ?? {} };
  fs.writeFileSync(INTEG_FILE, JSON.stringify(clean, null, 2), { mode: 0o600 });
}

/** Workspace-specific consent → global default → empty. */
export function workspaceConsent(integ: OpenAIIntegration, workspaceId: string): OpenAIWorkspaceConsent {
  return integ.workspaces?.[workspaceId] ?? integ.global ?? {};
}

export function setWorkspaceConsent(
  integ: OpenAIIntegration, workspaceId: string, patch: OpenAIWorkspaceConsent | null,
): OpenAIIntegration {
  const workspaces = { ...(integ.workspaces ?? {}) };
  if (patch === null) delete workspaces[workspaceId];
  else workspaces[workspaceId] = patch;
  return { ...integ, workspaces };
}

export function globalConsent(integ: OpenAIIntegration): OpenAIWorkspaceConsent {
  return integ.global ?? {};
}

export function setGlobalConsent(
  integ: OpenAIIntegration, patch: OpenAIWorkspaceConsent | null,
): OpenAIIntegration {
  return { ...integ, global: patch === null ? undefined : patch };
}

// Back-compat shims so older callers (still importing `userConsent`/`setUserConsent`)
// keep working during the transition. They just forward to the workspace versions.
export const userConsent = workspaceConsent;
export const setUserConsent = setWorkspaceConsent;

/** Default OpenAI model per Claude tier. Routed when the workspace hasn't set
 *  overrides. Picks GPT-5 family per current knowledge cutoff. */
export const DEFAULT_MODEL_FOR_TIER: Record<'haiku' | 'sonnet' | 'opus', string> = {
  haiku:  'gpt-5-mini',
  sonnet: 'gpt-5',
  opus:   'gpt-5',
};

export function resolveOpenAIModel(tier: string, overrides?: OpenAIWorkspaceConsent['modelOverrides']): string {
  const t = (['haiku', 'sonnet', 'opus'].includes(tier) ? tier : 'sonnet') as 'haiku' | 'sonnet' | 'opus';
  return overrides?.[t] || DEFAULT_MODEL_FOR_TIER[t];
}

export function getApiKey(workspaceId: string | null | undefined): string | null {
  if (!workspaceId) return null;
  const w = workspaceConsent(readIntegration(), workspaceId);
  return w.apiKey || null;
}
/** Legacy alias kept for older callers. */
export const getCurrentApiKey = getApiKey;

// Per-user OpenAI credentials. Same shape as the GitHub / Claude integration
// pattern: chmod 600 JSON file under ~/.guideai/integrations/, keyed by username.

import fs from 'node:fs';
import path from 'node:path';
import { paths } from '@guideai/shared/paths';

const INTEG_FILE = path.join(paths.home, 'integrations', 'openai.json');

export interface OpenAIUserConsent {
  apiKey?: string;
  apiKeySavedAt?: number;
  /** Per-tier OpenAI model overrides. Falls back to DEFAULT_MODEL_FOR_TIER. */
  modelOverrides?: { haiku?: string; sonnet?: string; opus?: string };
}
export interface OpenAIIntegration { users?: Record<string, OpenAIUserConsent> }

export function readIntegration(): OpenAIIntegration {
  try {
    if (!fs.existsSync(INTEG_FILE)) return {};
    return JSON.parse(fs.readFileSync(INTEG_FILE, 'utf8')) as OpenAIIntegration;
  } catch { return {}; }
}
export function writeIntegration(s: OpenAIIntegration): void {
  fs.mkdirSync(path.dirname(INTEG_FILE), { recursive: true });
  fs.writeFileSync(INTEG_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}
export function userConsent(integ: OpenAIIntegration, username: string): OpenAIUserConsent {
  return integ.users?.[username] ?? {};
}
export function setUserConsent(integ: OpenAIIntegration, username: string, patch: OpenAIUserConsent | null): OpenAIIntegration {
  const users = { ...(integ.users ?? {}) };
  if (patch === null) delete users[username];
  else users[username] = patch;
  return { ...integ, users };
}

/** Default OpenAI model per Claude tier. Routed when the user hasn't set
 *  overrides. Picks GPT-5 family per current knowledge cutoff. */
export const DEFAULT_MODEL_FOR_TIER: Record<'haiku' | 'sonnet' | 'opus', string> = {
  haiku:  'gpt-5-mini',
  sonnet: 'gpt-5',
  opus:   'gpt-5',
};

export function resolveOpenAIModel(tier: string, overrides?: OpenAIUserConsent['modelOverrides']): string {
  const t = (['haiku', 'sonnet', 'opus'].includes(tier) ? tier : 'sonnet') as 'haiku' | 'sonnet' | 'opus';
  return overrides?.[t] || DEFAULT_MODEL_FOR_TIER[t];
}

export function getCurrentApiKey(username: string | null | undefined): string | null {
  if (!username) return null;
  const u = userConsent(readIntegration(), username);
  return u.apiKey || null;
}

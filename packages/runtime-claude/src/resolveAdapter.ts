import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { RuntimeAdapter } from '@guideai/runtime-core';
import { ClaudeAdapter } from './adapter.js';
import { MockAdapter } from './mockAdapter.js';
import { DisconnectedAdapter } from './disconnectedAdapter.js';

function home() { return process.env.GUIDEAI_HOME ?? path.join(os.homedir(), '.guideai'); }
function readJson<T>(file: string): T | null {
  try { if (!fs.existsSync(file)) return null; return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
  catch { return null; }
}

/**
 * Adapter resolution:
 *   guest session                                       → MockAdapter
 *   any Claude credential (global CLI or API key)       → ClaudeAdapter
 *   else                                                → DisconnectedAdapter
 *
 * Auth was stripped (single-user, local-first) — credentials now live under
 * `global` and (legacy) `users[*]` / top-level fields. We accept any of them.
 */
export function resolveActiveAdapter(): RuntimeAdapter {
  const session = readJson<{ isGuest?: boolean }>(path.join(home(), 'session.json'));
  if (session?.isGuest === true) return MockAdapter;

  const integ = readJson<{
    global?: { cliConnectedAt?: number; apiKey?: string };
    workspaces?: Record<string, { cliConnectedAt?: number; apiKey?: string }>;
    // legacy shapes
    users?: Record<string, { cliConnectedAt?: number; apiKey?: string }>;
    cliConnectedAt?: number;
    apiKey?: string;
  }>(path.join(home(), 'integrations', 'claude.json'));

  if (!integ) return DisconnectedAdapter;

  const ready =
    !!(integ.global?.cliConnectedAt || integ.global?.apiKey) ||
    !!(integ.cliConnectedAt || integ.apiKey) ||
    Object.values(integ.workspaces ?? {}).some((w) => !!(w?.cliConnectedAt || w?.apiKey)) ||
    Object.values(integ.users ?? {}).some((u) => !!(u?.cliConnectedAt || u?.apiKey));

  return ready ? ClaudeAdapter : DisconnectedAdapter;
}

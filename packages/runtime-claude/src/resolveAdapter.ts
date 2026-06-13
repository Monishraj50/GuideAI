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
 *   integration ready for the SIGNED-IN USER            → ClaudeAdapter
 *   else                                                → DisconnectedAdapter
 *
 * Consent is per-user: User A's "Connect" only enables User A's briefs.
 */
export function resolveActiveAdapter(): RuntimeAdapter {
  const session = readJson<{ isGuest?: boolean; username?: string }>(path.join(home(), 'session.json'));
  if (session?.isGuest === true) return MockAdapter;
  const username = session?.username;
  if (!username) return DisconnectedAdapter;

  const integ = readJson<{ users?: Record<string, { cliConnectedAt?: number; apiKey?: string }> }>(
    path.join(home(), 'integrations', 'claude.json'),
  );
  const u = integ?.users?.[username];
  const ready = !!(u?.cliConnectedAt || u?.apiKey);
  if (!ready) return DisconnectedAdapter;
  return ClaudeAdapter;
}

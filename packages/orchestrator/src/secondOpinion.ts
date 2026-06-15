// Phase 9 — Cross-vendor second opinion.
//
// During the security-tagged review phase, mix one OpenAI attempt into the
// pass@k pool so the verdict reflects agreement across model families, not
// just within Claude. Off by default; per-user OpenAI key + per-workspace
// toggle both required.

import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { RuntimeAdapter } from '@guideai/runtime-core';
import { getDb, schema } from '@guideai/shared/db';
import { paths } from '@guideai/shared/paths';
import {
  makeOpenAIAdapter, MockOpenAIAdapter,
  readIntegration, userConsent,
} from '@guideai/runtime-openai';

const SESSION_FILE = path.join(paths.home, 'session.json');

function currentSessionUsername(): string | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const j = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    return typeof j?.username === 'string' ? j.username : null;
  } catch { return null; }
}

export interface CrossVendorContext {
  /** Adapter to use when an attempt index is in `crossVendorIdx`. */
  adapter: RuntimeAdapter;
  /** Indices (within pass@k) that should hit OpenAI instead of Claude. */
  crossVendorIdx: Set<number>;
  /** Whether the adapter is the no-key mock (vs a real OpenAI call). */
  mock: boolean;
  /** For the artifact / event feed: explains the routing decision. */
  reason: string;
}

/**
 * Decide whether the current pass@k review run should mix in an OpenAI attempt.
 * Returns null when cross-vendor isn't enabled or isn't usable.
 *
 * Routing: reserve the LAST attempt index for OpenAI. With k=3 the layout is
 * [claude, claude, openai] — 2/3 Claude (self-consistency) + 1/3 OpenAI
 * (cross-vendor sanity check).
 */
export function setupCrossVendor(args: {
  workspaceId: string;
  k: number;
  isSecurityReview: boolean;
}): CrossVendorContext | null {
  if (!args.isSecurityReview) return null;
  if (args.k < 2) return null;

  const db = getDb();
  const ws = db.select().from(schema.workspaces)
    .where(eq(schema.workspaces.id, args.workspaceId)).all()[0];
  if (!ws || !(ws as any).secondOpinionEnabled) return null;

  const username = currentSessionUsername();
  if (!username) return null;
  const integ = readIntegration();
  const u = userConsent(integ, username);
  const idx = new Set<number>([args.k - 1]);

  if (u.apiKey) {
    const adapter = makeOpenAIAdapter({
      apiKey: () => u.apiKey ?? null,
      overrides: () => u.modelOverrides,
    });
    return {
      adapter, crossVendorIdx: idx, mock: false,
      reason: `attempt #${args.k} routed to OpenAI (cross-vendor)`,
    };
  }

  // No real key — use the deterministic mock so the codepath stays exercised
  // in guest mode + dev environments. Only kicks in for explicitly-enabled
  // workspaces, so this isn't surprising silent behaviour.
  return {
    adapter: MockOpenAIAdapter, crossVendorIdx: idx, mock: true,
    reason: `attempt #${args.k} routed to OpenAI MOCK (no API key on file)`,
  };
}

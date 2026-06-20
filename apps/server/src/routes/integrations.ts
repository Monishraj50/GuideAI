import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { paths } from '@guideai/shared/paths';

// Per-workspace Claude integration. After the Phase 0 auth strip, this file
// is keyed by workspaceId instead of username. Legacy `users[*]` blocks fold
// into `workspaces.__default__` on first read; new writes drop the legacy key.

interface WorkspaceConsent {
  /** When this workspace first granted CLI consent. */
  cliConnectedAt?: number;
  /** CLI version at consent time, for the UI history line. */
  cliConnectedVersion?: string;
  /** This workspace's stored Anthropic API key. */
  apiKey?: string;
  apiKeySavedAt?: number;
}

interface ClaudeIntegration {
  workspaces?: Record<string, WorkspaceConsent>;
  /** Legacy per-user shape. Migrated on first read. */
  users?: Record<string, WorkspaceConsent>;
  /** Older legacy single-user shape (cliConnected/apiKey at top level). */
  cliConnected?: boolean;
  cliConnectedAt?: number;
  apiKey?: string;
  apiKeySavedAt?: number;
}

const FILE = path.join(paths.home, 'integrations', 'claude.json');

function migrateLegacy(j: any): ClaudeIntegration {
  if (!j || typeof j !== 'object') return { workspaces: {} };
  if (j.workspaces) return j as ClaudeIntegration;

  // Old shape #1: keyed by username under `users[*]`. Fold into __default__.
  if (j.users) {
    const merged: WorkspaceConsent = {};
    for (const u of Object.values(j.users as Record<string, WorkspaceConsent>)) {
      if (u?.apiKey && !merged.apiKey) merged.apiKey = u.apiKey;
      if (u?.apiKeySavedAt && (!merged.apiKeySavedAt || u.apiKeySavedAt > merged.apiKeySavedAt)) {
        merged.apiKeySavedAt = u.apiKeySavedAt;
      }
      if (u?.cliConnectedAt && (!merged.cliConnectedAt || u.cliConnectedAt > merged.cliConnectedAt)) {
        merged.cliConnectedAt = u.cliConnectedAt;
        merged.cliConnectedVersion = u.cliConnectedVersion;
      }
    }
    return { workspaces: { __default__: merged } };
  }

  // Old shape #2: single top-level user. Fold into __default__.
  if (j.cliConnected !== undefined || j.apiKey !== undefined) {
    return {
      workspaces: {
        __default__: {
          cliConnectedAt: j.cliConnected ? (j.cliConnectedAt ?? Date.now()) : undefined,
          apiKey: j.apiKey,
          apiKeySavedAt: j.apiKeySavedAt,
        },
      },
    };
  }

  return { workspaces: {} };
}

function readFileSafe(): ClaudeIntegration {
  try {
    if (!fs.existsSync(FILE)) return { workspaces: {} };
    return migrateLegacy(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch { return { workspaces: {} }; }
}
function writeFileSafe(s: ClaudeIntegration) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  // Strip legacy keys on write — file becomes clean post-migration.
  const clean: ClaudeIntegration = { workspaces: s.workspaces ?? {} };
  fs.writeFileSync(FILE, JSON.stringify(clean, null, 2), { mode: 0o600 });
}

function consentOf(integ: ClaudeIntegration, workspaceId: string): WorkspaceConsent {
  return integ.workspaces?.[workspaceId] ?? {};
}
function setConsent(integ: ClaudeIntegration, workspaceId: string, patch: WorkspaceConsent | null): ClaudeIntegration {
  const workspaces = { ...(integ.workspaces ?? {}) };
  if (patch === null) delete workspaces[workspaceId];
  else workspaces[workspaceId] = patch;
  return { ...integ, workspaces };
}

function detectCli(): { detected: boolean; version?: string; binaryPath?: string } {
  try {
    const bin = process.env.GUIDEAI_CLAUDE_BIN ?? 'claude';
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0) {
      let abs: string | undefined;
      try {
        const w = spawnSync('which', [bin], { encoding: 'utf8', timeout: 2000 });
        if (w.status === 0) abs = (w.stdout ?? '').trim() || undefined;
      } catch {}
      return { detected: true, version: (r.stdout ?? '').trim().split('\n')[0], binaryPath: abs ?? bin };
    }
  } catch {}
  return { detected: false };
}

function safeJsonRead(p: string): any | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function countMarkdown(dir: string) {
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    const mds: string[] = [];
    for (const it of items) {
      if (it.isFile() && it.name.endsWith('.md')) mds.push(it.name.replace(/\.md$/, ''));
      else if (it.isDirectory()) {
        try { for (const f of fs.readdirSync(path.join(dir, it.name))) if (f.endsWith('.md')) mds.push(`${it.name}/${f.replace(/\.md$/, '')}`); } catch {}
      }
    }
    return { count: mds.length, sample: mds.slice(0, 8) };
  } catch { return { count: 0, sample: [] }; }
}
function countDirEntries(dir: string): number { try { return fs.readdirSync(dir).length; } catch { return 0; } }

function gatherCliDetails(binaryPath?: string) {
  const claudeHome = path.join(os.homedir(), '.claude');
  const settings = safeJsonRead(path.join(claudeHome, 'settings.json')) ?? {};
  const policyLimits = safeJsonRead(path.join(claudeHome, 'policy-limits.json'));
  const credentialsExist = fs.existsSync(path.join(claudeHome, '.credentials.json'));
  const agents = countMarkdown(path.join(claudeHome, 'agents'));
  const plugins = settings?.enabledPlugins
    ? Object.keys(settings.enabledPlugins).filter((k) => settings.enabledPlugins[k]).slice(0, 12) : [];
  const projects = countDirEntries(path.join(claudeHome, 'projects'));
  const sessions = countDirEntries(path.join(claudeHome, 'sessions'));
  const mcpFromSettings = settings?.mcpServers && typeof settings.mcpServers === 'object'
    ? Object.keys(settings.mcpServers).length : 0;
  const mcpFile = safeJsonRead(path.join(claudeHome, 'mcp.json'));
  const mcpFromFile = mcpFile?.mcpServers && typeof mcpFile.mcpServers === 'object'
    ? Object.keys(mcpFile.mcpServers).length : 0;
  return {
    binaryPath, homeDir: claudeHome,
    defaultModel: typeof settings?.model === 'string' ? settings.model : undefined,
    effortLevel: typeof settings?.effortLevel === 'string' ? settings.effortLevel : undefined,
    statusLineConfigured: !!settings?.statusLine,
    credentialsPresent: credentialsExist,
    plugins, agents,
    mcpServers: mcpFromSettings + mcpFromFile,
    projects, sessions,
    policyLimits: policyLimits ? {
      maxConcurrentSessions: policyLimits.maxConcurrentSessions,
      maxToolsPerCall: policyLimits.maxToolsPerCall,
    } : undefined,
  };
}

function publicState(integ: ClaudeIntegration, workspaceId: string) {
  const cli = detectCli();
  const w = consentOf(integ, workspaceId);
  const cliConnected = !!w.cliConnectedAt && cli.detected;
  return {
    workspaceId,
    cliDetected: cli.detected,
    cliVersion: cli.version,
    cliBinaryPath: cli.binaryPath,
    cliConnected,
    cliConnectedAt: w.cliConnectedAt,
    cliConnectedVersion: w.cliConnectedVersion,
    details: cliConnected ? gatherCliDetails(cli.binaryPath) : undefined,
    apiKeySet: !!w.apiKey,
    apiKeyHint: w.apiKey ? `…${w.apiKey.slice(-4)}` : undefined,
    apiKeySavedAt: w.apiKeySavedAt,
    ready: cliConnected || !!w.apiKey,
  };
}

export function registerIntegrationRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/integrations/claude', async (req) => {
    return publicState(readFileSafe(), req.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/workspaces/:id/integrations/claude/cli/connect', async (req, reply) => {
    const cli = detectCli();
    if (!cli.detected) { reply.code(400); return { error: 'Claude CLI not detected on this machine.' }; }
    const integ = readFileSafe();
    const existing = consentOf(integ, req.params.id);
    const next: WorkspaceConsent = {
      ...existing,
      cliConnectedAt: existing.cliConnectedAt ?? Date.now(),
      cliConnectedVersion: cli.version,
    };
    writeFileSafe(setConsent(integ, req.params.id, next));
    return publicState(readFileSafe(), req.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/workspaces/:id/integrations/claude/cli/disconnect', async (req) => {
    const integ = readFileSafe();
    const cur = consentOf(integ, req.params.id);
    delete cur.cliConnectedAt;
    delete cur.cliConnectedVersion;
    writeFileSafe(setConsent(integ, req.params.id, cur));
    return publicState(readFileSafe(), req.params.id);
  });

  app.put<{ Params: { id: string }; Body: { apiKey?: string } }>(
    '/api/workspaces/:id/integrations/claude/apikey',
    async (req, reply) => {
      const key = (req.body?.apiKey ?? '').toString().trim();
      if (!key) { reply.code(400); return { error: 'apiKey is required' }; }
      const integ = readFileSafe();
      const cur = consentOf(integ, req.params.id);
      writeFileSafe(setConsent(integ, req.params.id, { ...cur, apiKey: key, apiKeySavedAt: Date.now() }));
      return publicState(readFileSafe(), req.params.id);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/workspaces/:id/integrations/claude/apikey', async (req) => {
    const integ = readFileSafe();
    const cur = consentOf(integ, req.params.id);
    delete cur.apiKey;
    delete cur.apiKeySavedAt;
    writeFileSafe(setConsent(integ, req.params.id, cur));
    return publicState(readFileSafe(), req.params.id);
  });
}

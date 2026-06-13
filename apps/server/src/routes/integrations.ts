import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { paths } from '@guideai/shared/paths';

interface UserConsent {
  /** When this user first granted CLI consent. Persists across sign-ins. */
  cliConnectedAt?: number;
  /** CLI version at consent time, for the UI history line. */
  cliConnectedVersion?: string;
  /** This user's stored Anthropic API key (per-user, not shared). */
  apiKey?: string;
  apiKeySavedAt?: number;
}

interface ClaudeIntegration {
  /** Per-user consent records, keyed by username. */
  users?: Record<string, UserConsent>;
}

const FILE = path.join(paths.home, 'integrations', 'claude.json');
const SESSION_FILE = path.join(paths.home, 'session.json');

function readFile(): ClaudeIntegration {
  try {
    if (!fs.existsSync(FILE)) return {};
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    // Migrate legacy single-user shape → keyed-by-user shape.
    if (j && (j.cliConnected !== undefined || j.apiKey !== undefined) && !j.users) {
      return { users: { __legacy__: {
        cliConnectedAt: j.cliConnected ? (j.cliConnectedAt ?? Date.now()) : undefined,
        apiKey: j.apiKey,
        apiKeySavedAt: j.apiKeySavedAt,
      } } };
    }
    return j as ClaudeIntegration;
  } catch { return {}; }
}
function writeFileSafe(s: ClaudeIntegration) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

function currentUsername(): string | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const j = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    return typeof j?.username === 'string' ? j.username : null;
  } catch { return null; }
}

function userOf(integ: ClaudeIntegration, username: string): UserConsent {
  return integ.users?.[username] ?? {};
}
function setUser(integ: ClaudeIntegration, username: string, patch: UserConsent | null): ClaudeIntegration {
  const users = { ...(integ.users ?? {}) };
  if (patch === null) delete users[username];
  else users[username] = patch;
  return { ...integ, users };
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

function publicState(integ: ClaudeIntegration, username: string | null) {
  const cli = detectCli();
  const u = username ? userOf(integ, username) : {};
  const cliConnected = !!u.cliConnectedAt && cli.detected;
  return {
    username,
    cliDetected: cli.detected,
    cliVersion: cli.version,
    cliBinaryPath: cli.binaryPath,
    cliConnected,
    cliConnectedAt: u.cliConnectedAt,
    cliConnectedVersion: u.cliConnectedVersion,
    details: cliConnected ? gatherCliDetails(cli.binaryPath) : undefined,
    apiKeySet: !!u.apiKey,
    apiKeyHint: u.apiKey ? `…${u.apiKey.slice(-4)}` : undefined,
    apiKeySavedAt: u.apiKeySavedAt,
    ready: cliConnected || !!u.apiKey,
  };
}

function requireUser(reply: any): string | null {
  const u = currentUsername();
  if (!u) { reply.code(401); return null; }
  return u;
}

export function registerIntegrationRoutes(app: FastifyInstance) {
  app.get('/api/integrations/claude', async (req: FastifyRequest, reply) => {
    const u = currentUsername();
    if (!u) { reply.code(401); return { error: 'sign-in required' }; }
    return publicState(readFile(), u);
  });

  app.post('/api/integrations/claude/cli/connect', async (_req, reply) => {
    const username = requireUser(reply);
    if (!username) return { error: 'sign-in required' };
    const cli = detectCli();
    if (!cli.detected) { reply.code(400); return { error: 'Claude CLI not detected on this machine.' }; }
    const integ = readFile();
    const existing = userOf(integ, username);
    const next: UserConsent = {
      ...existing,
      cliConnectedAt: existing.cliConnectedAt ?? Date.now(),
      cliConnectedVersion: cli.version,
    };
    writeFileSafe(setUser(integ, username, next));
    return publicState(readFile(), username);
  });

  app.post('/api/integrations/claude/cli/disconnect', async (_req, reply) => {
    const username = requireUser(reply);
    if (!username) return { error: 'sign-in required' };
    const integ = readFile();
    const cur = userOf(integ, username);
    delete cur.cliConnectedAt;
    delete cur.cliConnectedVersion;
    writeFileSafe(setUser(integ, username, cur));
    return publicState(readFile(), username);
  });

  app.put<{ Body: { apiKey?: string } }>(
    '/api/integrations/claude/apikey',
    async (req, reply) => {
      const username = requireUser(reply);
      if (!username) return { error: 'sign-in required' };
      const key = (req.body?.apiKey ?? '').toString().trim();
      if (!key) { reply.code(400); return { error: 'apiKey is required' }; }
      const integ = readFile();
      const cur = userOf(integ, username);
      writeFileSafe(setUser(integ, username, { ...cur, apiKey: key, apiKeySavedAt: Date.now() }));
      return publicState(readFile(), username);
    },
  );

  app.delete('/api/integrations/claude/apikey', async (_req, reply) => {
    const username = requireUser(reply);
    if (!username) return { error: 'sign-in required' };
    const integ = readFile();
    const cur = userOf(integ, username);
    delete cur.apiKey;
    delete cur.apiKeySavedAt;
    writeFileSafe(setUser(integ, username, cur));
    return publicState(readFile(), username);
  });
}

import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import type {
  AgentHandle,
  RunOnceResult,
  RuntimeAdapter,
  SpawnOpts,
} from '@guideai/runtime-core';
import type { Chunk, AIChunk, SystemChunk, ToolChunk } from '@guideai/shared/chunks';

const CLAUDE_BIN = process.env.GUIDEAI_CLAUDE_BIN ?? 'claude';

// Absolute path to our PreToolUse hook script. Resolved at module load so we
// don't recompute it on every spawn.
const HOOK_SCRIPT = (() => {
  // Walk up from this file to find the workspace root, then point at the hook.
  // adapter.ts lives at packages/runtime-claude/src/, so ../../permission-hook
  // would point to packages/permission-hook.
  try {
    const here = __dirname || process.cwd();
    return path.resolve(here, '..', '..', 'permission-hook', 'bin', 'guideai-perm-hook.cjs');
  } catch { return ''; }
})();

const PERMISSIONS_URL = process.env.GUIDEAI_PERMISSIONS_URL ?? 'http://127.0.0.1:4000/api/permissions/evaluate';

function writePermissionSettings(agentCwd: string, opts: SpawnOpts): string | null {
  if (!HOOK_SCRIPT || !fs.existsSync(HOOK_SCRIPT)) return null;
  const settingsDir = path.join(agentCwd, '.claude');
  fs.mkdirSync(settingsDir, { recursive: true });
  const settingsFile = path.join(settingsDir, 'settings.json');
  // Match every tool — let GuideAI's policy engine decide which ones to gate.
  const config = {
    hooks: {
      PreToolUse: [
        {
          matcher: '.*',
          hooks: [{ type: 'command', command: `node ${HOOK_SCRIPT}` }],
        },
      ],
    },
    // Hint to the CLI: we're handling permission via hooks, no need for stdin
    // prompts (which wouldn't work in -p mode anyway).
    permissionMode: 'default',
  };
  fs.writeFileSync(settingsFile, JSON.stringify(config, null, 2));
  return settingsFile;
}

// Module-scoped registry of every live Claude child process so the killswitch
// can stop-the-world (Principle 8). Add/remove around every spawn.
interface Tracked { proc: ChildProcess; workspaceId: string; agentId: string; startedAt: number; }
const TRACKED = new Set<Tracked>();

function track(t: Tracked) {
  TRACKED.add(t);
  t.proc.on('close', () => TRACKED.delete(t));
}

/** Snapshot of currently-running Claude agents. */
export function listRunningClaudeAgents() {
  return Array.from(TRACKED).map((t) => ({
    pid: t.proc.pid,
    workspaceId: t.workspaceId,
    agentId: t.agentId,
    startedAt: t.startedAt,
    uptimeMs: Date.now() - t.startedAt,
  }));
}

/**
 * Stop-the-world. Sends SIGTERM to every tracked Claude process; escalates to
 * SIGKILL after `hardTimeoutMs`. Resolves once every process has emitted
 * 'close' OR the hard deadline has passed. Returns the count killed.
 */
export async function killAllClaudeAgents(opts: { hardTimeoutMs?: number } = {}): Promise<{ killed: number; durationMs: number }> {
  const hardTimeoutMs = opts.hardTimeoutMs ?? 2000;
  const start = Date.now();
  const snapshot = Array.from(TRACKED);
  if (snapshot.length === 0) return { killed: 0, durationMs: Date.now() - start };

  const exits = snapshot.map((t) => new Promise<void>((resolve) => {
    if (t.proc.exitCode !== null) { resolve(); return; }
    t.proc.once('close', () => resolve());
  }));

  for (const t of snapshot) {
    try { if (!t.proc.killed) t.proc.kill('SIGTERM'); } catch {}
  }

  // Hard deadline: SIGKILL anything still alive at hardTimeoutMs.
  const kill9 = setTimeout(() => {
    for (const t of snapshot) {
      try { if (t.proc.exitCode === null && !t.proc.killed) t.proc.kill('SIGKILL'); } catch {}
    }
  }, hardTimeoutMs);

  await Promise.all(exits);
  clearTimeout(kill9);
  return { killed: snapshot.length, durationMs: Date.now() - start };
}

// Env allowlist per ECC Principle 8 (deny-by-default secrets). PATH and HOME are
// needed for the CLI to find itself; everything else is opt-in via SpawnOpts.env.
const BASE_ENV_ALLOWED = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'USER'];

// Resolve the Anthropic key for a given workspace.
//   1. integrations/claude.json#workspaces[workspaceId].apiKey  (override)
//   2. integrations/claude.json#global.apiKey                   (zero-config default)
//   3. integrations/claude.json#users[*].apiKey                 (legacy migration)
//   4. undefined → caller falls back to process.env.ANTHROPIC_API_KEY
function readStoredClaudeKey(workspaceId?: string): string | undefined {
  try {
    const home = process.env.GUIDEAI_HOME ?? path.join(os.homedir(), '.guideai');
    const integPath = path.join(home, 'integrations', 'claude.json');
    if (!fs.existsSync(integPath)) return undefined;
    const integ: any = JSON.parse(fs.readFileSync(integPath, 'utf8'));

    // 1. Workspace-specific
    if (workspaceId && typeof integ?.workspaces?.[workspaceId]?.apiKey === 'string') {
      const k = integ.workspaces[workspaceId].apiKey;
      if (k.length > 0) return k;
    }
    // 2. Global default
    if (typeof integ?.global?.apiKey === 'string' && integ.global.apiKey.length > 0) {
      return integ.global.apiKey;
    }
    // 3. Legacy: pick any user with a key
    if (integ?.users && typeof integ.users === 'object') {
      for (const u of Object.values(integ.users) as any[]) {
        if (typeof u?.apiKey === 'string' && u.apiKey.length > 0) return u.apiKey;
      }
    }
  } catch {}
  return undefined;
}

function buildEnv(extra?: Record<string, string>, opts?: SpawnOpts): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of BASE_ENV_ALLOWED) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  // API key precedence: process env → integrations/claude.json (workspace
  // override > global default > legacy). Deny-by-default for any other secret.
  const apiKey = process.env.ANTHROPIC_API_KEY ?? readStoredClaudeKey(opts?.workspaceId);
  if (apiKey) out.ANTHROPIC_API_KEY = apiKey;
  // Tell the hook where to phone home + which workspace/agent it's running for.
  out.GUIDEAI_PERMISSIONS_URL = PERMISSIONS_URL;
  if (opts) {
    out.GUIDEAI_WORKSPACE_ID = opts.workspaceId;
    out.GUIDEAI_AGENT_ID = opts.agentId;
  }
  if (extra) Object.assign(out, extra);
  return out;
}

function ensureCwd(cwd: string) {
  fs.mkdirSync(cwd, { recursive: true });
}

function nowChunkBase(workspaceId: string, agentId?: string) {
  return {
    id: randomUUID(),
    ts: Date.now(),
    workspaceId,
    ...(agentId ? { agentId } : {}),
  };
}

// The Claude CLI emits stream-json lines with shape like:
//   { "type": "assistant", "message": { "content": [...] }, "session_id": "..." }
//   { "type": "tool_use", "tool_name": "...", "input": {...} }
//   { "type": "system", "subtype": "...", "data": ... }
//   { "type": "result", "is_error": false, "result": "...", "total_cost_usd": ... }
// We map these to our generic Chunk types.
function mapClaudeLine(
  raw: string,
  workspaceId: string,
  agentId: string,
): Chunk | null {
  let obj: any;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;

  const base = nowChunkBase(workspaceId, agentId);

  switch (obj.type) {
    case 'assistant': {
      const blocks: any[] = obj.message?.content ?? [];
      const text = blocks
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join('');
      const usage = obj.message?.usage ?? {};
      const ai: AIChunk = {
        ...base,
        kind: 'ai',
        agentId,
        text,
        tokensIn: usage.input_tokens,
        tokensOut: usage.output_tokens,
        model: obj.message?.model,
      };
      return ai;
    }
    case 'tool_use':
    case 'tool_result': {
      const tool: ToolChunk = {
        ...base,
        kind: 'tool',
        agentId,
        tool: obj.tool_name ?? obj.name ?? 'unknown',
        args: obj.input ?? obj.tool_input ?? obj,
        result: obj.content ?? obj.output,
        status: obj.type === 'tool_use' ? 'pending' : 'completed',
      };
      return tool;
    }
    case 'system': {
      const sys: SystemChunk = {
        ...base,
        kind: 'system',
        text: typeof obj.data === 'string' ? obj.data : JSON.stringify(obj),
        level: 'info',
      };
      return sys;
    }
    case 'result': {
      const sys: SystemChunk = {
        ...base,
        kind: 'system',
        text: obj.is_error
          ? `[result error] ${obj.result ?? obj.error ?? '(unknown)'}`
          : `[result ok] ${typeof obj.result === 'string' ? obj.result.slice(0, 200) : ''}`,
        level: obj.is_error ? 'error' : 'info',
      };
      return sys;
    }
    default: {
      const sys: SystemChunk = {
        ...base,
        kind: 'system',
        text: `[unknown:${obj.type}] ${JSON.stringify(obj).slice(0, 200)}`,
        level: 'info',
      };
      return sys;
    }
  }
}

function baseArgs(opts: SpawnOpts): string[] {
  const args: string[] = ['--output-format', 'stream-json', '--verbose'];
  if (opts.model) args.push('--model', opts.model);
  if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt);
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push('--allowedTools', opts.allowedTools.join(','));
  }
  // Per-brief Claude session: every phase of a brief reuses the same id so
  // the conversation history is preserved + recoverable via `claude --resume`.
  if (opts.sessionId) args.push('--session-id', opts.sessionId);
  // Human-readable label for the picker — e.g. "frontend-developer · auth-flow".
  if (opts.sessionName) args.push('--name', opts.sessionName);
  return args;
}

function attachStream(
  proc: ChildProcess,
  workspaceId: string,
  agentId: string,
  listeners: Set<(c: Chunk) => void>,
) {
  const stdout = proc.stdout as Readable;
  const stderr = proc.stderr as Readable;
  const rl = readline.createInterface({ input: stdout });
  rl.on('line', (line) => {
    const chunk = mapClaudeLine(line, workspaceId, agentId);
    if (chunk) for (const cb of listeners) cb(chunk);
  });
  stderr.on('data', (buf) => {
    const text = buf.toString('utf8').trim();
    if (!text) return;
    const sys: SystemChunk = {
      ...nowChunkBase(workspaceId, agentId),
      kind: 'system',
      text: `[stderr] ${text}`,
      level: 'warn',
    };
    for (const cb of listeners) cb(sys);
  });
}

export const ClaudeAdapter: RuntimeAdapter = {
  id: 'claude',
  displayName: 'Claude Code',
  availability: 'ready',
  description: "Anthropic's Claude CLI — streaming, sandboxed, MCP-ready.",
  endpoint: CLAUDE_BIN,
  capabilities: {
    streaming: true,
    interactive: true,
    tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    models: [
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-6',
      'claude-opus-4-8',
    ],
  },

  async spawn(opts: SpawnOpts): Promise<AgentHandle> {
    ensureCwd(opts.cwd);
    writePermissionSettings(opts.cwd, opts);

    const args = ['--input-format', 'stream-json', ...baseArgs(opts), '-p'];
    const proc = spawn(CLAUDE_BIN, args, {
      cwd: opts.cwd,
      env: buildEnv(opts.env, opts),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    track({ proc, workspaceId: opts.workspaceId, agentId: opts.agentId, startedAt: Date.now() });

    const listeners = new Set<(c: Chunk) => void>();
    attachStream(proc, opts.workspaceId, opts.agentId, listeners);

    const exitPromise = new Promise<number>((resolve) => {
      proc.on('close', (code) => resolve(code ?? 0));
    });

    return {
      id: opts.agentId,
      pid: proc.pid ?? -1,
      async send(text: string) {
        // Each stdin message is one JSON-encoded user turn (stream-json input).
        const payload = JSON.stringify({ type: 'user', text }) + '\n';
        proc.stdin?.write(payload);
      },
      onEvent(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      waitForExit() {
        return exitPromise;
      },
      async kill(signal: NodeJS.Signals = 'SIGTERM') {
        if (!proc.killed) proc.kill(signal);
        // Hard-kill fallback after 2s (Principle 8: kill-switch).
        await Promise.race([
          exitPromise,
          new Promise<void>((r) => setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} r(); }, 2000)),
        ]);
      },
    };
  },

  async runOnce(opts: SpawnOpts, prompt: string): Promise<RunOnceResult> {
    ensureCwd(opts.cwd);
    writePermissionSettings(opts.cwd, opts);
    const args = [...baseArgs(opts), '-p', prompt];
    const start = Date.now();
    const proc = spawn(CLAUDE_BIN, args, {
      cwd: opts.cwd,
      env: buildEnv(opts.env, opts),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    track({ proc, workspaceId: opts.workspaceId, agentId: opts.agentId, startedAt: start });

    const chunks: Chunk[] = [];
    const listeners = new Set<(c: Chunk) => void>();
    // Buffer for the eventual RunOnceResult.
    listeners.add((c) => chunks.push(c));
    // Streaming fan-out: caller-supplied callback runs for every chunk as
    // soon as it arrives — used by the orchestrator to live-append to the
    // transcript file so the user sees turns + tool calls in real time.
    if (typeof opts.onChunk === 'function') {
      const cb = opts.onChunk;
      listeners.add((c) => { try { cb(c); } catch { /* ignore listener errors */ } });
    }
    attachStream(proc, opts.workspaceId, opts.agentId, listeners);

    const exitCode = await new Promise<number>((resolve) => {
      proc.on('close', (code) => resolve(code ?? 0));
    });

    return { exitCode, chunks, durationMs: Date.now() - start };
  },
};

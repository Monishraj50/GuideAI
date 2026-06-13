import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';
import type {
  AgentHandle,
  RunOnceResult,
  RuntimeAdapter,
  SpawnOpts,
} from '@guideai/runtime-core';
import type { Chunk, AIChunk, SystemChunk, ToolChunk } from '@guideai/shared/chunks';

const CLAUDE_BIN = process.env.GUIDEAI_CLAUDE_BIN ?? 'claude';

// Env allowlist per ECC Principle 8 (deny-by-default secrets). PATH and HOME are
// needed for the CLI to find itself; everything else is opt-in via SpawnOpts.env.
const BASE_ENV_ALLOWED = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'USER'];

function buildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of BASE_ENV_ALLOWED) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
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

    const args = ['--input-format', 'stream-json', ...baseArgs(opts), '-p'];
    const proc = spawn(CLAUDE_BIN, args, {
      cwd: opts.cwd,
      env: buildEnv(opts.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

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
    const args = [...baseArgs(opts), '-p', prompt];
    const start = Date.now();
    const proc = spawn(CLAUDE_BIN, args, {
      cwd: opts.cwd,
      env: buildEnv(opts.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const chunks: Chunk[] = [];
    const listeners = new Set<(c: Chunk) => void>();
    listeners.add((c) => chunks.push(c));
    attachStream(proc, opts.workspaceId, opts.agentId, listeners);

    const exitCode = await new Promise<number>((resolve) => {
      proc.on('close', (code) => resolve(code ?? 0));
    });

    return { exitCode, chunks, durationMs: Date.now() - start };
  },
};

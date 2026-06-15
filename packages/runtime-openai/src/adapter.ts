// OpenAI runtime adapter — used for the cross-vendor review pass (Phase 9).
// Implements RuntimeAdapter (id='codex' so it slots into the existing picker).
//
// Only `runOnce` is supported; `spawn` throws. The review phase uses pass@k
// which is one-shot per attempt, so this is enough for the v1 second-opinion
// use case without dragging streaming + interactive into scope.

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  AgentHandle, RunOnceResult, RuntimeAdapter, SpawnOpts,
} from '@guideai/runtime-core';
import type { AIChunk, Chunk, SystemChunk } from '@guideai/shared/chunks';
import { resolveOpenAIModel, type OpenAIUserConsent } from './integration.js';

const OPENAI_ENDPOINT = process.env.GUIDEAI_OPENAI_ENDPOINT ?? 'https://api.openai.com/v1/chat/completions';
const OPENAI_TIMEOUT_MS = 60_000;

interface MakeAdapterOpts {
  /** Provider of the per-call API key. Returning null means "no key" → throws on use. */
  apiKey: () => string | null;
  /** Per-user model overrides, if any. */
  overrides?: () => OpenAIUserConsent['modelOverrides'] | undefined;
  /** Override displayName in the UI picker. */
  displayName?: string;
}

function ensureCwd(cwd: string) {
  try { fs.mkdirSync(cwd, { recursive: true }); } catch {}
}

function makeAIChunk(opts: SpawnOpts, text: string, model: string, tIn: number, tOut: number): AIChunk {
  return {
    id: randomUUID(), ts: Date.now(), workspaceId: opts.workspaceId, agentId: opts.agentId,
    kind: 'ai', text, tokensIn: tIn, tokensOut: tOut, model,
  };
}
function makeSystem(opts: SpawnOpts, text: string, level: 'info' | 'warn' | 'error' = 'info'): SystemChunk {
  return {
    id: randomUUID(), ts: Date.now(), workspaceId: opts.workspaceId, agentId: opts.agentId,
    kind: 'system', text, level,
  };
}

interface OpenAIBody {
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  max_completion_tokens?: number;
}

async function callOpenAI(args: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
}): Promise<{ text: string; promptTokens: number; completionTokens: number }> {
  const body: OpenAIBody = {
    model: args.model,
    messages: [
      { role: 'system', content: args.systemPrompt },
      { role: 'user',   content: args.userPrompt },
    ],
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), OPENAI_TIMEOUT_MS);
  try {
    const r = await fetch(OPENAI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${args.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`openai ${r.status}: ${text.slice(0, 240)}`);
    const j = JSON.parse(text);
    const msg = j?.choices?.[0]?.message?.content ?? '';
    const usage = j?.usage ?? {};
    return {
      text: String(msg ?? ''),
      promptTokens: Number(usage.prompt_tokens ?? 0),
      completionTokens: Number(usage.completion_tokens ?? 0),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function makeOpenAIAdapter(args: MakeAdapterOpts): RuntimeAdapter {
  return {
    id: 'codex',
    displayName: args.displayName ?? 'OpenAI (GPT-5)',
    availability: 'ready',
    description: "Cross-vendor second opinion via OpenAI's chat completions API.",
    endpoint: OPENAI_ENDPOINT,
    capabilities: {
      streaming: false,
      interactive: false,
      tools: ['Read', 'Glob', 'Grep'],
      models: ['gpt-5-mini', 'gpt-5'],
    },

    async spawn(_opts: SpawnOpts): Promise<AgentHandle> {
      throw new Error('OpenAI adapter is one-shot only (use runOnce); interactive spawn not supported in v1.');
    },

    async runOnce(opts: SpawnOpts, prompt: string): Promise<RunOnceResult> {
      ensureCwd(opts.cwd);
      const start = Date.now();
      const apiKey = args.apiKey();
      if (!apiKey) {
        throw new Error('OpenAI adapter: no API key set for the current user');
      }
      const model = resolveOpenAIModel(opts.model ?? 'sonnet', args.overrides?.());
      const sys = opts.systemPrompt ?? 'You are an assistant. Respond clearly and concisely.';
      try {
        const r = await callOpenAI({ apiKey, model, systemPrompt: sys, userPrompt: prompt });
        const chunks: Chunk[] = [
          makeSystem(opts, `[openai] ${model}`),
          makeAIChunk(opts, r.text || '(empty response)', model, r.promptTokens, r.completionTokens),
        ];
        return { exitCode: 0, chunks, durationMs: Date.now() - start };
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        return {
          exitCode: 1,
          chunks: [makeSystem(opts, `[openai] error: ${msg.slice(0, 240)}`, 'error')],
          durationMs: Date.now() - start,
        };
      }
    },
  };
}

/**
 * Mock OpenAI adapter — drop-in for guest mode / no-key cases. Returns
 * deterministic "pass" review verdicts so the cross-vendor codepath can
 * demo end-to-end without spending tokens.
 */
export const MockOpenAIAdapter: RuntimeAdapter = {
  id: 'codex',
  displayName: 'OpenAI (Mock)',
  availability: 'ready',
  description: 'Deterministic local mock for the cross-vendor codepath — no API calls.',
  endpoint: 'mock://openai',
  capabilities: {
    streaming: false, interactive: false,
    tools: ['Read', 'Glob', 'Grep'],
    models: ['mock-gpt-5-mini'],
  },
  async spawn(): Promise<AgentHandle> {
    throw new Error('mock spawn not supported');
  },
  async runOnce(opts: SpawnOpts, _prompt: string): Promise<RunOnceResult> {
    ensureCwd(opts.cwd);
    await new Promise((r) => setTimeout(r, 220 + Math.floor(opts.agentId.length * 7) % 200));
    const text =
      'Independent review (cross-vendor):\n' +
      '- Implementation aligns with the plan and respects the success criteria.\n' +
      '- Risks called out in the plan are tracked; mitigations look reasonable.\n' +
      '- One nit: long briefs may drift past the token forecast — recommend tighter caps.\n' +
      'Verdict: PASS.';
    return {
      exitCode: 0,
      chunks: [
        makeSystem(opts, '[openai-mock] running cross-vendor review'),
        makeAIChunk(opts, text, 'mock-gpt-5-mini', Math.max(80, text.length / 6), Math.max(40, text.length / 4)),
      ],
      durationMs: 220,
    };
  },
};

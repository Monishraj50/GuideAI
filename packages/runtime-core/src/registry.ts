import { makeStubAdapter, type RuntimeAdapter, type RuntimeId } from './index.js';

// Stub adapters live in core so the UI can show them in the picker without
// pulling a "real" adapter package per provider. As each adapter ships, swap
// the stub for the real one in `loadRuntimes()` (apps/server side).

export const STUB_ADAPTERS: Record<Exclude<RuntimeId, 'claude'>, RuntimeAdapter> = {
  codex: makeStubAdapter({
    id: 'codex',
    displayName: 'Codex CLI',
    description: "OpenAI's Codex CLI — streaming, MCP-ready. Adapter coming in v2.",
    capabilities: { streaming: true, interactive: true, tools: ['Read', 'Write', 'Edit', 'Bash'], models: ['gpt-5'] },
  }),
  copilot: makeStubAdapter({
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    description: "Microsoft's GitHub Copilot CLI. Adapter coming in v2.",
    capabilities: { streaming: false, interactive: false, tools: ['Read', 'Edit', 'Bash'], models: ['gpt-5'] },
  }),
  gemini: makeStubAdapter({
    id: 'gemini',
    displayName: 'Gemini CLI',
    description: "Google's Gemini CLI. Adapter coming in v2.",
    capabilities: { streaming: true, interactive: false, tools: ['Read', 'Edit'], models: ['gemini-3-pro'] },
  }),
};

export interface RuntimeListing {
  id: RuntimeId;
  displayName: string;
  availability: 'ready' | 'coming-soon';
  description: string;
  capabilities: RuntimeAdapter['capabilities'];
}

/** Build a public listing for the API. Pass the live ClaudeAdapter in so this
 *  module avoids a workspace cycle with the @guideai/runtime-claude package. */
export function listRuntimes(live: RuntimeAdapter): RuntimeListing[] {
  const all: RuntimeAdapter[] = [live, ...Object.values(STUB_ADAPTERS)];
  return all.map((a) => ({
    id: a.id,
    displayName: a.displayName,
    availability: a.availability,
    description: a.description,
    capabilities: a.capabilities,
  }));
}

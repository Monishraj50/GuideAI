// Step 2 smoke test: spawn Claude CLI in a sandboxed cwd, capture chunks, exit cleanly.
//
// Usage: pnpm --filter @guideai/runtime-claude smoke
//
// Cost: one tiny prompt ("Reply with exactly one word: ok").
// Sandboxed cwd: ~/.guideai/workspaces/_smoke/agents/smoke-agent/cwd

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ClaudeAdapter } from '../src/adapter.js';

const WORKSPACE_ID = '_smoke';
const AGENT_ID = 'smoke-agent';
const CWD = path.join(os.homedir(), '.guideai', 'workspaces', WORKSPACE_ID, 'agents', AGENT_ID, 'cwd');
fs.mkdirSync(CWD, { recursive: true });

async function main() {
  console.log('[smoke] adapter:', ClaudeAdapter.id);
  console.log('[smoke] cwd    :', CWD);
  console.log('[smoke] sending prompt...');

  const result = await ClaudeAdapter.runOnce(
    {
      agentId: AGENT_ID,
      workspaceId: WORKSPACE_ID,
      cwd: CWD,
      systemPrompt: 'You are a test agent. Answer with the single word: ok.',
    },
    'Reply with exactly one word: ok',
  );

  console.log('[smoke] exit code:', result.exitCode);
  console.log('[smoke] duration :', result.durationMs, 'ms');
  console.log('[smoke] chunks   :', result.chunks.length);

  const ai = result.chunks.find((c) => c.kind === 'ai');
  if (ai && ai.kind === 'ai') {
    console.log('[smoke] AI chunk : text=' + JSON.stringify(ai.text) + ' tokens=' + ai.tokensIn + '/' + ai.tokensOut + ' model=' + ai.model);
  } else {
    console.error('[smoke] FAIL: no AI chunk received');
    console.error('[smoke] all chunks:', JSON.stringify(result.chunks, null, 2));
    process.exit(1);
  }

  console.log('[smoke] PASS');
}

main().catch((err) => {
  console.error('[smoke] error:', err);
  process.exit(1);
});

// S1 strip: marketplace fetch removed. Seeds the 8 v2 core agents into
// ~/.guideai/catalog/catalog.json.
//
//   pnpm --filter @guideai/agents-catalog seed

import fs from 'node:fs';
import path from 'node:path';
import { paths } from '@guideai/shared/paths';
import { catalogPath, type Catalog, type CatalogAgent } from './index.js';

const SEED_AGENTS: CatalogAgent[] = [
  {
    role: 'planner',
    displayName: 'Planner',
    department: 'core',
    description: 'Breaks a brief into a 3–7-step plan with acceptance checks.',
    tools: ['Read', 'Glob', 'Grep'],
    model: 'sonnet',
    body: 'You are a senior planner. Read the brief and the project context. Produce a numbered plan with acceptance checks per step.',
  },
  {
    role: 'coder',
    displayName: 'Coder',
    department: 'core',
    description: 'Implements the plan with minimal, focused diffs.',
    tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
    model: 'sonnet',
    body: 'You are a careful software engineer. Implement the plan one step at a time. Keep diffs small. Surface uncertainty explicitly.',
  },
  {
    role: 'reviewer',
    displayName: 'Reviewer',
    department: 'core',
    description: 'Reviews diffs for correctness, security, and clarity.',
    tools: ['Read', 'Glob', 'Grep'],
    model: 'opus',
    body: 'You review diffs against the plan and the acceptance checks. Flag issues by severity. Recommend approve / reject / fix.',
  },
  {
    role: 'tester',
    displayName: 'Tester',
    department: 'core',
    description: 'Writes unit + integration tests for changed code.',
    tools: ['Read', 'Edit', 'Write', 'Bash'],
    model: 'sonnet',
    body: 'You write tests for the code that changed in this brief. Cover happy path + 1–2 edge cases.',
  },
  {
    role: 'refactorer',
    displayName: 'Refactorer',
    department: 'core',
    description: 'Improves structure without changing behaviour.',
    tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
    model: 'sonnet',
    body: 'You refactor for clarity and reuse. Preserve behaviour. Run tests after each step.',
  },
  {
    role: 'debugger',
    displayName: 'Debugger',
    department: 'core',
    description: 'Reproduces a bug, isolates root cause, fixes it.',
    tools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
    model: 'sonnet',
    body: 'You debug failing code. Reproduce first, then bisect to the root cause, then patch with a test that locks the fix.',
  },
  {
    role: 'doc-writer',
    displayName: 'Doc Writer',
    department: 'core',
    description: 'Writes README/usage docs for new features.',
    tools: ['Read', 'Edit', 'Write', 'Glob'],
    model: 'haiku',
    body: 'You write user-facing docs. Lead with the example. Keep prose tight.',
  },
  {
    role: 'researcher',
    displayName: 'Researcher',
    department: 'core',
    description: 'Reads the codebase to answer "where/why/how" before changes.',
    tools: ['Read', 'Glob', 'Grep'],
    model: 'haiku',
    body: 'You answer codebase questions. Cite file paths + line numbers. Do not edit code.',
  },
];

async function main() {
  fs.mkdirSync(path.dirname(catalogPath()), { recursive: true });
  const out: Catalog = {
    fetchedAt: Date.now(),
    count: SEED_AGENTS.length,
    agents: SEED_AGENTS,
  };
  fs.writeFileSync(catalogPath(), JSON.stringify(out, null, 2));
  console.log(`[seed] wrote ${SEED_AGENTS.length} v2 core agents → ${catalogPath()}`);
  console.log(`[seed] state dir: ${paths.home}`);
}

main().catch((err) => { console.error('[seed] error:', err); process.exit(1); });

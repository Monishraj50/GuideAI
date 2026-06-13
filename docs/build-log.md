# GuideAI Build Log

Per ECC Principle 7B: every build session appends a 5-line entry. Read this before starting a session.

---

## Step 1 — Monorepo skeleton (done 2026-06-13)

- pnpm@9 installed user-local at `~/.npm-global/bin/pnpm` (no sudo on this host).
- pnpm workspaces wired; `apps/{server,web}` present, `apps/web` is a placeholder until step 4.
- `packages/shared` ships Drizzle schema + `init-db` script. `pnpm init-db` → `~/.guideai/db.sqlite` (WAL, FK on, 7 tables, 5 indexes).
- `packages/policies` ships caps stubbed (Principles 1,2,5,9) and model router (Principle 4).
- Demo: `pnpm dev` brings up `apps/server` on :4000; `GET /healthz` returns caps payload → wiring confirmed end-to-end.
- **Skipped (Principle 10 — surfaced, not silent):** Next.js scaffold deferred to step 4 to keep step 1 lean. `apps/web` runs a placeholder script. The recursive `pnpm -r run dev` pattern was abandoned because subprocess PATH doesn't include user-local pnpm — root `dev` now calls `tsx` and `node` directly via `concurrently`.
- **Pass@1 dogfood check (Principle 9B):** `pnpm init-db` and `pnpm dev` re-run from clean state, both work.

---

## Step 2 — runtime-claude adapter (done 2026-06-13)

- `packages/runtime-core` ships the `RuntimeAdapter` interface (`spawn` + `runOnce` + `AgentHandle`). Designed so Codex/Copilot/Gemini adapters plug in identically.
- `packages/runtime-claude` implements `ClaudeAdapter`: spawns the `claude` CLI with `--output-format stream-json --verbose`, parses stream-json into our `Chunk` discriminated union (UserChunk/AIChunk/SystemChunk/ToolChunk).
- Sandboxing per Principle 8: ensures the agent's `cwd` exists, builds env from a small allowlist (`PATH, HOME, LANG, LC_ALL, TERM, USER`), opt-in env via `SpawnOpts.env`. No `*_TOKEN/*_KEY` leak by default.
- Kill-switch (Principle 8): `handle.kill()` sends SIGTERM then SIGKILL after 2s if process hasn't exited.
- Smoke (`pnpm --filter @guideai/runtime-claude smoke`): runs in `~/.guideai/workspaces/_smoke/agents/smoke-agent/cwd`, sends a single-word prompt, receives 4 chunks including one AI chunk with token counts.
- **Pass@2 (Principle 9B):** both runs identical (4 chunks, "ok", model=`claude-opus-4-7`, ~3.2s, exit 0).
- **Skipped (Principle 10 — surfaced, not silent):** `runOnce` is fully wired; `spawn` (interactive long-running mode) compiles and is structurally complete but its stdin protocol (`{type:'user', text}`) hasn't been exercised end-to-end — that lands in step 5 when an agent receives messages from another agent.


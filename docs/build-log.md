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

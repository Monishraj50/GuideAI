# GuideAI

A multi-agent **company platform**. You're the boss; agents are your team. They take briefs, decompose work, message each other, review each other's output, and ship.

- **Mission Control** UI — live event feed, channels, org chart, brief-the-boss pane.
- **Hire Marketplace** — 154 pre-built subagents across 10 departments.
- **ECC-optimized** — sequential phase gates, lean MCP scoping, model-tier routing, pass@k evals, deny-by-default secrets.
- **Local-first** — SQLite + filesystem at `~/.guideai/`. Server-sync later.
- **Day-1 runtime**: Claude Code CLI. Codex / Copilot adapters land in v2.

## Quick start

```bash
pnpm install
pnpm init-db   # creates ~/.guideai/db.sqlite
pnpm dev       # boots apps/server + apps/web
```

## Status

Pre-alpha. See `docs/build-log.md` for the latest step.

## License

AGPL-3.0 (inherited from upstream `agent-teams-ai`).

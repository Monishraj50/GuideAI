# GuideAI

> Brief a task. Skills do the work. You review the diff.

GuideAI is a VSCode extension that turns a one-line brief — or a full project goal — into reviewed, working code. The orchestrator decomposes work into small tasks, picks the right skill for each, runs a 3-phase pipeline (plan → implement → review), and hands you the diff for approval.

- **Local-first** — SQLite + filesystem at `~/.guideai/` (global) and `<repo>/.guideai/` (per-project). No backend.
- **Skill-driven** — skills are the executor. Default seed library; install more via packs.
- **Session-aware** — every chat is a resumable Claude CLI session; the next agent picks the right one and continues.
- **Token-efficient** — hierarchical context (`PROJECT.md` → `FEATURE.md` → sessions) keeps typical context at 3–5k tokens regardless of project size.
- **VSCode-native** — no separate web UI. Sidebar + webviews. AGPL-3.0.

> **Status:** v2 in development. See [docs/v2-plan.md](docs/v2-plan.md) for the build plan and [docs/v2-discussion.md](docs/v2-discussion.md) for the design rationale.

---

## Quick start

**Requirements:** Node ≥ 20 · pnpm 9 · Claude Code CLI installed and logged in.

```bash
git clone <repo> && cd <repo>
pnpm install
pnpm dev          # boots the local server + watches the extension
```

In VSCode: install the extension from the workspace (`apps/vscode`), open any project folder, click **GuideAI ▾** in the sidebar.

First launch creates `~/.guideai/` (global) and prompts you to start a brief.

---

## The flow

```
┌─────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│  Brief / Goal   │ → │ classifyBrief()  │ → │ QUICK lane       │
│  + budget       │   │ quick or heavy?  │   │ (small fix)      │
└─────────────────┘   └──────────────────┘   └─────────┬────────┘
                              │                        │
                              ↓ heavy                  ↓
                   ┌──────────────────────┐   ┌──────────────────┐
                   │ Decompose →          │   │ pickSkill()      │
                   │ task tree in Kanban  │   │ single agent run │
                   └──────────┬───────────┘   └─────────┬────────┘
                              │                         │
                              ↓ per task                ↓
                   ┌──────────────────────────────────────────┐
                   │ plan → implement → review                │
                   │   ↑ gate     ↑ gate     ↑ gate           │
                   │   skill picked at start of each task     │
                   │   live chat streams turns                │
                   │   diff webview at end → user approves    │
                   └──────────────────────────────────────────┘
                                       ↓
                   ┌──────────────────────────────────────────┐
                   │ post-phase hook:                         │
                   │  • update FEATURE.md (decisions + tag)   │
                   │  • update PROJECT.md (TOC)               │
                   │  • promote skill if successful           │
                   │  • PII scrub on memory write             │
                   └──────────────────────────────────────────┘
```

### Quick vs Heavy

- **Quick** — brief ≤ 100 chars, single file, or tagged `[quick]`. Skips decomposition + kanban. Single skill, single chat panel, single diff.
- **Heavy** — multi-step project. Decomposed into 5–10 tasks, ordered by dependencies, landed in Kanban Backlog. Drag through Plan → Implement → Review.

---

## How context is stored

```
GLOBAL                                PER-REPO
~/.guideai/                            <repo>/.guideai/
├ registry.db                         ├ workspace.db          (gitignored)
├ skills/_seed/    10 default skills  ├ PROJECT.md            ← root TOC
├ packs/<name>/    installed packs    ├ features/<slug>/
├ agents-memory/   cross-repo (ACL)   │   ├ FEATURE.md        ← state + decisions
├ settings.json                       │   ├ sessions/*.jsonl  (gitignored)
└ integrations/   API keys (0600)     │   └ sessions/*.md     (gitignored)
                                      ├ skills/_user/         promoted
                                      ├ skills/_custom/       hand-written
                                      ├ hooks.json
                                      └ meta.json
```

**A new agent looking up context:**

1. Read `PROJECT.md` (~1k tokens) → file/keyword match → identify feature
2. Read `features/<slug>/FEATURE.md` (~2k tokens) → goal, decisions, session table
3. Pick best session (BM25 × outcome × diversity-rank)
4. `claude --resume <sessionId>` — 0 tokens injected, Claude's cache holds it
5. New turns append to the same `.jsonl`

**Typical fix: 3–5k tokens.** Sessions never bloat the prompt.

---

## Sidebar (VSCode)

```
GUIDEAI ▾
  🚀 START                  New brief · Quick task · Open Kanban
  📂 FEATURES               grouped by feature; each feature lists sessions with ✓/⚠/✗
  ⚙ ACTIVE WORK             live tasks, click → live chat
  👥 TEAM                   agents in this workspace, status dots
  🛠 SKILLS & PACKS         installed inventory, browse packs
  📊 PROGRESS               tasks done · budget remaining

Status bar:  ●  GuideAI · ↓Nk ↑Nk · $X.XX · model
```

---

## Skills & packs

Skills are the executor. When a task starts, `pickSkill()` matches by keyword + `appliesTo` + file context. The skill's body becomes the agent's runbook.

**Default seed (10 skills, ships with install):**

```
add-test · fix-bug · refactor-function · add-feature · write-docs
review-code · rename · extract-function · debug · format
```

**Install more via packs:**

```bash
guideai pack list
guideai pack install dev-skills-pro
guideai pack install frontend-bundle
guideai pack uninstall dev-skills-pro
```

Packs are git repos validated against a `pack.json` schema declaring required tools/files/runtime. Skills from packs with missing prerequisites are silently filtered from picking; visible in the browser with a "Missing: gh" badge.

**Pick-time priority:** `_user` > `_custom` > installed packs > `_seed`. Your promoted skills always win.

---

## Sessions & resume

Every chat is a Claude CLI session. The session ID is recorded in `FEATURE.md`:

```md
## Sessions
| Session ID | Date | Did | Outcome |
|---|---|---|---|
| `sess_a1b2c3` | 2026-06-29 | wired API + validation | ✓ shipped |
| `sess_9f8e7d` | 2026-06-28 | scaffolded form | ✓ merged |
| `sess_4c3b2a` | 2026-06-27 | initial spike | ✗ abandoned |
```

To continue work later:
- VSCode: sidebar → Features → click a session → live chat reopens
- Terminal: `claude --resume sess_a1b2c3` (Claude CLI lists GuideAI sessions with `[<feature> · <user>] <brief>` titles)

Native resume reuses Claude's prompt cache — fewer tokens, faster turn-around.

---

## Permissions

When Claude tries to call a tool (`Read`, `Edit`, `Write`, `Bash`, …) the request is intercepted by a `PreToolUse` hook that asks the orchestrator before the tool runs. You see pending requests in a dedicated **🛂 Permissions** panel at the top of the sidebar, with a before/after diff for `Edit`/`Write`.

Three modes (set per-workspace from the panel header):

| Mode | Behavior |
|---|---|
| **Manual** (default) | Every tool call asks. Safest. |
| **Auto** | Accept everything safe. Hard-denies still apply (`rm -rf`, `--no-verify`, paths outside the consented folder). |
| **Custom** | Rule-based. `Read/Glob/Grep` auto-allow, `Bash` asks, etc. Rules edited in a webview and persisted to `<repo>/.guideai/policies/rules.json`. |

**Always allow** in a prompt records the rule for the current pipeline run only — it clears when the brief completes. The 🛑 killswitch in the panel header stops every running agent and denies every pending request immediately.

---

## Hooks-as-policy

Six hook points per phase, configured per-repo in `.guideai/hooks.json`:

| Hook | Built-in |
|---|---|
| `pre-phase` | budget-cap |
| `post-phase` | skill-promote, outcome-tag |
| `pre-diff` | secret-scan |
| `pre-commit` | (user-defined) |
| `on-skill-pick` | (logging) |
| `on-memory-write` | pii-scrub (email/api-key/token/jwt/phone) |

---

## What's in the monorepo

```
apps/
├ vscode/      VSCode extension (the only UI)
└ server/      Fastify server on :4000 (orchestration backend)

packages/
├ orchestrator/    cos · phases · decompose · contextStore · resume · taskGate · memory
├ skills/          loadSkills · pickSkill · invoke · promote
├ runtime-claude/  Claude CLI adapter
├ messaging/       JSONL events + SSE
├ policies/        hooks + PII scrub
├ permission-hook/ tool-call interception
├ agents-catalog/  seed agent personas
├ metrics/         per-agent token/$ stats
├ shared/          Drizzle schema + types + paths
└ runtime-core/    shared runtime interface
```

---

## License

AGPL-3.0. Substantial runtime code is lifted from a third-party AGPL project; we ship under the same license.

---

## Further reading

- [docs/v2-plan.md](docs/v2-plan.md) — full build plan (13 incremental steps)
- [docs/v2-discussion.md](docs/v2-discussion.md) — design Q&A log
- [docs/v1-archive/](docs/v1-archive/) — superseded v1 documentation (historical reference)

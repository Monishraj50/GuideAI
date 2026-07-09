# Building with GuideAI — a workflow guide

You have a project idea. This document is the shortest path from *"I want to build X"* → *"it's shipped and I know why every line is there"* using the extension.

It's not a feature list. It's a **workflow** — the order to do things in, the choices that matter, and the mistakes to skip.

---

## The mental model in one paragraph

GuideAI is a **team**, not an autocomplete. You brief it like a small startup: one goal per brief, a plan phase that lays out the approach, an implement phase that writes code, and a review phase that inspects the diff before it lands. Sessions persist across days — coming back tomorrow means the same conversation, prompt cache warm, no re-priming. Skills are runbooks (yours or from a pack) the team follows for common shapes of work (add a test, fix a bug, write docs). Diffs get reviewed hunk-by-hunk before they touch your files. Delete `.atrune/` at any time to fully reset.

---

## Step 1 · Set up (one-time, ~3 min)

**Open the folder** where your project lives (or will live). If it's brand-new, `mkdir my-project && code my-project`.

**Click "Allow storage in this folder"** in the sidebar Welcome view.
- What this does: creates `.atrune/` inside your folder. That's where GuideAI puts everything — DB, logs, transcripts, session UUIDs. Deleting that folder resets everything, so you never wonder where state lives.

**Connect a subscription** — Claude Pro, Copilot, or Codex. Whichever you already pay for.

You're set up. Nothing else is written to your folder until you dispatch a brief.

---

## Step 2 · Frame your first goal

Before typing anything into the extension, do this in your head:

1. **What is one working slice you could ship this week?** Not the whole app — one demoable slice.
2. **What files will change?** Even a rough guess. This helps the decomposer.
3. **What does "done" look like?** One sentence.

**Example.** Say your project is a small TODO CLI:

- Slice: `add`, `list`, `done` commands writing to a JSON file.
- Files: probably `src/cli.ts` + a store module + tests.
- Done: `todo add "buy milk" && todo list` shows the item; `todo done 1` marks it complete.

If you can't answer those three, the brief will be too vague. Better to think for 5 minutes than dispatch 3 bad briefs.

---

## Step 3 · Pick the right lane — Quick vs Heavy

**Quick task** (single agent, no pipeline, ~15s, cheap):
- Use for: a typo, a rename, adding one test to an existing function, writing one docstring.
- Trigger: `Atrune: Quick task` from the palette (or the sidebar 🚀 Start view).
- Auto-classified when: your brief is under 100 chars OR references exactly one file. You can force it with `[quick]` in the brief.

**Heavy brief** (3-phase pipeline: plan → implement → review, ~2-10 min):
- Use for: anything with multiple files, multiple commands, or that needs a plan before code.
- Trigger: `Atrune: New brief`.
- Auto-classified when: your brief is long or mentions multiple files.

**When in doubt, start Quick.** You can always follow up with a Heavy brief that references what Quick just built.

---

## Step 4 · Write a good brief

A brief is a message to the team. The best briefs:

- **Name the outcome, not the steps.** Bad: *"open src/cli.ts, add a function called add, then export it, then…"*. Good: *"add a `todo add "text"` command that appends to `~/.todo.json` and prints the new id"*.
- **Mention file paths when you know them.** They anchor the plan phase.
- **State constraints explicitly.** *"Keep the JSON schema flat, no nested arrays"* or *"Use only Node built-ins, no dependencies"*.
- **Include one acceptance check.** *"Running `todo add "buy milk"` then `todo list` should show the item"*.

Example first brief for the TODO CLI:
```
Build a TODO CLI in src/cli.ts with three commands:
- todo add "text"       → appends to ~/.todo.json, prints new id
- todo list             → prints all pending items with ids
- todo done <id>        → marks that item done

Use only Node built-ins. Cover each command with a test in tests/cli.test.ts.
Acceptance: `todo add "buy milk"` then `todo list` shows the item; `todo done 1` marks it done.
```

Notice: one goal, three sub-features, named files, one acceptance check. Length: ~50 words. The decomposer will turn this into 8-12 work items on the Kanban.

---

## Step 5 · While the pipeline runs

**Watch the Kanban board.** It opens automatically. Three columns (Plan · Implement · Review) with your decomposed tasks.

**Watch the live chat.** The extension streams the agent's thinking + tool calls. You can see when it:
- Reads a file (Read tool call).
- Grep for context (Grep tool call).
- Selects a skill (`Selected skill: add-feature`).
- Writes files (Write / Edit tool calls, gated by your permission mode).

**Don't interrupt unless something is going obviously wrong.** Each phase's output feeds the next; killing mid-brief wastes tokens. If you have to stop, use `Atrune: Killswitch`.

**Approvals**: if your permission mode is Manual, every Write/Edit gets an approval prompt with a diff preview. Accept individually or use *Always allow this session*.

---

## Step 6 · Review the diff before it lands

When the pipeline finishes, run `Atrune: Review task diff (hunk-by-hunk)…` on the implement task.

- Every changed file appears as green/red hunks with a checkbox.
- Toolbar: Accept all · Reject all · Apply selection.
- Uncheck any hunk you don't want.
- Click **Apply selection** — accepted hunks stay on disk, rejected ones revert.
- Rejected hunks automatically spawn a follow-up review task on the Kanban with a description of what was rejected. That way the work isn't lost, and the reviewer's note travels with the task.

**Guardrails you get for free**: the built-in secret-scan hook blocks any hunk containing an AWS key, GitHub token, OpenAI key, private key, or JWT. You don't have to remember — it just refuses to apply.

---

## Step 7 · Iterate — the second brief

Say the first brief landed but you want to add `todo delete <id>`. Second brief:

```
Add a `todo delete <id>` command to src/cli.ts. Same JSON store.
Cover with a test in tests/cli.test.ts.
```

Notice how short this is. The extension **recognizes the same feature** (same first-line prefix → same feature slug) and:
1. **Resumes the same Claude session** — prompt cache warm, prior implementation loaded. No re-priming, faster + cheaper.
2. Adds the new session as a row in `atrune/features/build-a-todo-cli…/FEATURE.md` under `## Sessions` with outcome ✓/⚠/✗.

You'll see `S7 resume: reusing session <uuid>… · score N · matched delete,command` in the event log.

---

## Step 8 · The next day — resume where you left off

Close VS Code. Come back tomorrow. Reopen the folder.

**Sidebar 📂 Features** shows every feature you've touched, each with a status dot (✓ shipped · ⚠ partial · ✗ abandoned) and its sessions as children.

**Palette → Atrune: Resume a saved session…** opens a Quick Pick grouped by feature. Pick one → a terminal opens with `claude --resume <uuid>` in the right cwd. You're back inside the exact conversation, with full history.

Alternatively, just dispatch a new brief that mentions the same feature. The agent-driven resume picks the best-matching prior session automatically (score-based on keyword overlap + outcome + recency).

---

## Step 9 · When to install a Pack

Packs are bundles of skills + agents + hooks someone else authored. Two reasons to install one:

1. **Your domain isn't well-covered by the 10 seed skills.** E.g., you're doing infra work — install a pack with skills for Terraform, Docker, K8s runbooks.
2. **You want stricter defaults.** E.g., a compliance pack with a hook that blocks any hunk introducing `console.log` in production code.

Install a local pack for testing:
```bash
mkdir -p /tmp/my-pack/skills
# Author pack.json + one .md skill file (see docs/v2-plan.md for schema)
```
Then palette → `Atrune: Install a pack…` → From local path → `/tmp/my-pack`.

Skills from a satisfied-requires pack rank between your own `_user/` skills and the built-in `_seed/` skills. Skills from a missing-deps pack (e.g., a Docker pack when Docker isn't installed) get silently skipped — no broken picks.

The sidebar 🛠 Skills & Packs shows all your installed packs + every loaded skill grouped by source. Click a skill to open its `.md` file if you want to customize it.

---

## Step 10 · When things go wrong

**The pipeline is stuck.** Check the sidebar Progress view. Any task with a lock icon is waiting on unfinished deps — mark the upstream Done or use the kanban to drag it.

**The last brief broke a file.** Run `Atrune: Review task diff…` for that task, uncheck the offending hunks, apply. The reject spawns a follow-up so the agent can retry with your note.

**A session got polluted with bad context.** Delete its row from `atrune/features/<slug>/FEATURE.md` and re-run. Or manually `rm ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` to force a fresh conversation.

**You want to start completely over.** Delete `.atrune/` inside your project folder. The sidebar clears, all open panels close, `~/.guideai/workspaces/<id>/` gets reaped, `~/.claude/projects/<enc>/` gets reaped. Click Allow again for a clean slate. Nothing else on your machine changes.

**Budget getting scary.** Status bar shows live spend (`$X.XX`). Every brief has a soft budget you can set. Hard-cap the workspace via `Atrune: Set workspace budget…` — the pre-phase hook halts at the ceiling before spending more.

---

## What NOT to do

- **Don't dispatch briefs like Twitter posts.** A vague brief costs tokens on a bad plan → tokens on wrong code → tokens on a confused review. Take 2 minutes on the wording.
- **Don't disable the review phase to save time.** The review artifact drives the outcome tag on FEATURE.md and the shipped/partial/abandoned classifier. Losing it means every session shows as partial.
- **Don't edit files under `atrune/` (visible md dir) by hand.** They're rewritten on each phase completion. Edit the sources instead (skill files under `~/.guideai/skills/_user/`, or agent personas in the catalog).
- **Don't grant folder consent on a repo you don't own.** GuideAI writes SQLite + jsonl + md files under `.atrune/`. Add it to `.gitignore` or don't grant consent — up to you.

---

## Cheat sheet — the commands you'll actually use

| Command | When |
|---|---|
| `Atrune: New brief` | Multi-file feature or anything that needs planning |
| `Atrune: Quick task` | Small one-off, single file, ≤ 100 chars |
| `Atrune: Auto-fix current file…` | You're staring at a file that has a bug |
| `Atrune: Review task diff…` | Any completed task with file changes |
| `Atrune: Resume a saved session…` | Coming back to prior work with cache warm |
| `Atrune: Browse installed packs…` | Manage installed packs (install / uninstall) |
| `Atrune: Restart server` | You changed the code in the monorepo and need a fresh server |
| `Atrune: Revoke folder storage` | Clean reset for this folder only |

---

## Minimum-viable session recipe

1. Open folder → click Allow → connect subscription. (~1 min)
2. Think for 5 min: one slice, its files, its acceptance check.
3. Dispatch brief. Watch the Kanban. (~5-10 min agent time.)
4. Review the diff, accept the good hunks, let the bad ones spawn follow-ups.
5. Run your own tests. If green, dispatch the next slice's brief. If red, dispatch a `[quick] fix <symptom>` task.
6. Sessions persist. Come back tomorrow, dispatch the next slice.

That's the whole loop. Everything else is polish.

---

## End-to-end walkthrough

A single continuous demo — *build a URL shortener* — walks through every v2 feature from an empty folder to a shipped feature with follow-up briefs. Lives in its own file so it's easy to open side-by-side while you follow along:

**[→ docs/v2-walkthrough.md](./v2-walkthrough.md)**

Same URL shortener example the plan doc uses. ~10 min on the mock adapter, ~45 min on real Claude, under $2 on Sonnet.

# v2 Extension Test Plan

**Purpose**: end-to-end manual QA covering every v2 feature (S1 → S13) via one small demo project. Each step names the prompt to type, the surface to click, and what you should see. Stop at the first mismatch — a broken step invalidates every step downstream.

**Demo project**: a tiny TODO CLI that shells to a JSON file. Deliberately small so the whole run fits under 15 minutes on the mock adapter and ~30 minutes on a real Claude subscription.

---

## 0 · Prep (do this once, ~2 min)

**0.1** Repackage + install the extension so the latest code is what you're testing:
```bash
cd apps/vscode && \
  /home/nitheesh/Desktop/Monish/GuideAI/node_modules/.bin/tsc -p tsconfig.json && \
  rm -f atruneai-*.vsix && \
  npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository
```
Then in VS Code: `Ctrl+Shift+P` → **Extensions: Uninstall** → uninstall the old Atrune → **Install from VSIX…** → pick the new `atruneai-0.1.0.vsix` → reload window.

**0.2** Pick or create a fresh scratch folder, e.g. `~/Desktop/todo-cli-test`. **Do NOT create `.atrune/` yourself.**

**0.3** Open that folder in VS Code (`File → Open Folder`). Leave the Atrune sidebar visible.

---

## Stage A · Fresh-folder / consent gate (S13 · fixes)

**A.1 · No `.atrune/` gets auto-created**
- Expected: the folder still has zero hidden dirs. Sidebar shows the Welcome view: *"Step 1 — Allow project storage"*.
- ✗ Fail if you see a `.atrune/` folder appear before you click anything.

**A.2 · Click "Allow storage in this folder"**
- Expected: `.atrune/` appears with `.consent.json` inside. Welcome moves to Step 2. Sidebar tree views (Active Work, Progress, Team, etc.) become visible.

**A.3 · Connect a subscription** (skip if already global-connected)
- Click *"Connect a subscription"* → pick Claude → sign in.
- Expected: `.atrune/.subscription-authorized.json` appears. Status bar shows `● GuideAI · ↓0 ↑0 · $0.00 · —`.

---

## Stage B · First brief · Quick-lane (S4)

**B.1 · Dispatch a quick task**
- Command palette → **Atrune: Quick task** (or click *Quick task* in the 🚀 Start sidebar).
- Prompt to type: `fix typo in README.md`
- Expected:
  - Server routes as `pipeline: quick` (single-agent, no Kanban).
  - After ~15s a new markdown tab opens titled "Atrune · quick task" with the agent's answer.
  - Status bar cost ticks up (small amount).
  - `atrune/features/fix-typo-in-readme-md/FEATURE.md` appears with 1 session row.

---

## Stage C · Heavy brief · full pipeline (S3 · S8 · S5 · S6)

**C.1 · Dispatch a heavy brief**
- Command palette → **Atrune: New brief**.
- Prompt to type:
  ```
  Build a small TODO CLI in apps/cli/src/index.ts that supports add, list, done, and delete against a JSON store at ~/.todo.json
  ```
- Expected:
  - Kanban tab opens with **Plan → Implement → Review** columns (three phases only — S3).
  - S8 decomposer seeds 6-10 work items into the Backlog with role hints (planner / coder / reviewer / doc-writer), skill hints, and acceptance stubs.
  - Chat/event feed emits `Selected skill: add-feature` (S5).
  - Chat/event feed emits `session <uuid>… first turn tagged [build-a-small-todo-cli… · user]` (S6).

**C.2 · Watch the pipeline run**
- Expected column progression (auto mode): Plan runs → Implement runs → Review runs. Each phase writes a `.md` under `atrune/briefs/<briefId>/`.
- Status bar tokens increment. Cost stays under a few cents on Sonnet, under a dollar on Opus review.

**C.3 · After the pipeline finishes**
- Expected:
  - `atrune/briefs/<briefId>/plan.md`, `implement.md`, `review.md` all exist.
  - `atrune/PROJECT.md` has the feature row with status `shipped` or `in-progress`.
  - `atrune/features/build-a-small-todo-cli…/FEATURE.md` has a fresh entry in its `## Sessions` table (S6). Outcome column is `✓ shipped` or `⚠ partial` depending on the review artifact.

---

## Stage D · Dependencies (S8)

**D.1 · Try to drag a Backlog card that has unfinished deps**
- Open the Kanban.
- Attempt to move an `Implement <slice>` card to Active BEFORE the corresponding `Scope` card is Done.
- Expected: server refuses with `409 blocked-by-deps`. Extension shows a toast: *"blocked by N upstream task(s)"*.

**D.2 · Mark Scope Done → retry**
- Drag Scope → Done. Try the Implement card again.
- Expected: move succeeds. Card enters Active.

---

## Stage E · Diff review (S9)

**E.1 · Run the review command**
- After the brief finishes, palette → **Atrune: Review task diff (hunk-by-hunk)…** → pick the completed implement task.
- Expected:
  - Webview opens with the file changes as green/red hunks.
  - Each hunk has a checkbox (default: checked).
  - Toolbar: Accept all · Reject all · Apply selection.

**E.2 · Uncheck one hunk → Apply selection**
- Expected:
  - Selected hunks stay on disk unchanged; the unchecked hunk reverts to the base ref.
  - A follow-up review-phase work_item is created (visible in Progress view) titled *"Follow-up: address rejected hunks in <file>"*.

---

## Stage F · Secret-scan hook (S11)

**F.1 · Simulate a bad hunk**
- Open a file the brief touched. Manually add a fake AWS key: `const key = "AKIA1234567890ABCDEF"`. Save.
- Dispatch a small brief that would produce a diff.
- Run **Review task diff…** on the resulting task.
- Try to Apply with the secret-line checked.
- Expected: server returns `409 pre-diff-hook-blocked`. Extension shows *"secret-scan blocked 1 hit(s)"*. Diff webview stays open so you can uncheck the offending hunk.

---

## Stage G · Sessions & resume (S7)

**G.1 · Check the 📂 Features sidebar**
- Expected: shows the two features touched so far (`fix-typo-in-readme-md`, `build-a-small-todo-cli…`) with status dots (✓ shipped / ⚠ partial) and session children carrying their outcome + token counts.

**G.2 · Resume a session**
- Palette → **Atrune: Resume a saved session…** → pick any session UUID.
- Expected: a terminal opens with `claude --resume <uuid>` in the correct cwd. The session's prior conversation is loaded.

**G.3 · Agent-driven resume**
- Dispatch a follow-up quick task on the same feature: `tweak the TODO delete confirmation prompt`
- Expected: event log shows `S7 resume: reusing session <uuid>… · score N · matched delete,confirmation…`. The agent's response builds on prior context (test by asking about something from the earlier session — it should remember).

---

## Stage H · Packs (S12)

**H.1 · Install a local pack**
- Create a temp pack dir:
  ```bash
  mkdir -p /tmp/demo-pack/skills
  cat > /tmp/demo-pack/pack.json <<'EOF'
  { "name":"demo-pack","version":"1.0.0","description":"Test pack","tags":["test"] }
  EOF
  cat > /tmp/demo-pack/skills/write-changelog.md <<'EOF'
  ---
  name: write-changelog
  description: Add a CHANGELOG.md entry.
  appliesTo: implement
  keywords: changelog, release notes, version
  ---
  Runbook: append a dated section under `## Unreleased` with bullet points.
  EOF
  ```
- Palette → **Atrune: Install a pack…** → From local path → `/tmp/demo-pack`
- Expected: sidebar 🛠 Skills & Packs view shows `demo-pack v1.0.0 · 1 skill`. Under `Skills → pack: demo-pack` the `write-changelog` row is visible.

**H.2 · Trigger the pack's skill**
- Dispatch a quick task: `write a changelog entry for the TODO CLI`
- Expected: event log shows `Selected skill: write-changelog (_pack:demo-pack)`.

**H.3 · Uninstall**
- Palette → **Atrune: Browse installed packs…** → pick `demo-pack` → confirm uninstall.
- Expected: pack row disappears; the `write-changelog` skill is no longer in the Skills group.

---

## Stage I · Consent-loss (fix #1)

**I.1 · Simulate `rm -rf .atrune/`**
- In a terminal: `rm -rf <project-folder>/.atrune`.
- Wait ~5 seconds (extension's poll interval).
- Expected:
  - Sidebar tree views empty out or hide (Active Work shows *"No project bound to this folder"*).
  - Open Kanban / Diff-Review / Brief-Composer tabs auto-close.
  - Status bar drops back to `connecting…` briefly then shows the empty state.
  - `~/.guideai/workspaces/<oldId>/` is gone (reaped).
  - `~/.claude/projects/<enc-of-folder>/` is gone (reaped).

**I.2 · Re-grant consent**
- Click *"Allow storage in this folder"* again.
- Expected: fresh `.atrune/`. Every sidebar view shows the empty "no data yet" state — no ghost briefs/sessions/tasks from before the delete.

---

## Stage J · Status bar (S13)

**J.1 · Live spend HUD**
- Expected: while a brief is running, status bar reads `$(sync~spin) GuideAI · ↓Nk ↑Nk · $X.XX · sonnet` and updates every 5s.
- When idle: `● GuideAI · ↓Nk ↑Nk · $X.XX · —`.
- On pending approvals: background flips to warning-yellow and a `· N pending` slot appears.

---

## Reset for a clean re-run

```bash
# Wipe project state
rm -rf <project-folder>/.atrune <project-folder>/atrune

# Wipe global home
rm -rf ~/.guideai/workspaces/*
rm -rf ~/.claude/projects/-<encoded-folder>--*
```

Reopen the folder in VS Code. Should behave like the very first run again (Stage A).

---

## Stage-to-plan reference

| Stage | Feature | Plan section |
|---|---|---|
| A | Consent gate + Welcome view | S13 + this session's fixes |
| B | Quick-task lane | S4 |
| C | 3-phase pipeline + decomposer + skills + sessions | S3 · S5 · S6 · S8 |
| D | Task dependencies | S8 |
| E | Diff review webview | S9 |
| F | Secret-scan hook | S11 |
| G | Sessions view + resume | S7 |
| H | Packs | S12 |
| I | Consent-loss cleanup | This session's fixes |
| J | Status bar HUD | S13 |

If any stage fails, the diff-and-fix loop should target that stage in isolation before continuing downstream.

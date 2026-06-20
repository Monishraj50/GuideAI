# AtruneAI

> Your AI workplace, inside VS Code. Brief your team. Watch the pipeline. Ship.

**AtruneAI** is a multi-agent platform where _you direct, AI executes_. Hire from a catalog of 154 agents, dispatch a brief in plain English, and watch a phase-gated pipeline run with budget caps, cross-vendor sanity checks, and live narration in your status bar.

---

## What's in the extension

### Three sidebar views — interrupt-driven, always-on

| View | Answers |
|---|---|
| 🎯 **Active work** | What's running right now, what phase, with which agents |
| ✅ **Pending** | Tool approvals + queued hires (badge count on the activity-bar icon) |
| 👥 **Team** | Hired agents · right-click to send a direct task |

### Four toolbar actions

- 💬 **New brief** — full-flow brief: discovery → plan → critic gate → 5-phase pipeline
- ⚡ **Quick ask** — single-agent or 3-phase auto-fix; skip the ceremony
- 📦 **Mission Control** — the entire Atrune web UI in a tabbed webview
- ⚙️ **Settings** — open VS Code settings filtered to Atrune

### Status bar — never wonder what's happening

> `🟢 Atrune · your team is writing the code · Add validation · $0.12 · 2 pending`

Four slots: health · live narrator · budget · pending approvals count. Click to open Mission Control.

### Native approval popups

When an agent wants to run a paid or risky tool, you get a real VS Code notification:

> **Atrune wants to run:** `npm install drizzle-orm`
> [ Approve ] [ Deny ] [ Open in Mission Control ]

Tool-aware: Bash / Write / Edit / WebFetch each surface the relevant argument.

### Direct task mode

- **Right-click a file** in the Explorer → **Auto-fix this…**
- **Select code** in the editor → right-click → **Ask agent about this selection**
- Quick-pick agent · type prompt · answer opens as a Markdown editor tab

Both run an abbreviated pipeline. Same budget guardrails as full briefs.

### Six project templates

Start your first brief from a working template:

- Build a website
- Build an API
- Write technical documentation
- Audit security
- Design a UI
- Refactor existing code

### Founder mode (optional)

If "Bash", "verify", and "implement" aren't your daily vocabulary, flip on `atrune.founderMode`:

| Developer mode | Founder mode |
|---|---|
| `building · Add validation` | `your team is writing the code · Add validation` |
| _Atrune wants to use Bash_ | _Atrune wants to run a command_ |

### Onboarding walkthrough

First activation plays a 5-step tour. Re-run anytime: `Atrune: Show me around`.

---

## Getting started

1. **Install** the extension
2. **Open** any folder
3. **Click** the Atrune icon in your activity bar — the extension auto-spawns the server + web on first use
4. **Click** 💬 **New brief**, pick a template, edit the body, dispatch

That's it. The walkthrough will guide you through every other surface.

---

## Requirements

- VS Code ≥ 1.85 (or any compatible fork — Cursor, Windsurf, etc.)
- Node ≥ 20
- The Atrune monorepo at the workspace root (or override via `atrune.repoRoot`)

Optional but recommended:

- **Claude Code CLI** — the default runtime
- **OpenAI API key** — for cross-vendor sanity checks
- **GitHub PAT** — for the deliverables-to-repo flow

---

## Settings

| Key | Default | What it controls |
|---|---|---|
| `atrune.serverPort` | `4000` | Port the Fastify server listens on |
| `atrune.webPort` | `3000` | Port the Next.js dev server listens on |
| `atrune.autoSpawn` | `true` | Auto-spawn server + web on activation if not already running |
| `atrune.repoRoot` | `""` | Path to the Atrune monorepo (auto-detected by default) |
| `atrune.founderMode` | `false` | Plain-English labels in narrator + approval popups |
| `atrune.showCostPreview` | `true` | Modal cost forecast before paid actions |

---

## Commands

- `Atrune: New brief…` — full-flow brief with template picker
- `Atrune: Quick ask…` — chooser between Auto-fix and Ask one agent
- `Atrune: Ask one agent…` — direct task to a specific agent
- `Atrune: Auto-fix this…` — abbreviated 3-phase pipeline
- `Atrune: Ask agent about this selection` — right-click selection in the editor
- `Atrune: Open Mission Control` — full web UI in a tabbed webview
- `Atrune: Switch project…` — change the active workspace
- `Atrune: Refresh sidebar`
- `Atrune: Restart server`
- `Atrune: Show me around` — re-run the walkthrough

---

## Local-first

State lives at `~/.guideai/` on your machine. SQLite + filesystem; no backend service required. Your data, your machine.

---

## License

AGPL-3.0

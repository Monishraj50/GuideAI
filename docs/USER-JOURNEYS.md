# AtruneAI — How real users use it

> Three personas. Three days. One platform.

This is the *user side* of the manual — what does someone actually do with AtruneAI day-to-day, hour-by-hour, click-by-click? Three distinct profiles cover most of the audience; pick the one closest to yours.

---

## The three personas

| Persona | Who they are | Primary surface |
|---|---|---|
| **🛠 Dev** — Priya | Senior engineer, ships code daily, has a Claude subscription, lives in VS Code | VS Code extension + occasional Mission Control |
| **🧑‍💼 Founder** — Marcus | Non-technical founder, no engineering team, wants to build product without learning to code | Cursor + Mission Control (browser) with Founder mode |
| **🎯 CEO** — Anjali | Runs a small startup with one engineer, wants to direct work and watch budget without being in the weeds | Mission Control in browser, status bar in VS Code as a glance |

---

## Onboarding — first 30 minutes (same for everyone)

```
0–5 min     Install
            ├─ npm i -g pnpm
            ├─ git clone … && cd … && pnpm install
            └─ pnpm dev   (server :4000 + web :3000)

5–10 min    Connect integrations (Settings page)
            ├─ Claude   → click "Connect" → claude login (CLI) OR paste Anthropic key
            ├─ OpenAI   → paste key (used for cross-vendor sanity checks)
            └─ GitHub   → either `gh auth login` already, OR paste PAT

10–15 min   Install VS Code extension
            └─ code --install-extension apps/vscode/atruneai-0.1.0.vsix
            └─ Reload VS Code (Ctrl+R)

15–20 min   First-launch walkthrough plays automatically (5 steps)
            ├─ Welcome
            ├─ The sidebar
            ├─ Your first brief
            ├─ Quick ask & auto-fix
            └─ Founder mode

20–30 min   Create your first workspace
            └─ Top bar → "+" → "my-first-project" → it appears in the Switcher
```

By minute 30, you're ready to brief your team. Total cost so far: $0.

---

## 🛠 A day in Priya's life — Dev mode

> *Senior engineer, 8 years experience, dropped into a new codebase she doesn't fully know.*

### 9:00 — Status bar check

Priya opens VS Code on the codebase. Glance at the bottom-right:

> `$(circle-filled) Atrune · idle · 3 agents ready · $0.42`

Three agents already hired from yesterday. $0.42 spent this month. No briefs running. Good.

### 9:05 — Right-click → auto-fix

She spots a bug in `apps/api/src/routes/users.ts` — the duplicate-email check is racy. She right-clicks the file:

→ **Atrune: Auto-fix this…**

Types one sentence:

> *"the duplicate-email check has a race condition; use a database unique constraint instead and surface the constraint error cleanly"*

A cost preview popup appears:

> This task will spend roughly **$0.18** and take about **3 min**. Continue?

She clicks **Continue**.

The status bar narrates:

> `$(sync~spin) Atrune · building · the duplicate-email check… · $0.42`

Two minutes later, an approval popup slides in:

> Atrune wants to run: `pnpm test users.test.ts`
> [Approve] [Deny] [Open in Mission Control]

She clicks **Approve**. The pipeline runs the test, confirms it passes, then opens an untitled Markdown tab with the agent's full response — a summary of what changed, with token + cost + duration in the header.

She switches to the SCM panel, reviews the diff (clean — exactly the change she'd have written), commits.

**Total time: 4 minutes. Total cost: $0.21.**

### 10:30 — Bigger brief: a feature

A product manager asks for a new endpoint. She clicks 💬 **New brief** in the sidebar.

The template picker pops:

```
$(edit) Blank brief    Write your own from scratch
─── Templates ───────
$(server) Build an API           REST or GraphQL API…
$(globe)  Build a website         Marketing site…
…
```

She picks **Build an API**, edits the body to match the spec, hits **Dispatch brief**.

The 5-phase pipeline runs in the background. The status bar narrates each phase. Priya goes back to writing tests in another file.

20 minutes later, a Pending TreeView badge appears: `1`. She clicks → an approval to `git checkout -b feat/users-batch`. Approves. Pipeline finishes. New branch in the repo, tests passing, PR description waiting in Deliverables.

**Total active time on her side: ~2 minutes (the brief writing + the approval). Cost: $0.74.**

### 14:00 — Approval batch

Three more approvals stack up while she's in a meeting. She clears them in 30 seconds from the Pending view by right-clicking each → "Approve". Pipeline continues.

### 17:00 — Push & call it a day

She opens Mission Control briefly (cube icon → toolbar button → browser tab):

- 3 briefs shipped today
- $2.34 spent
- 4 agents hired, 1 retired
- Deliverables tab shows all the artifacts

She clicks "Push to GitHub" on the morning brief → repo updated, issues synced. Closes laptop.

### Priya's daily AtruneAI rhythm

| Time | What she does | Where |
|---|---|---|
| 9 AM | Glance at status bar | VS Code |
| Throughout day | Auto-fix (5–10x), Ask one agent (2–3x) | Right-click menus |
| Mid-morning | One full brief for a feature | Sidebar |
| Continuous | Approve popups as they come | Native notifications |
| End of day | Push to GitHub | Mission Control |

Her keystrokes never leave VS Code unless she's pushing code or wants the dashboard.

---

## 🧑‍💼 A day in Marcus's life — Founder mode

> *Idea person. No engineering background. Has Cursor installed and Founder mode toggled on.*

### Setup (one-time)

Marcus installs Cursor (same as VS Code, friendlier defaults). Installs the AtruneAI extension. **Settings → atrune.founderMode = true**.

The status bar now reads in plain English:

> `Atrune · your team is ready · $0.00`

Not "idle · 3 agents ready". The phrase he understands.

### 10:00 — He has an idea

> "I want a landing page for my coffee subscription service. Hero, three plans, testimonials, signup form."

He clicks 💬 **New brief** in the Atrune sidebar.

The template picker appears. He picks **Build a website**. The body is pre-filled with a sensible template:

```
Build a marketing website with:
- Hero section with a clear value proposition
- Three feature sections
- A pricing page with three tiers
- A contact form that emails me on submit
- Mobile-responsive

Stack: Next.js + Tailwind. Deploy target: Vercel.
```

He edits the body to mention coffee + tier names (Bronze/Silver/Gold) + the testimonials he wrote in his notes app. **Dispatch brief**.

Cost preview pops:

> This brief will spend roughly **$0.85** and take about **8 min**. Continue?

He hits **Continue**.

### 10:01 — He watches the narrator

The status bar starts narrating (Founder mode = plain English):

> `Atrune · your team is drafting a plan · Build a marketing website…`

Two minutes later:

> `Atrune · your team is writing the code · Build a marketing website…`

He has no idea what "phases" or "Vitest" or "Tailwind" mean. He doesn't need to. The narrator tells him *something is happening*.

### 10:08 — Approval pops up

> Atrune wants to **create a file** at `coffee-site/app/page.tsx`. OK?
> [Approve] [Deny] [Open in Mission Control]

The word "Bash" became "run a command". "Write" became "create a file". Founder mode in action.

He approves.

### 10:12 — Done

A native notification:

> Brief dispatched. Files delivered to `coffee-site/`. [Open Mission Control]

He clicks **Open Mission Control** — browser tab opens with:

- The deliverables (a working Next.js project)
- A live preview iframe (his actual coffee site!)
- A validation report showing tests passed + Lighthouse score
- Cost breakdown: $0.78

He drags the `coffee-site/` folder onto Vercel's deploy page. The site is live in 90 seconds.

**Marcus shipped a marketing website in ~15 minutes. He typed ~80 words of English. He approved 3 popups. He never wrote a line of code.**

### 14:00 — Iterating

The hero copy isn't quite right. He clicks ⚡ **Quick ask** → **Ask one agent** → picks the **Copywriter** from the team → types: *"the hero subheading sounds boring; give me 5 punchier options that emphasize ethically-sourced beans."*

Markdown tab opens with 5 options. He picks one, copies it into the page (Cursor's AI helps him with the file edit — both tools complementing each other).

### 17:00 — End of day digest

The next morning, a daily digest lands at `~/.guideai/digests/2026-06-20.md`:

> **Yesterday: Marketing site for Bronze Coffee Co**
> - 1 brief shipped · $0.78
> - 1 direct task (copy variations) · $0.04
> - Live site deployed to bronzecoffee.vercel.app
> - 3 agents on the team: UX designer, frontend developer, copywriter

### Marcus's daily AtruneAI rhythm

| Time | What he does | How |
|---|---|---|
| Whenever inspiration hits | Write a brief in plain English | Sidebar → New brief |
| Mid-flow | Pick a template if his idea fits one | Picker |
| As popups appear | Approve in plain English | Native notifications |
| When done | Drag the folder onto Vercel | Manual |
| Next morning | Read the digest | Markdown file |

He never opens a terminal. He never reads code. He never picks an agent unless he wants to.

---

## 🎯 A day in Anjali's life — CEO mode

> *Runs a 3-person startup. One eng (Priya from above). Wants to direct work and watch the budget without being a manager.*

### 9:00 — Morning standup

Anjali opens Mission Control in her browser (no VS Code needed for this view). The Dashboard page shows:

- **5 briefs active** across her two workspaces (`product` and `internal-tools`)
- **$12.40 spent this week** (cap: $50)
- **2 approvals pending** (1 in product, 1 in internal-tools)

She clicks each pending approval. One is Priya's auto-fix from yesterday she didn't get to. She approves. The other is a `gh repo create` for a new internal tool — she approves.

### 9:15 — Direction-setting

She doesn't write briefs herself. She writes **a brief that hires the team to write the brief**.

> *"Plan the Q3 roadmap for the product. 3 themes max, each with 2-3 features, each estimated in dev-weeks. Output as a one-page PDF + a synced Linear project."*

She picks the **Write technical documentation** template, edits, dispatches.

The narrator updates. She closes the browser, makes coffee.

### 9:45 — Plan review

A notification (browser push): plan ready for review. She opens the plan-review modal:

- 3 critic verdicts (2 approve, 1 says "scope feels ambitious for one quarter")
- A second-opinion from a cross-vendor reviewer agrees
- The critique is actionable: drop one theme or extend to 4 months

She approves the plan but adds a note: *"go with 2 themes, defer the third."* Pipeline continues.

### 11:00 — The team is working

She glances at the Org page:

- **8 agents hired** across both workspaces
- **3 working**, 5 idle
- The Tech Lead is in the middle of estimating
- The Designer is mocking up a feature

She doesn't interrupt. She closes the browser.

### 14:00 — Quick check on the budget

Top bar's budget HUD:

> `$24.18 / $50 today`

She's at 48% of the day's cap, with the bulk of the day's work done. Healthy.

### 17:00 — Deliverables review

Two outputs land:

1. The Q3 roadmap PDF in Deliverables — she opens it, reviews, edits one line via Quick ask
2. A Linear project synced with 12 tickets, assigned to Priya for review

She marks the brief complete. The agents who finished their work are retired automatically.

### 18:00 — Daily digest

Same digest format as Marcus. Anjali reads it on the train home.

### Anjali's daily AtruneAI rhythm

| Time | What she does | Where |
|---|---|---|
| Morning | Clear approvals + budget glance | Mission Control |
| Mid-morning | Dispatch 1–2 direction-setting briefs | Mission Control |
| Mid-day | Plan reviews (most important act) | Plan review modal |
| End of day | Check Deliverables; close completed briefs | Mission Control |
| Train home | Read the digest | Inbox or file |

She never installs the VS Code extension. Browser is enough.

---

## What all three users do the same

| Action | Frequency | Time per action |
|---|---|---|
| **Brief intake** | 1–5x/day | 30s–5min |
| **Approve / Deny** | Many | 2–5s each |
| **Plan review** | 1–3x/day | 1–5min |
| **Read deliverables** | After each brief | varies |
| **Check budget** | Glance, continuously | <1s |

The differences are in **how** they do each:

| Action | Dev | Founder | CEO |
|---|---|---|---|
| Brief intake | Sidebar, often via right-click context | Sidebar with templates | Mission Control composer |
| Approve | Native popup, 1 keystroke | Native popup, plain English | Mission Control list |
| Plan review | Quick glance + accept | Trusts the system mostly | Reads critic verdicts carefully |
| Deliverables | Reviews in editor | Drags folder somewhere | Reads the PDF |
| Budget | Glance at status bar | Not their concern | Watches the HUD daily |

---

## The "where do I start?" decision tree

```
                  Do you write code regularly?
                          /     \
                       Yes      No
                       /         \
                  Open VS Code   Are you the boss / decision-maker?
                  Install extn.     /     \
                  Use sidebar    Yes      No
                                 /         \
                             Browser only    Founder mode
                             Mission Control on; Cursor + sidebar;
                             Approve + direct  templates for everything
                             via the dashboard
```

| Your situation | Start here |
|---|---|
| "I'm a dev who wants AI to do the boring parts" | **Priya's flow** — VS Code extension + right-click + sidebar |
| "I'm a founder/PM who wants to ship software without engineers" | **Marcus's flow** — Cursor + Founder mode + templates |
| "I direct a team and want to watch the work, not do it" | **Anjali's flow** — Mission Control browser tab + plan reviews + budget |
| "I want all three" | Run them in sequence over your first week — most users settle into one |

---

## Common rituals — quick reference

### The 30-second daily standup

1. Open Mission Control
2. Pending approvals → clear them
3. Budget HUD → still in the green?
4. Active briefs → any stuck?

Total: 30 seconds. Do this 3x/day.

### The "I have an idea" loop

1. 💬 New brief
2. Pick a template (or blank)
3. Edit the body — be specific about success criteria
4. Cost preview → continue
5. Tab away; come back when the narrator says "done"
6. Read the deliverables
7. Decide: ship as-is, iterate via a follow-up brief, or roll back

### The "this one file is broken" loop (Dev only)

1. Right-click the file
2. **Atrune: Auto-fix this…**
3. Type the symptom in one sentence
4. Cost preview → continue
5. Wait 2–5 min
6. Review diff in SCM panel
7. Commit or reject

### The "I need design options" loop

1. ⚡ Quick ask → **Ask one agent**
2. Pick the Designer from the roster
3. Type the design problem
4. Markdown tab opens with options
5. Pick one; iterate via a follow-up if needed

---

## The trust ramp — how users grow into AtruneAI

```
Week 1 — TESTING
  → Run small briefs ($1 each)
  → Approve every single thing manually
  → Read every deliverable
  → Get a feel for the rhythm

Week 2 — DELEGATING
  → Larger briefs ($2-5)
  → Set up auto-approve rules for safe tool calls (Read, basic Bash)
  → Skip critic gate reading; trust the verdicts
  → Tab away during runs

Week 3 — DIRECTING
  → Multi-brief campaigns ($10-20)
  → Run unattended; check digest in the morning
  → Custom workspaces per project
  → GitHub push automated via the integration

Week 4+ — SCALING
  → Multiple workspaces in parallel
  → Daily budget caps tuned ($20-100/day)
  → Founder mode if you bring non-tech teammates in
  → Templates customized for your domain
```

The platform earns trust progressively. Week 1 is hand-on-the-wheel. By week 4, you're directing a team.

---

## Anti-patterns — what NOT to do

- **Briefing without success criteria** → the team builds the wrong thing. Always state what "done" looks like.
- **Approving without reading the popup** → eventually you'll approve something destructive. Read the message; it's two seconds.
- **Skipping the cost preview** → your $5/day plan becomes a $50 surprise. Leave the toggle on for the first month at least.
- **Hiring 20+ agents in one workspace** → the round-table becomes noisy. 4–6 is the sweet spot.
- **One workspace for everything** → context collisions. One workspace per project.
- **Ignoring the killswitch** → if a pipeline misbehaves, kill it. The state is recoverable. No need to suffer.

---

## Pricing reality

Approximate Anthropic API costs (your mileage will vary):

| Action | Typical cost |
|---|---|
| Small auto-fix (1 file, 1 agent) | $0.10–$0.30 |
| Quick ask to one agent (a few hundred words) | $0.05–$0.15 |
| Small brief (5-phase pipeline, simple task) | $0.50–$1.50 |
| Medium brief (multi-file feature) | $1.50–$5.00 |
| Large brief (full app from scratch) | $5.00–$15.00 |
| Security-tagged brief (pass@3 + cross-vendor) | 2–3× the base cost |

A solo dev using AtruneAI daily lands around **$30–$100/month** in API costs. A founder shipping one site = **$1–$3 one-time**. A team running 5 briefs/day = **$200–$500/month**.

Set caps that match your appetite.

---

## When AtruneAI is wrong for you

Honest list:

- **You need offline / air-gapped operation.** AtruneAI calls hosted APIs. There's no offline mode in v1.
- **Your work is highly visual / artistic** (logo design, animation). Text-driven AI is weaker here. Use Midjourney + a designer.
- **You need real-time collaboration with humans on the same brief.** AtruneAI is solo-user-driven. Multiplayer is v2+.
- **You distrust AI outputs and want to write every line yourself.** Don't use it. Use Copilot for autocomplete only.
- **Your codebase is enormous (>1M LOC) and not well-organized.** The discovery phase may hallucinate. Refactor first, AtruneAI second.

---

## The one-paragraph summary

**AtruneAI is a team you direct in plain English.** You write what you want, the system hires the right agents, runs a phase-gated pipeline with budget guardrails, surfaces approvals as native VS Code popups, and ships deliverables. Devs use it from VS Code; founders use it from Cursor with Founder mode; CEOs use it from a browser dashboard. The same platform, three workflows, one bill at the end of the month.

Pick the persona that fits, follow the daily rhythm, and within a week the rhythm becomes second nature.

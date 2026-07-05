---
name: refactor-function
description: Restructure a function or module for clarity without changing behaviour.
appliesTo: plan, implement, review
keywords: refactor, cleanup, simplify, restructure, rename, extract, dry, tidy
---

Runbook:
1. Read every caller before touching the function.
2. Run the existing tests. If none, write one for the current behaviour first (characterization test).
3. Refactor in small commits: rename → extract → inline → move. One kind of edit per commit.
4. Re-run tests after each edit. Never batch two structural changes.
5. Preserve the public signature unless the brief explicitly allows breaking it.

Report: what changed, what stayed the same, and the test evidence.

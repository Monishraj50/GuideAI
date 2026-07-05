---
name: add-feature
description: Add a small user-visible feature end-to-end (spec → code → test → doc).
appliesTo: plan, implement, review
keywords: add, feature, endpoint, page, component, implement, build, new
---

Runbook:
1. Restate the feature in one sentence + list the acceptance checks.
2. Find the natural insertion point: existing module, existing route, existing component.
3. Implement the smallest slice that satisfies the checks. Do not scope-creep.
4. Wire tests that assert each acceptance check.
5. Update the nearest doc surface (README section, walkthrough page, or docstring).

Report: the acceptance checks and the code + test + doc that satisfy each.

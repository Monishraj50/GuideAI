---
name: fix-bug
description: Reproduce a reported bug, isolate the root cause, patch, and add a regression test.
appliesTo: plan, implement, review
keywords: bug, fix, broken, crash, error, regression, exception, throws
---

Runbook:
1. Reproduce the bug. If no repro is given, ask for the exact input / steps.
2. Bisect: find the smallest change that turns green into red (or vice versa).
3. Explain the root cause in one paragraph. Do NOT patch before the cause is clear.
4. Apply the minimal fix at the root — not at the symptom site.
5. Add a regression test that fails without the fix and passes with it.

Report: root cause + patched file(s) + regression test path.

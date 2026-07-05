---
name: debug
description: Investigate a failure whose cause is unknown — trace, not patch.
appliesTo: plan, review
keywords: debug, investigate, trace, why, root cause, stack, log, print
---

Runbook:
1. Restate the observed symptom and the expected behaviour in one line each.
2. Gather evidence: exact error message, minimal repro, relevant log lines, recent commits.
3. Form ONE hypothesis at a time. Test it by adding a print / assertion / breakpoint — not by changing production code.
4. When evidence contradicts the hypothesis, discard it and form a new one. Don't accumulate patches.
5. Only propose a fix once the root cause is proven. Hand off the fix to `fix-bug` or the user.

Report: hypothesis chain (each with evidence), the confirmed root cause, and the recommended fix — but do not apply it here.

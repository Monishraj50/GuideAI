---
name: review-code
description: Review a diff or file for correctness, security, and clarity.
appliesTo: review
keywords: review, audit, critique, feedback, code review, security, pr
---

Runbook:
1. Read the brief and any linked issue / spec before opening the diff.
2. First pass: correctness. Does it do what the brief asked? Any obvious bugs, race conditions, resource leaks?
3. Second pass: security. Untrusted input handling, auth checks, secret exposure, injection.
4. Third pass: clarity. Naming, function length, coupling, unnecessary abstraction, missing tests.
5. Cite findings by `file:line`. Rank by severity: blocker / high / medium / nit.

Report: verdict (approve / request-changes) + a ranked findings list.

---
name: add-test
description: Write a unit test for an existing function or module.
appliesTo: plan, implement, review
keywords: test, spec, jest, vitest, mocha, unit test, coverage, parseDate
---

Runbook:
1. Locate the target function; note its signature and current callers.
2. Pick the project's existing test framework (grep for `describe(`, `it(`, `test(`).
3. Write a test file next to the source (`foo.test.ts` next to `foo.ts`) unless the repo puts tests under `tests/`.
4. Cover the happy path plus 1–2 edge cases (empty input, invalid input, boundary).
5. Run the test suite. If red, iterate. If green, stop.

Report: the test file path and the count of new cases.

---
name: extract-function
description: Pull a chunk of inline code out into a named function.
appliesTo: plan, implement
keywords: extract, function, method, helper, dry, duplicated
---

Runbook:
1. Identify the block to extract. Note its inputs (captured variables) and outputs (return + side effects).
2. Give the new function an intention-revealing name (verb + noun).
3. Replace the block with a call to the new function. Ensure the type checker still passes.
4. If the block appears in multiple places, extract once and replace each. If they diverge, do not force-share.
5. Run the tests for every touched call site.

Report: new function signature + list of call sites now delegating to it.

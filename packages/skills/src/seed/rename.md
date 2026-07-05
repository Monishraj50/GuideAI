---
name: rename
description: Rename a symbol (variable, function, class, file) safely across the repo.
appliesTo: plan, implement
keywords: rename, alias, renaming, identifier, symbol
---

Runbook:
1. Grep every reference — imports, docstrings, tests, config strings.
2. If the symbol crosses a public boundary (exported / referenced externally), stop and confirm with the user.
3. Update all references atomically. Prefer language server rename over hand edits when available.
4. Run the type checker + full test suite.
5. Update any doc snippets that named the old identifier.

Report: old → new name + count of references updated + tests still passing.

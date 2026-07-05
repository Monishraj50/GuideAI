---
name: format
description: Reformat a file to match the repo's style tooling.
appliesTo: implement
keywords: format, prettier, eslint, black, gofmt, rustfmt, style, indentation, whitespace
---

Runbook:
1. Detect the formatter in use: check `package.json` scripts, `.prettierrc`, `.editorconfig`, `pyproject.toml`, etc.
2. If no formatter is configured, ask the user before adding one — this is a repo-wide choice.
3. Run the formatter over the target file(s) only. Do NOT reformat the whole repo unless the brief asks for it.
4. Commit only whitespace / stylistic changes. If the formatter suggests semantic changes, surface them separately.

Report: formatter used, files touched, line-count delta.

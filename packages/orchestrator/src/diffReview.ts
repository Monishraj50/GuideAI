// S9 · Diff review — per-task hunk-level accept/reject.
//
// When a task moves to `done`, we compute `git diff <baseGitRef>` and split
// it into hunks. The user then accepts a subset via the diffReview webview;
// only those hunks land on disk. Rejected hunks are reverted to their base
// state and can spawn a follow-up work_item so the work isn't silently lost.
//
// Design notes:
//   - Parses standard unified-diff output — the same format `git diff` emits
//     and `git apply` consumes.
//   - Hunk selection is applied by REVERTING the rejected hunks (git apply -R
//     with only those hunks in the patch). This preserves accepted hunks
//     already on disk without needing to re-materialize them.
//   - Binary changes are exposed as a single opaque "hunk" per file; toggling
//     just reverts the whole file. We surface a flag so the UI can render
//     appropriately.
//
// Everything here is pure Node — no VS Code / Fastify dependency — so the
// server + tests can call it directly.

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export interface Hunk {
  /** Stable id (assigned at parse time, safe to round-trip through the UI). */
  id: string;
  file: string;
  /** Original hunk header line, e.g. `@@ -12,7 +12,9 @@ function foo() {` */
  header: string;
  /** Raw hunk body — the `+`/`-`/` ` lines. Ends without a trailing newline. */
  body: string;
  /** Full patch fragment reconstructable to a valid unified diff (file
   *  header + this hunk only). Fed to `git apply` for revert. */
  patchFragment: string;
  /** True when this "hunk" represents an all-or-nothing binary change. */
  binary: boolean;
  addedLines: number;
  removedLines: number;
}

export interface HunkFile {
  file: string;
  oldPath: string;
  newPath: string;
  hunks: Hunk[];
  binary: boolean;
}

/** Run `git diff <base>` in `cwd` and split its output into files × hunks. */
export function extractHunks(args: { cwd: string; base: string }): HunkFile[] {
  const { cwd, base } = args;
  const raw = execSync(`git diff --no-color --no-ext-diff ${JSON.stringify(base)}`, {
    cwd, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
  }).toString();
  return parseDiff(raw);
}

/** Parse a raw unified-diff blob into files × hunks. Exported for tests. */
export function parseDiff(raw: string): HunkFile[] {
  if (!raw.trim()) return [];
  const files: HunkFile[] = [];

  // Split on `diff --git ` boundaries. First segment before the first
  // boundary is empty.
  const parts = raw.split(/^diff --git /m).slice(1);
  for (const part of parts) {
    // First line is `a/foo b/bar`. Header block ends at the first line
    // starting with `@@ ` (hunk header) or `Binary files ` (binary marker).
    const lines = part.split('\n');
    const [oldPath, newPath] = parsePathHeader(lines[0] ?? '');

    let bodyStart = 1;
    let binary = false;
    while (bodyStart < lines.length) {
      const l = lines[bodyStart]!;
      if (l.startsWith('@@ ')) break;
      if (l.startsWith('Binary files ')) { binary = true; break; }
      bodyStart++;
    }
    const filePreamble = 'diff --git ' + lines.slice(0, bodyStart).join('\n');

    const file: HunkFile = {
      file: newPath || oldPath, oldPath, newPath, binary, hunks: [],
    };

    if (binary) {
      file.hunks.push({
        id: `hunk-${randomUUID().slice(0, 8)}`,
        file: file.file, header: '(binary)', body: lines[bodyStart] ?? '',
        patchFragment: filePreamble + '\n' + (lines[bodyStart] ?? '') + '\n',
        binary: true, addedLines: 0, removedLines: 0,
      });
      files.push(file);
      continue;
    }

    // Group subsequent lines into hunks, each opened by an `@@ ` line.
    let i = bodyStart;
    while (i < lines.length) {
      if (!lines[i]!.startsWith('@@ ')) { i++; continue; }
      const header = lines[i]!;
      const bodyLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('@@ ')
             && !lines[i]!.startsWith('diff --git ')) {
        bodyLines.push(lines[i]!);
        i++;
      }
      // Trim any trailing empty line the split introduced.
      while (bodyLines.length && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();
      const body = bodyLines.join('\n');
      const added = bodyLines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
      const removed = bodyLines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
      file.hunks.push({
        id: `hunk-${randomUUID().slice(0, 8)}`,
        file: file.file, header, body,
        patchFragment: filePreamble + '\n' + header + '\n' + body + '\n',
        binary: false, addedLines: added, removedLines: removed,
      });
    }

    files.push(file);
  }
  return files;
}

function parsePathHeader(line: string): [string, string] {
  // `a/foo/bar b/foo/bar` — split on the first ` b/` after a leading `a/`.
  const m = /^a\/(.+?) b\/(.+)$/.exec(line.trim());
  if (m) return [m[1]!, m[2]!];
  return [line.trim(), line.trim()];
}

// ─── apply selection ────────────────────────────────────────

export interface ApplyResult {
  applied: string[];
  reverted: string[];
  failed: Array<{ hunkId: string; error: string }>;
}

/**
 * Given the full set of hunks and an accepted subset (by id), revert the
 * rest. On success `applied` = accepted hunk ids, `reverted` = the rest,
 * `failed` = anything git-apply couldn't cleanly reverse (leaves those on
 * disk unchanged and reports).
 */
export function applyHunkSelection(args: {
  cwd: string;
  hunks: Hunk[];
  acceptedIds: string[];
}): ApplyResult {
  const accepted = new Set(args.acceptedIds);
  const rejected = args.hunks.filter((h) => !accepted.has(h.id));
  const applied: string[] = args.hunks.filter((h) => accepted.has(h.id)).map((h) => h.id);
  const reverted: string[] = [];
  const failed: ApplyResult['failed'] = [];

  if (rejected.length === 0) {
    return { applied, reverted, failed };
  }

  // Group rejects by file so we build one reverse-patch per file — safer
  // than N single-hunk applications (which mis-count offsets after each).
  const byFile = new Map<string, Hunk[]>();
  for (const h of rejected) {
    if (!byFile.has(h.file)) byFile.set(h.file, []);
    byFile.get(h.file)!.push(h);
  }

  for (const [file, fileHunks] of byFile) {
    // Binary revert: just `git checkout <base> -- file`. The base ref isn't
    // known to this function; callers pass a HEAD-based patch fragment where
    // possible. Fall back to checkout HEAD.
    if (fileHunks.some((h) => h.binary)) {
      try {
        execSync(`git checkout HEAD -- ${JSON.stringify(file)}`, {
          cwd: args.cwd, stdio: ['ignore', 'pipe', 'pipe'],
        });
        reverted.push(...fileHunks.map((h) => h.id));
      } catch (err: any) {
        for (const h of fileHunks) failed.push({ hunkId: h.id, error: String(err?.message ?? err) });
      }
      continue;
    }

    // Text hunks: synthesize a patch with just these hunks and apply -R.
    const preambleMatch = /^diff --git [\s\S]*?(?=@@ )/.exec(fileHunks[0]!.patchFragment);
    const preamble = preambleMatch?.[0] ?? '';
    const patch = preamble + fileHunks.map((h) => `${h.header}\n${h.body}\n`).join('');

    const tmp = path.join(os.tmpdir(), `atrune-revert-${randomUUID()}.patch`);
    fs.writeFileSync(tmp, patch);
    const r = spawnSync('git', ['apply', '--reverse', '--recount', '--whitespace=nowarn', tmp], {
      cwd: args.cwd, stdio: ['ignore', 'pipe', 'pipe'],
    });
    fs.unlinkSync(tmp);
    if (r.status === 0) {
      reverted.push(...fileHunks.map((h) => h.id));
    } else {
      const err = (r.stderr?.toString() ?? '').trim() || `git apply exit ${r.status}`;
      for (const h of fileHunks) failed.push({ hunkId: h.id, error: err });
    }
  }

  return { applied, reverted, failed };
}

// Claude Code's interactive `--resume` picker only lists sessions that
// "look interactive". SDK sessions (the orchestrator's
// `claude --session-id <uuid> -p "..."` invocations) miss two markers
// that the picker uses to filter:
//
//   1. The file MUST start with `{"type":"mode"...}` — SDK files start
//      with `{"type":"queue-operation"...}` instead.
//   2. The first `type:"user"` record's metadata MUST claim it came from
//      a typed prompt — SDK records show `entrypoint:"sdk-cli"` +
//      `promptSource:"sdk"` which the picker filters out. Interactive
//      records use `entrypoint:"cli"` + `promptSource:"typed"`.
//
// We patch both so the picker shows them. Claude tolerates the edits on
// resume (verified — round-trip resume returns the correct reply).

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

function encodeCwd(cwd: string): string {
  return cwd.replace(/[/\\]/g, '-');
}

function jsonlPath(cwd: string, sessionId: string): string {
  return path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd), `${sessionId}.jsonl`);
}

export function normalizeSessionJsonl(args: { cwd: string; sessionId: string }): { changed: boolean; path: string } {
  const file = jsonlPath(args.cwd, args.sessionId);
  if (!fs.existsSync(file)) return { changed: false, path: file };

  let original: string;
  try { original = fs.readFileSync(file, 'utf8'); } catch { return { changed: false, path: file }; }

  // 1. Rewrite SDK metadata to interactive metadata on every line.
  //    Idempotent — already-interactive files have no sdk-cli/sdk markers.
  let patched = original
    .replace(/"entrypoint":"sdk-cli"/g, '"entrypoint":"cli"')
    .replace(/"promptSource":"sdk"/g, '"promptSource":"typed"');

  // 2. Inspect the leading record. If it's not already `type:"mode"`,
  //    prepend the two-line header an interactive session writes.
  const firstLine = patched.split('\n', 1)[0] ?? '';
  let firstType: string | null = null;
  try { firstType = (JSON.parse(firstLine) as any)?.type ?? null; } catch {}
  if (firstType !== 'mode') {
    patched =
      `{"type":"mode","mode":"normal","sessionId":"${args.sessionId}"}\n` +
      `{"type":"permission-mode","permissionMode":"default","sessionId":"${args.sessionId}"}\n` +
      patched;
  }

  if (patched === original) return { changed: false, path: file };
  try { fs.writeFileSync(file, patched); return { changed: true, path: file }; }
  catch { return { changed: false, path: file }; }
}

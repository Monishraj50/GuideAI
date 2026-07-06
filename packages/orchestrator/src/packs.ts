// S12 · Pack system.
//
// A "pack" is a bundle of skills / agents / hooks the user opts into with
// `guideai pack install <name>`. Packs live at `~/.guideai/packs/<name>/`:
//
//   pack.json                — manifest (name, version, requires, tags, ...)
//   skills/*.md              — skill runbooks, same shape as _seed/ skills
//   agents/*.json            — catalog agents (future — schema TBD)
//   hooks/*.js               — future orchestrator hooks
//
// Install sources:
//   { fromPath: '/abs/local/dir' }  → copied recursively (offline / dev / test)
//   { fromGitUrl: 'https://…git' }  → `git clone --depth 1`
//   { fromName: 'dev-skills-pro' }  → resolves via registry (future) → git url
//
// `requires` block in pack.json:
//   { tools: ['docker'], files: ['Dockerfile'], runtime: '>=18.0.0' }
// If any requirement fails, the pack is still LISTED (with `hasMissingReqs:
// true` + a `missing: [...]` array) but its skills are silently filtered out
// of pickSkill — so a bad-fit pack doesn't derail routing.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { paths } from '@guideai/shared/paths';

export interface PackRequires {
  /** Executables that must be on PATH (`which <tool>`). */
  tools?: string[];
  /** Glob-ish patterns; any match under `cwd` counts. Only checked when a cwd
   *  is passed to listPacks — otherwise skipped. */
  files?: string[];
  /** Node semver range (e.g. `>=18.0.0`). Best-effort — we compare with
   *  process.versions.node. */
  runtime?: string;
}

export interface PackManifest {
  name: string;
  version: string;
  description?: string;
  requires?: PackRequires;
  skills?: string[];   // filenames relative to skills/ (metadata only; scanning still uses dir)
  agents?: string[];
  hooks?: string[];
  tags?: string[];
}

export interface InstalledPack {
  name: string;
  manifest: PackManifest;
  path: string;
  installedAt: number;
  hasMissingReqs: boolean;
  missing: string[];
  skillCount: number;
}

// ─── manifest validation ──────────────────────────────────

const NAME_RE = /^[a-z][a-z0-9-]{1,60}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;

export function validateManifest(m: any): { ok: true; manifest: PackManifest } | { ok: false; error: string } {
  if (!m || typeof m !== 'object') return { ok: false, error: 'manifest is not an object' };
  if (typeof m.name !== 'string' || !NAME_RE.test(m.name)) {
    return { ok: false, error: `invalid name (want lowercase-kebab, 2-60 chars): ${JSON.stringify(m.name)}` };
  }
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) {
    return { ok: false, error: `invalid version (want semver x.y.z): ${JSON.stringify(m.version)}` };
  }
  // Optional arrays.
  for (const k of ['skills', 'agents', 'hooks', 'tags'] as const) {
    if (m[k] !== undefined && !Array.isArray(m[k])) return { ok: false, error: `${k} must be an array` };
  }
  if (m.requires && typeof m.requires !== 'object') return { ok: false, error: 'requires must be an object' };
  return { ok: true, manifest: m as PackManifest };
}

// ─── requires satisfaction ────────────────────────────────

export function checkRequires(req: PackRequires | undefined, opts?: { cwd?: string }): string[] {
  const missing: string[] = [];
  if (!req) return missing;
  for (const t of req.tools ?? []) {
    try {
      execSync(`command -v ${JSON.stringify(t)}`, { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch { missing.push(`tool:${t}`); }
  }
  if (opts?.cwd && req.files) {
    for (const f of req.files) {
      const hit = tryGlobMatch(opts.cwd, f);
      if (!hit) missing.push(`file:${f}`);
    }
  }
  if (req.runtime) {
    const cur = process.versions.node;
    if (!satisfiesRuntime(cur, req.runtime)) missing.push(`runtime:${req.runtime} (have ${cur})`);
  }
  return missing;
}

function tryGlobMatch(cwd: string, pattern: string): boolean {
  // Two forms we handle: literal path or `dir/*` / `**/*.ext`. Anything else
  // is treated as literal. Avoids pulling minimatch — packs shouldn't need
  // sophisticated globs.
  if (!pattern.includes('*')) return fs.existsSync(path.join(cwd, pattern));
  // Depth-1 dir/*: check any child exists.
  const [dir, rest] = pattern.split('/*', 2);
  if (rest === '') return fs.existsSync(path.join(cwd, dir!)) && fs.readdirSync(path.join(cwd, dir!)).length > 0;
  // Fallback: file with an extension somewhere in the tree — walk shallowly.
  const ext = pattern.match(/\.([A-Za-z0-9]+)$/)?.[1];
  if (!ext) return false;
  function walk(dir: string, depth: number): boolean {
    if (depth > 3) return false;
    if (!fs.existsSync(dir)) return false;
    for (const e of fs.readdirSync(dir)) {
      const p = path.join(dir, e);
      const st = fs.statSync(p);
      if (st.isFile() && e.endsWith('.' + ext)) return true;
      if (st.isDirectory() && walk(p, depth + 1)) return true;
    }
    return false;
  }
  return walk(cwd, 0);
}

function satisfiesRuntime(current: string, range: string): boolean {
  // Very shallow: only ">=x.y.z" and "^x.y.z" (major-match) supported.
  const m = /^(?:\^|>=)?(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (!m) return true;
  const [cma, cmi, cpa] = current.split('.').map(Number) as [number, number, number];
  const [rma, rmi, rpa] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (range.startsWith('^')) return cma === rma;
  // >= or unprefixed → straight comparison
  if (cma !== rma) return cma > rma;
  if (cmi !== rmi) return cmi > rmi;
  return cpa >= rpa;
}

// ─── list ─────────────────────────────────────────────────

export function listPacks(opts?: { cwd?: string }): InstalledPack[] {
  const root = paths.packs;
  if (!fs.existsSync(root)) return [];
  const out: InstalledPack[] = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    const manifestPath = path.join(dir, 'pack.json');
    if (!fs.existsSync(manifestPath)) continue;
    let m: PackManifest;
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const v = validateManifest(raw);
      if (!v.ok) continue;
      m = v.manifest;
    } catch { continue; }
    const missing = checkRequires(m.requires, opts);
    const skillCount = countSkillFiles(dir);
    out.push({
      name: m.name,
      manifest: m,
      path: dir,
      installedAt: (() => { try { return fs.statSync(manifestPath).mtimeMs; } catch { return 0; } })(),
      hasMissingReqs: missing.length > 0,
      missing,
      skillCount,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function countSkillFiles(packDir: string): number {
  const s = path.join(packDir, 'skills');
  if (!fs.existsSync(s)) return 0;
  return fs.readdirSync(s).filter((f) => f.endsWith('.md')).length;
}

// ─── install ─────────────────────────────────────────────

export interface InstallArgs {
  fromPath?: string;
  fromGitUrl?: string;
  /** Overwrite an existing install of the same name. Default false. */
  force?: boolean;
}

export function installPack(args: InstallArgs): InstalledPack {
  if (!args.fromPath && !args.fromGitUrl) throw new Error('installPack: fromPath or fromGitUrl required');
  fs.mkdirSync(paths.packs, { recursive: true });

  // 1. Materialize under a temp dir so validation runs on isolated content.
  const staging = fs.mkdtempSync(path.join(paths.packs, '.staging-'));
  try {
    if (args.fromPath) {
      copyDirRecursive(args.fromPath, staging);
    } else {
      execSync(`git clone --depth 1 --quiet ${JSON.stringify(args.fromGitUrl!)} ${JSON.stringify(staging)}`, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Strip .git so we don't drag remote history into ~/.guideai/packs/.
      const gitDir = path.join(staging, '.git');
      if (fs.existsSync(gitDir)) fs.rmSync(gitDir, { recursive: true, force: true });
    }

    // 2. Validate manifest.
    const manifestPath = path.join(staging, 'pack.json');
    if (!fs.existsSync(manifestPath)) throw new Error('pack.json is missing');
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const v = validateManifest(raw);
    if (!v.ok) throw new Error(`pack.json: ${v.error}`);
    const manifest = v.manifest;

    // 3. Move into final slot. If a same-name install already exists we only
    //    overwrite when force=true — protects the user's local edits.
    const target = path.join(paths.packs, manifest.name);
    if (fs.existsSync(target)) {
      if (!args.force) throw new Error(`pack "${manifest.name}" already installed; pass force to overwrite`);
      fs.rmSync(target, { recursive: true, force: true });
    }
    fs.renameSync(staging, target);

    // 4. Return a fresh listing entry.
    return listPacks().find((p) => p.name === manifest.name)!;
  } catch (err) {
    // Clean up staging on failure so we don't leak half-installed dirs.
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    throw err;
  }
}

function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

// ─── uninstall ───────────────────────────────────────────

export function uninstallPack(name: string): { ok: boolean; removed: string | null } {
  if (!NAME_RE.test(name)) return { ok: false, removed: null };
  const dir = path.join(paths.packs, name);
  if (!fs.existsSync(dir)) return { ok: false, removed: null };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, removed: dir };
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '@guideai/shared/paths';

export { promoteSkillFromTrace, type PromoteArgs, type PromotedSkill } from './promote.js';
export { pickSkill, scoreSkillFor } from './pickSkill.js';
export { renderSkillAsRunbook } from './invoke.js';

/** Where a skill came from. Priority for same-name conflicts:
 *    `_user` > `_custom` > `_pack:*` > `_seed` > `legacy`
 *  Pack sources carry the pack name so provenance surfaces in the UI (chat
 *  panel shows `← from pack: dev-skills-pro` when a pack-owned skill fires). */
export type SkillSource = '_user' | '_custom' | '_seed' | 'legacy' | `_pack:${string}`;

export interface Skill {
  name: string;
  description: string;
  body: string;
  /** Phase names this skill applies to. Empty → applies to every phase. */
  appliesTo: string[];
  /** Free-text keywords parsed from the frontmatter. Used by pickSkill. */
  keywords: string[];
  source: SkillSource;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: m[2]! };
}

function readDir(dir: string, source: SkillSource): Skill[] {
  if (!fs.existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      out.push({
        name: meta.name ?? f.replace(/\.md$/, ''),
        description: meta.description ?? '',
        body: body.trim(),
        appliesTo: split(meta.appliesTo ?? meta.applies_to ?? ''),
        keywords: split(meta.keywords ?? meta.tags ?? ''),
        source,
      });
    } catch {}
  }
  return out;
}

function split(s: string): string[] {
  return s.split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
}

// ─── seeding ──────────────────────────────────────────────
//
// The 10 skills below ship with the package. On first `loadSkills()` we
// materialize them under `~/.guideai/skills/_seed/` so the user can browse /
// edit them alongside their own `_user/` skills. Idempotent — a seed file that
// already exists is never overwritten (respecting user edits).

const SEED_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'seed',
);

function ensureSeeded(): void {
  const target = path.join(paths.skills, '_seed');
  fs.mkdirSync(target, { recursive: true });
  if (!fs.existsSync(SEED_DIR)) return;
  for (const f of fs.readdirSync(SEED_DIR)) {
    if (!f.endsWith('.md')) continue;
    const dst = path.join(target, f);
    if (fs.existsSync(dst)) continue; // don't clobber user edits
    try { fs.copyFileSync(path.join(SEED_DIR, f), dst); } catch {}
  }
}

/**
 * Load every skill under `~/.guideai/skills/`. Walks three subdirs with
 * priority (_user > _custom > _seed) plus the flat root for legacy skills
 * promoted before subdirs were a thing. Same-name conflicts resolve toward
 * the higher-priority source.
 */
export function loadSkills(): Skill[] {
  ensureSeeded();
  if (!fs.existsSync(paths.skills)) return [];

  const byName = new Map<string, Skill>();
  const push = (skills: Skill[]) => {
    for (const s of skills) if (!byName.has(s.name)) byName.set(s.name, s);
  };

  // Priority order: _user > _custom > packs > _seed > legacy.
  push(readDir(path.join(paths.skills, '_user'), '_user'));
  push(readDir(path.join(paths.skills, '_custom'), '_custom'));
  // S12 · pack-provided skills. Each installed pack under ~/.guideai/packs/
  // exposes its skills at packs/<name>/skills/*.md. Packs with unsatisfied
  // `requires` are filtered out entirely so pickSkill never sees them.
  push(loadPackSkills());
  push(readDir(path.join(paths.skills, '_seed'), '_seed'));

  // Legacy — top-level *.md at ~/.guideai/skills/ root, ignoring subdir names.
  if (fs.existsSync(paths.skills)) {
    for (const f of fs.readdirSync(paths.skills)) {
      if (!f.endsWith('.md')) continue;
      const full = path.join(paths.skills, f);
      try { if (!fs.statSync(full).isFile()) continue; } catch { continue; }
      const s = readDir(paths.skills, 'legacy').find((x) => x.name === f.replace(/\.md$/, ''));
      if (!s) continue;
      if (!byName.has(s.name)) byName.set(s.name, s);
    }
  }

  return [...byName.values()];
}

/** Walk `~/.guideai/packs/*` and load their skills, tagging each with
 *  `_pack:<name>`. Late-imported to avoid a build-order cycle with the
 *  orchestrator package. */
function loadPackSkills(): Skill[] {
  const packsRoot = path.resolve(paths.skills, '..', 'packs');
  if (!fs.existsSync(packsRoot)) return [];
  const out: Skill[] = [];
  for (const name of fs.readdirSync(packsRoot)) {
    const dir = path.join(packsRoot, name);
    const manifestPath = path.join(dir, 'pack.json');
    if (!fs.existsSync(manifestPath)) continue;
    // Cheap requires-check inline. Full requires evaluation lives in packs.ts;
    // we mirror the two easy cases here (tools + runtime) so we don't need to
    // import the orchestrator package.
    let manifest: any;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { continue; }
    if (!hasSatisfiedRequires(manifest?.requires)) continue;
    const skillsDir = path.join(dir, 'skills');
    if (!fs.existsSync(skillsDir)) continue;
    for (const skill of readDir(skillsDir, `_pack:${manifest.name}` as SkillSource)) {
      out.push(skill);
    }
  }
  return out;
}

function hasSatisfiedRequires(req: any): boolean {
  if (!req || typeof req !== 'object') return true;
  const tools: string[] = Array.isArray(req.tools) ? req.tools : [];
  for (const t of tools) {
    try {
      require('node:child_process').execSync(`command -v ${JSON.stringify(t)}`, { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch { return false; }
  }
  if (typeof req.runtime === 'string') {
    const cur = process.versions.node.split('.').map(Number);
    const m = /^(?:\^|>=)?(\d+)\.(\d+)\.(\d+)/.exec(req.runtime);
    if (m) {
      const [rma, rmi, rpa] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (req.runtime.startsWith('^') && cur[0] !== rma) return false;
      if (cur[0]! < rma) return false;
      if (cur[0] === rma && cur[1]! < rmi) return false;
      if (cur[0] === rma && cur[1] === rmi && cur[2]! < rpa) return false;
    }
  }
  return true;
}

/** Pick skills that mention the given phase in their `appliesTo` field
 *  (empty appliesTo means the skill applies everywhere). */
export function skillsForPhase(skills: Skill[], phase: string): Skill[] {
  return skills.filter((s) => s.appliesTo.length === 0 || s.appliesTo.includes(phase));
}

/** Render a compact bullet list of skill bodies to prepend into a system
 *  prompt. Used by phases.ts when NO single skill was picked — a menu of
 *  applicable skills the agent can draw from. */
export function renderSkillsAsContext(skills: Skill[]): string {
  if (skills.length === 0) return '';
  return [
    '## Available skills (apply these when relevant)',
    ...skills.map((s) => `- **${s.name}** (${s.source}) — ${s.description || '(no description)'}\n${s.body.split('\n').map((l) => '  ' + l).join('\n')}`),
  ].join('\n\n');
}

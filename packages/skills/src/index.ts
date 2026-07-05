import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '@guideai/shared/paths';

export { promoteSkillFromTrace, type PromoteArgs, type PromotedSkill } from './promote.js';
export { pickSkill, scoreSkillFor } from './pickSkill.js';
export { renderSkillAsRunbook } from './invoke.js';

/** Where in `~/.guideai/skills/` the skill was loaded from. `_user` beats
 *  `_custom` beats `_seed` when the same name appears in multiple places. */
export type SkillSource = '_user' | '_custom' | '_seed' | 'legacy';

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

  // Prefer specific subdirs, then flat root.
  const layers: Array<[string, SkillSource]> = [
    [path.join(paths.skills, '_user'),   '_user'],
    [path.join(paths.skills, '_custom'), '_custom'],
    [path.join(paths.skills, '_seed'),   '_seed'],
    [paths.skills,                        'legacy'], // flat files at the root
  ];

  const byName = new Map<string, Skill>();
  for (const [dir, source] of layers) {
    if (source === 'legacy') {
      // Only pick up top-level *.md that isn't itself one of the subdirs.
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        const full = path.join(dir, f);
        if (!fs.statSync(full).isFile()) continue;
        // Skip files that also live under _user/_custom/_seed with same basename.
        const s = readDir(dir, 'legacy').find((x) => x.name === f.replace(/\.md$/, ''));
        if (!s) continue;
        if (!byName.has(s.name)) byName.set(s.name, s);
      }
      continue;
    }
    for (const s of readDir(dir, source)) {
      if (!byName.has(s.name)) byName.set(s.name, s);
    }
  }
  return [...byName.values()];
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

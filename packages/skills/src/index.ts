import fs from 'node:fs';
import path from 'node:path';
import { paths } from '@guideai/shared/paths';

export interface Skill {
  name: string;
  description: string;
  body: string;
  appliesTo: string[];   // phase names this skill applies to
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

/** Read every `*.md` in ~/.guideai/skills/ and return parsed Skills. */
export function loadSkills(): Skill[] {
  if (!fs.existsSync(paths.skills)) return [];
  const files = fs.readdirSync(paths.skills).filter((f) => f.endsWith('.md'));
  const skills: Skill[] = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(paths.skills, f), 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      skills.push({
        name: meta.name ?? f.replace(/\.md$/, ''),
        description: meta.description ?? '',
        body: body.trim(),
        appliesTo: (meta.appliesTo ?? meta.applies_to ?? '').split(/[,\s]+/).filter(Boolean),
      });
    } catch {}
  }
  return skills;
}

/** Pick skills that mention the given phase in their `appliesTo` field. */
export function skillsForPhase(skills: Skill[], phase: string): Skill[] {
  return skills.filter((s) => s.appliesTo.length === 0 || s.appliesTo.includes(phase));
}

/** Render a compact bullet list of skill bodies to prepend into a system prompt. */
export function renderSkillsAsContext(skills: Skill[]): string {
  if (skills.length === 0) return '';
  return [
    '## Available skills (apply these when relevant)',
    ...skills.map((s) => `- **${s.name}** — ${s.description || '(no description)'}\n${s.body.split('\n').map((l) => '  ' + l).join('\n')}`),
  ].join('\n\n');
}

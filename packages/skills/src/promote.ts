import fs from 'node:fs';
import path from 'node:path';
import { paths } from '@guideai/shared/paths';

export interface PromoteArgs {
  /** The brief text — used to derive a topic keyword. */
  briefBody: string;
  /** Map from phase name to its rendered AI text. */
  artifacts: Record<string, string>;
  /** Optional override for the file name. */
  slugOverride?: string;
}

export interface PromotedSkill {
  filePath: string;
  name: string;
  alreadyExisted: boolean;
}

const STOPWORDS = new Set([
  'the','and','for','with','from','our','your','their','that','this','these','those',
  'into','about','add','make','build','plan','sketch','decide','keep','minimal',
  'a','an','of','to','in','on','by','as','is','it','be','we','i','you','they','can',
]);

function slugify(text: string, maxTokens = 4): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .slice(0, maxTokens);
  return words.join('-') || 'topic';
}

/**
 * Distill a 5-line generalisable skill from a successful pipeline trace.
 * Heuristic — no extra LLM call:
 *   - One bullet per phase, summarising what the phase output emphasised.
 *   - Truncate each artifact to its first sentence / line / 140 chars.
 *   - Mark as auto-promoted so the user can review and prune.
 *
 * Returns the path written. Idempotent on slug: if a file already exists,
 * append a numeric suffix instead of overwriting.
 */
export function promoteSkillFromTrace(args: PromoteArgs): PromotedSkill {
  fs.mkdirSync(paths.skills, { recursive: true });

  const slug = `auto-${args.slugOverride ?? slugify(args.briefBody)}`;
  let filePath = path.join(paths.skills, `${slug}.md`);
  let alreadyExisted = fs.existsSync(filePath);
  let suffix = 1;
  while (fs.existsSync(filePath)) {
    filePath = path.join(paths.skills, `${slug}-${++suffix}.md`);
    alreadyExisted = false;
  }

  const firstLine = (s: string) => {
    const t = (s ?? '').replace(/^#.*?\n+/, '').trim().split(/\n+/).find((l) => l.trim().length > 0) ?? '';
    return t.length > 140 ? t.slice(0, 137) + '…' : t;
  };

  const lessons = [
    args.artifacts.research && `Research takeaway: ${firstLine(args.artifacts.research)}`,
    args.artifacts.plan     && `Plan shape: ${firstLine(args.artifacts.plan)}`,
    args.artifacts.implement && `Implementation hint: ${firstLine(args.artifacts.implement)}`,
    args.artifacts.review   && `Review risk: ${firstLine(args.artifacts.review)}`,
    args.artifacts.verify   && `Verify cue: ${firstLine(args.artifacts.verify)}`,
  ].filter(Boolean) as string[];

  const body = [
    '---',
    `name: ${slug}`,
    `description: Auto-promoted from trace — distilled from "${args.briefBody.slice(0, 80)}"`,
    'appliesTo: research, plan, implement',
    'source: auto-stop-hook',
    '---',
    '',
    '## Lessons from a prior similar brief',
    '',
    ...lessons.map((l) => `- ${l}`),
    '',
    '_Review and prune this file once it has aged. Auto-promoted skills are draft quality._',
    '',
  ].join('\n');

  fs.writeFileSync(filePath, body);
  return { filePath, name: slug, alreadyExisted };
}

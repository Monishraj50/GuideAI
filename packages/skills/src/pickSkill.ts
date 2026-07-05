// S5 — Pick the best-matching skill for a task.
//
// Scoring signals (weighted):
//   - keyword hit    : +3  per unique keyword in the task text
//   - name hit       : +5  when the task text mentions the skill name
//   - phase match    : +2  when the current phase is in appliesTo
//   - source rank    : +3 user / +2 custom / +1 seed
//
// Zero score → no skill picked; caller falls back to phase prompts.

import type { Skill, SkillSource } from './index.js';

const STOPWORDS = new Set([
  'a','an','the','and','or','to','of','for','with','in','on','by','as','is','it','be','this','that',
  'we','our','your','their','from','add','make','build','plan','sketch','decide','keep','minimal',
  'should','would','could','want','need','let','any','some','all','one','two','three','use','using',
  'do','doing','does','done','have','has','had','not','so','but','if','then','when','while',
]);

function tokenize(s: string): string[] {
  return s.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function sourceRank(src: SkillSource): number {
  switch (src) {
    case '_user':   return 3;
    case '_custom': return 2;
    case '_seed':   return 1;
    default:        return 0;
  }
}

export interface SkillScore {
  skill: Skill;
  score: number;
  matched: string[];   // words that contributed
}

/** Score a single skill against a task. Exposed for tests/debug UI. */
export function scoreSkillFor(skill: Skill, taskText: string, phase?: string): SkillScore {
  const tokens = new Set(tokenize(taskText));
  const lowerTask = taskText.toLowerCase();
  const matched: string[] = [];
  let score = 0;

  for (const kw of skill.keywords) {
    if (tokens.has(kw)) {
      score += 3;
      matched.push(kw);
    } else if (lowerTask.includes(kw)) {
      // multi-word keyword substring hit
      score += 2;
      matched.push(kw);
    }
  }
  if (lowerTask.includes(skill.name.toLowerCase().replace(/-/g, ' '))
   || lowerTask.includes(skill.name.toLowerCase())) {
    score += 5;
    matched.push(`name:${skill.name}`);
  }
  // Verb bonus — if ANY part of the skill's kebab-case name appears as its own
  // token in the brief, that's a strong signal ("refactor …" → refactor-*,
  // "write documentation …" → write-*). Weighted higher than a keyword hit
  // because the user typed the verb the skill is *named* after.
  for (const part of skill.name.toLowerCase().split('-')) {
    if (part.length >= 3 && tokens.has(part)) {
      score += 4;
      matched.push(`name-part:${part}`);
    }
  }
  if (phase && skill.appliesTo.includes(phase)) {
    score += 2;
  }
  if (score > 0) score += sourceRank(skill.source);

  return { skill, score, matched };
}

/** Return the top-scoring skill (or null if nothing matched). */
export function pickSkill(args: {
  taskText: string;
  phase?: string;
  skills: Skill[];
}): SkillScore | null {
  let best: SkillScore | null = null;
  for (const s of args.skills) {
    if (args.phase && s.appliesTo.length > 0 && !s.appliesTo.includes(args.phase)) continue;
    const scored = scoreSkillFor(s, args.taskText, args.phase);
    if (scored.score <= 0) continue;
    if (!best || scored.score > best.score) best = scored;
  }
  return best;
}

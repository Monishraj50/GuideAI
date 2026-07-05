// S5 — Render a single Skill's body as a runbook block to prepend into an
// agent's system prompt. Distinct from renderSkillsAsContext (a menu of all
// applicable skills); this is "we've decided; follow this exactly".

import type { Skill } from './index.js';

export function renderSkillAsRunbook(skill: Skill, taskText: string): string {
  return [
    `## Selected skill: ${skill.name} (${skill.source})`,
    '',
    `_${skill.description}_`,
    '',
    skill.body,
    '',
    '## Task',
    '',
    taskText.trim(),
  ].join('\n');
}

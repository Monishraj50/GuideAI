// S13 · GET /api/skills — surface loadSkills() output for the Skills & Packs
// sidebar. Read-only; edits go through the underlying markdown files or the
// pack install/uninstall routes.

import type { FastifyInstance } from 'fastify';
import { loadSkills } from '@guideai/skills';

export function registerSkillRoutes(app: FastifyInstance) {
  app.get('/api/skills', async () => {
    const skills = loadSkills();
    return {
      count: skills.length,
      skills: skills.map((s) => ({
        name: s.name,
        description: s.description,
        appliesTo: s.appliesTo,
        keywords: s.keywords,
        source: s.source,
      })),
    };
  });
}

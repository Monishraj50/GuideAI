import fs from 'node:fs';
import path from 'node:path';
import { paths } from '@guideai/shared/paths';

export interface CatalogAgent {
  /** kebab-case role identifier from the frontmatter `name:` field. */
  role: string;
  /** Human-friendly display name. */
  displayName: string;
  /** Department slug (e.g. "01-core-development"). */
  department: string;
  description: string;
  /** Optional tool whitelist parsed from frontmatter (`tools: Read,Write,Edit`). */
  tools: string[];
  /** Optional preferred model alias (haiku/sonnet/opus or version-pinned). */
  model?: string;
  /** Markdown body (system prompt). */
  body: string;
}

export interface Catalog {
  fetchedAt: number;
  count: number;
  agents: CatalogAgent[];
}

const CATALOG_FILE = path.join(paths.home, 'catalog', 'catalog.json');

export function catalogPath() { return CATALOG_FILE; }

export function loadCatalog(): Catalog | null {
  if (!fs.existsSync(CATALOG_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')) as Catalog;
  } catch { return null; }
}

export function departments(catalog: Catalog): { slug: string; label: string; count: number }[] {
  const counts: Record<string, number> = {};
  for (const a of catalog.agents) counts[a.department] = (counts[a.department] ?? 0) + 1;
  return Object.entries(counts).map(([slug, count]) => ({ slug, label: prettyDept(slug), count }));
}

export function prettyDept(slug: string): string {
  // "01-core-development" → "Core Development"
  return slug.replace(/^\d+-/, '').split('-').map((w) => w[0]?.toUpperCase() + w.slice(1)).join(' ');
}

export function findAgent(catalog: Catalog, role: string): CatalogAgent | undefined {
  return catalog.agents.find((a) => a.role === role);
}

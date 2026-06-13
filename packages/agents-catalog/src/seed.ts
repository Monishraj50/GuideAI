// Fetches the awesome-claude-code-subagents catalog from GitHub and writes it
// to ~/.guideai/catalog/catalog.json. Idempotent.
//
//   pnpm --filter @guideai/agents-catalog seed

import fs from 'node:fs';
import path from 'node:path';
import { paths } from '@guideai/shared/paths';
import { catalogPath, type Catalog, type CatalogAgent } from './index.js';

const REPO = 'VoltAgent/awesome-claude-code-subagents';
const BRANCH = 'main';
const TREE_URL = `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`;
const RAW = (filePath: string) => `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${filePath}`;

interface TreeEntry { path: string; type: string; }
interface TreeResp { tree: TreeEntry[]; truncated?: boolean }

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[line.slice(0, idx).trim()] = value;
  }
  return { meta, body: m[2]! };
}

function prettyName(role: string) {
  return role.split('-').map((w) => w[0]?.toUpperCase() + w.slice(1)).join(' ');
}

function shouldSkip(filePath: string): boolean {
  if (!filePath.endsWith('.md')) return true;
  if (!filePath.startsWith('categories/')) return true;
  const base = path.basename(filePath).toLowerCase();
  if (base === 'readme.md' || base === 'index.md') return true;
  return false;
}

async function main() {
  console.log('[seed] fetching catalog tree…');
  const treeRes = await fetch(TREE_URL);
  if (!treeRes.ok) throw new Error(`tree fetch failed: ${treeRes.status} ${await treeRes.text()}`);
  const tree = await treeRes.json() as TreeResp;
  const files = tree.tree.filter((t) => t.type === 'blob' && !shouldSkip(t.path));
  console.log(`[seed] ${files.length} agent files in 10 departments`);

  const agents: CatalogAgent[] = [];
  let i = 0;
  for (const f of files) {
    i++;
    if (i % 25 === 0) console.log(`[seed]   …${i}/${files.length}`);
    const res = await fetch(RAW(f.path));
    if (!res.ok) { console.warn(`[seed] skip ${f.path}: ${res.status}`); continue; }
    const raw = await res.text();
    const { meta, body } = parseFrontmatter(raw);
    const role = meta.name ?? path.basename(f.path, '.md');
    const department = f.path.split('/')[1] ?? 'misc';
    const tools = (meta.tools ?? '').split(/[,\s]+/).filter(Boolean);
    agents.push({
      role,
      displayName: prettyName(role),
      department,
      description: meta.description ?? '',
      tools,
      model: meta.model || undefined,
      body: body.trim(),
    });
  }

  fs.mkdirSync(path.dirname(catalogPath()), { recursive: true });
  const out: Catalog = { fetchedAt: Date.now(), count: agents.length, agents };
  fs.writeFileSync(catalogPath(), JSON.stringify(out, null, 2));
  console.log(`[seed] wrote ${agents.length} agents → ${catalogPath()}`);
  console.log(`[seed] state dir: ${paths.home}`);
}

main().catch((err) => { console.error('[seed] error:', err); process.exit(1); });

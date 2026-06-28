// S2 · Hierarchical context store.
//
// Maintains two markdown surfaces under <workspaceMdRoot>/:
//
//   PROJECT.md                       ← auto-rewritten table of features
//   features/<slug>/FEATURE.md       ← per-feature state, decisions, sessions
//
// PROJECT.md is a TOC. FEATURE.md is the per-feature page with frontmatter
// (status, role, files), a Goal section, a Decisions log, and a Sessions
// table. Together they give a new agent two cheap reads to locate context
// without dumping full session JSONL into the prompt.

import fs from 'node:fs';
import path from 'node:path';
import { paths } from '@guideai/shared/paths';

export type FeatureStatus = 'planned' | 'in-progress' | 'shipped' | 'abandoned';
export type SessionOutcome = 'shipped' | 'partial' | 'abandoned';

export interface FeatureFields {
  status?: FeatureStatus;
  role?: string | null;
  files?: string[];
  related?: string[];
  goal?: string;
}

const GITIGNORE_CONTENT =
`# GuideAI per-repo state — auto-written.
# Public (tracked):   PROJECT.md, features/*/FEATURE.md, hooks.json
# Private (ignored):  workspace.db, sessions/*.jsonl, diffs/

workspace.db
workspace.db-*
features/*/sessions/
features/*/diffs/
`;

function mdRoot(workspaceId: string): string {
  return paths.workspaceMdDir(workspaceId);
}

function featureDir(workspaceId: string, slug: string): string {
  return path.join(mdRoot(workspaceId), 'features', slug);
}

function projectMdPath(workspaceId: string): string {
  return path.join(mdRoot(workspaceId), 'PROJECT.md');
}

/** Idempotent: create the workspace md root, PROJECT.md, and .gitignore if
 *  missing. Returns the PROJECT.md path. */
export function ensureProjectMd(workspaceId: string): string {
  const root = mdRoot(workspaceId);
  fs.mkdirSync(root, { recursive: true });

  const gitignorePath = path.join(root, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    try { fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT); } catch {}
  }

  const pmd = projectMdPath(workspaceId);
  if (!fs.existsSync(pmd)) {
    fs.writeFileSync(pmd, renderProjectMd(workspaceId, []));
  }
  return pmd;
}

// ───────── feature page ─────────

interface ParsedFeature {
  fields: Record<string, any>;
  body: string;
}

function parseFeatureFile(raw: string): ParsedFeature {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw);
  if (!m) return { fields: {}, body: raw };
  const fields: Record<string, any> = {};
  for (const line of m[1]!.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val: any = line.slice(idx + 1).trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map((s: string) => s.trim()).filter(Boolean);
    }
    fields[key] = val;
  }
  return { fields, body: m[2] ?? '' };
}

function renderFeatureMd(slug: string, fields: Record<string, any>, body: string): string {
  const filesArr: string[] = Array.isArray(fields.files) ? fields.files : [];
  const relatedArr: string[] = Array.isArray(fields.related) ? fields.related : [];
  const fmLines = [
    '---',
    `name: ${slug}`,
    `status: ${fields.status ?? 'in-progress'}`,
    `role: ${fields.role ?? ''}`,
    `files: [${filesArr.join(', ')}]`,
    `related: [${relatedArr.join(', ')}]`,
    '---',
  ];
  const trimmedBody = (body ?? '').trim();
  const finalBody = trimmedBody ? trimmedBody : [
    `# ${slug}`,
    '',
    '## Goal',
    fields.goal ?? '_(set by the first brief on this feature)_',
    '',
    '## Decisions',
    '',
    '## Sessions',
    '',
    '| Session ID | Date | Did | Outcome |',
    '|---|---|---|---|',
  ].join('\n');
  return `${fmLines.join('\n')}\n\n${finalBody}\n`;
}

/** Create or update features/<slug>/FEATURE.md. Frontmatter merges with
 *  what's on disk; body is preserved. Also creates sessions/ subdir. */
export function upsertFeature(workspaceId: string, slug: string, fields: FeatureFields = {}): string {
  const dir = featureDir(workspaceId, slug);
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });

  const featurePath = path.join(dir, 'FEATURE.md');
  let existing: ParsedFeature = { fields: {}, body: '' };
  if (fs.existsSync(featurePath)) {
    existing = parseFeatureFile(fs.readFileSync(featurePath, 'utf-8'));
  }

  // Merge: new fields override; for arrays, union.
  const merged: Record<string, any> = { ...existing.fields };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      const prev: string[] = Array.isArray(merged[k]) ? merged[k] : [];
      merged[k] = Array.from(new Set([...prev, ...v]));
    } else {
      merged[k] = v;
    }
  }
  if (!merged.status) merged.status = 'in-progress';

  fs.writeFileSync(featurePath, renderFeatureMd(slug, merged, existing.body));
  return featurePath;
}

/** Append a decision line to the ## Decisions section of FEATURE.md. */
export function appendDecision(workspaceId: string, slug: string, text: string): void {
  const featurePath = path.join(featureDir(workspaceId, slug), 'FEATURE.md');
  if (!fs.existsSync(featurePath)) upsertFeature(workspaceId, slug, {});
  let content = fs.readFileSync(featurePath, 'utf-8');
  const date = new Date().toISOString().slice(0, 10);
  const line = `- ${date}: ${text.replace(/\n/g, ' ').slice(0, 200)}`;
  // Match the Decisions section body up to the next `## ` heading or end of string.
  const re = /(^##\s+Decisions[ \t]*\n)([\s\S]*?)(?=^##\s+|$(?![\s\S]))/m;
  if (re.test(content)) {
    content = content.replace(re, (_m, heading: string, body: string) => {
      const trimmed = body.replace(/\s+$/, '');
      const sep = trimmed ? `${trimmed}\n` : '';
      return `${heading}${sep}${line}\n\n`;
    });
  } else {
    content = `${content.trimEnd()}\n\n## Decisions\n${line}\n`;
  }
  fs.writeFileSync(featurePath, content);
}

/** Append a session row to the ## Sessions table in FEATURE.md. */
export function appendSessionPointer(args: {
  workspaceId: string;
  slug: string;
  sessionId: string;
  briefBody: string;
  outcome?: SessionOutcome;
}): void {
  const outcome: SessionOutcome = args.outcome ?? 'shipped';
  const featurePath = path.join(featureDir(args.workspaceId, args.slug), 'FEATURE.md');
  if (!fs.existsSync(featurePath)) upsertFeature(args.workspaceId, args.slug, {});
  let content = fs.readFileSync(featurePath, 'utf-8');
  const date = new Date().toISOString().slice(0, 10);
  const did = (args.briefBody.split('\n').find((l) => l.trim()) ?? '')
    .replace(/^#+\s*/, '').replace(/\|/g, '/').slice(0, 80) || 'work';
  const icon = outcome === 'shipped' ? '✓ shipped' : outcome === 'partial' ? '⚠ partial' : '✗ abandoned';
  const row = `| \`${args.sessionId}\` | ${date} | ${did} | ${icon} |`;
  // Match `## Sessions` through the table separator line (any `|---|...`),
  // so the new row lands directly after the separator (latest first).
  const headerRe = /(^##\s+Sessions[^\n]*\n[\s\S]*?\|[\s\-:|]+\|[ \t]*\n)/m;
  if (headerRe.test(content)) {
    content = content.replace(headerRe, `$1${row}\n`);
  } else {
    content = `${content.trimEnd()}\n\n## Sessions\n\n| Session ID | Date | Did | Outcome |\n|---|---|---|---|\n${row}\n`;
  }
  fs.writeFileSync(featurePath, content);
}

// ───────── project TOC ─────────

interface FeatureSummary {
  slug: string;
  fields: Record<string, any>;
  lastTouched: number;
}

function listFeatures(workspaceId: string): FeatureSummary[] {
  const featuresDir = path.join(mdRoot(workspaceId), 'features');
  if (!fs.existsSync(featuresDir)) return [];
  const out: FeatureSummary[] = [];
  for (const entry of fs.readdirSync(featuresDir)) {
    const fmPath = path.join(featuresDir, entry, 'FEATURE.md');
    if (!fs.existsSync(fmPath)) continue;
    try {
      const stat = fs.statSync(fmPath);
      const { fields } = parseFeatureFile(fs.readFileSync(fmPath, 'utf-8'));
      out.push({ slug: entry, fields, lastTouched: stat.mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => b.lastTouched - a.lastTouched);
}

function renderProjectMd(workspaceId: string, features: FeatureSummary[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    '---',
    `generated: ${today}`,
    `workspace: ${workspaceId}`,
    `features: ${features.length}`,
    '---',
    '',
    '# Project map',
    '',
  ];
  if (features.length === 0) {
    lines.push('_(no features yet — submit a brief to create one)_');
  } else {
    lines.push('| Feature | Status | Role | Files | Last touched |');
    lines.push('|---|---|---|---|---|');
    for (const f of features) {
      const files = Array.isArray(f.fields.files) ? f.fields.files.join(', ') : '';
      const role = f.fields.role || '—';
      const status = f.fields.status || 'planned';
      const dt = new Date(f.lastTouched).toISOString().slice(0, 10);
      lines.push(`| ${f.slug} | ${status} | ${role} | ${files || '—'} | ${dt} |`);
    }
  }
  lines.push('', '## File index', '');
  const fileMap: Array<{ file: string; slug: string }> = [];
  for (const f of features) {
    const files: string[] = Array.isArray(f.fields.files) ? f.fields.files : [];
    for (const file of files) fileMap.push({ file, slug: f.slug });
  }
  if (fileMap.length === 0) {
    lines.push('_(populated as features touch files)_');
  } else {
    fileMap.sort((a, b) => a.file.localeCompare(b.file));
    lines.push('```');
    for (const { file, slug } of fileMap) lines.push(`${file}  →  ${slug}`);
    lines.push('```');
  }
  return lines.join('\n') + '\n';
}

/** Rebuild PROJECT.md from the current set of features/ subdirectories. */
export function rebuildProjectTOC(workspaceId: string): void {
  ensureProjectMd(workspaceId);
  const features = listFeatures(workspaceId);
  fs.writeFileSync(projectMdPath(workspaceId), renderProjectMd(workspaceId, features));
}

// ───────── slug helper ─────────

/** Derive a feature slug from a brief body. Mirrors the existing rule used
 *  by cos.ts/work_items so the same brief maps to the same feature page. */
export function featureSlugFromBrief(body: string): string {
  const firstLine = (body.split('\n').find((l) => l.trim()) ?? '').replace(/^#+\s*/, '').trim();
  const slug = firstLine.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || 'untitled';
}

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { paths } from '@guideai/shared/paths';
import { readEvents } from '@guideai/messaging/events';
import { appendEvent } from '@guideai/messaging/events';
import { ClaudeAdapter } from '@guideai/runtime-claude';
import type { AIChunk, Chunk, SystemChunk } from '@guideai/shared/chunks';

export interface DigestSummary {
  workspaceId: string;
  windowMs: number;
  endTs: number;
  briefs: number;
  phasesCompleted: number;
  agentsHired: number;
  agentsRetired: number;
  approvalsApproved: number;
  approvalsDenied: number;
  skillsPromoted: number;
  tokensIn: number;
  tokensOut: number;
}

export interface DigestResult {
  date: string;
  filePath: string;
  text: string;
  summary: DigestSummary;
  generatedAt: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDate(ts: number) {
  return new Date(ts).toISOString().slice(0, 10);
}

function digestDir(workspaceId: string) {
  return path.join(paths.workspaceDir(workspaceId), 'digests');
}

function digestFilePath(workspaceId: string, date: string) {
  return path.join(digestDir(workspaceId), `${date}.md`);
}

function aggregate(chunks: Chunk[], now: number, windowMs: number): DigestSummary {
  const cutoff = now - windowMs;
  let briefs = 0;
  let phasesCompleted = 0;
  let hired = 0;
  let retired = 0;
  let approved = 0;
  let denied = 0;
  let skills = 0;
  let tokensIn = 0;
  let tokensOut = 0;

  for (const c of chunks) {
    if (c.ts < cutoff) continue;
    if (c.kind === 'user') briefs++;
    if (c.kind === 'phase' && c.status === 'completed') phasesCompleted++;
    if (c.kind === 'approval') {
      if (c.decision === 'approved' || c.decision === 'auto-approved') approved++;
      if (c.decision === 'denied') denied++;
    }
    if (c.kind === 'system' && c.text) {
      if (c.text.startsWith('hired ')) hired++;
      if (c.text.startsWith('retired ')) retired++;
      if (c.text.startsWith('skill promoted:')) skills++;
    }
    if (c.kind === 'ai') {
      tokensIn += c.tokensIn ?? 0;
      tokensOut += c.tokensOut ?? 0;
    }
  }

  return {
    workspaceId: '', windowMs, endTs: now,
    briefs, phasesCompleted, agentsHired: hired, agentsRetired: retired,
    approvalsApproved: approved, approvalsDenied: denied,
    skillsPromoted: skills, tokensIn, tokensOut,
  };
}

/**
 * Build the digest for a workspace's last `windowMs` ms (default 24h). Writes
 * the result to ~/.guideai/workspaces/{id}/digests/{yyyy-mm-dd}.md and emits
 * a SystemChunk to the workspace feed.
 */
export async function generateDigest(args: {
  workspaceId: string;
  windowMs?: number;
}): Promise<DigestResult> {
  const workspaceId = args.workspaceId;
  const windowMs = args.windowMs ?? DAY_MS;
  const now = Date.now();
  const cutoff = now - windowMs;

  const { chunks } = await readEvents(workspaceId, { sinceTs: cutoff });
  const summary = aggregate(chunks, now, windowMs);
  summary.workspaceId = workspaceId;

  const factsBlock = [
    `briefs submitted: ${summary.briefs}`,
    `phases completed: ${summary.phasesCompleted}`,
    `agents hired: ${summary.agentsHired}`,
    `agents retired: ${summary.agentsRetired}`,
    `approvals: ${summary.approvalsApproved} approved / ${summary.approvalsDenied} denied`,
    `skills promoted: ${summary.skillsPromoted}`,
    `tokens: ${summary.tokensIn} in / ${summary.tokensOut} out`,
  ].join('\n- ');

  // Cheap haiku call to produce a paragraph. Falls back to a deterministic
  // template if the call fails so the demo path is always green.
  let paragraph = '';
  try {
    const res = await ClaudeAdapter.runOnce({
      agentId: 'digest-bot', workspaceId,
      cwd: path.join(paths.home, 'cwd-digest'),
      systemPrompt:
        'You write a one-paragraph daily standup digest for a small autonomous team. ' +
        'Max 60 words. State: what shipped, what is blocked, what needs the boss. ' +
        'Be terse and concrete. No preamble.',
      model: 'haiku',
    }, `Workspace: ${workspaceId}\nLast 24h facts:\n- ${factsBlock}`);
    paragraph = res.chunks.filter((c): c is AIChunk => c.kind === 'ai').map((c) => c.text).join('\n').trim();
  } catch (err: any) {
    paragraph = `(digest auto-narration unavailable: ${err?.message ?? err})`;
  }

  if (!paragraph) {
    paragraph = `No notable activity in the last ${Math.round(windowMs / 3.6e6)}h.`;
  }

  const date = isoDate(now);
  fs.mkdirSync(digestDir(workspaceId), { recursive: true });
  const md = [
    `# Standup digest — ${date}`,
    '',
    `_workspace: \`${workspaceId}\` · window: ${Math.round(windowMs / 3.6e6)}h · generated: ${new Date(now).toISOString()}_`,
    '',
    '## Summary',
    '',
    paragraph,
    '',
    '## Counters',
    '',
    `- ${factsBlock}`,
    '',
  ].join('\n');
  const file = digestFilePath(workspaceId, date);
  fs.writeFileSync(file, md);

  const note: SystemChunk = {
    id: randomUUID(), ts: now, workspaceId, kind: 'system', level: 'info',
    text: `digest generated for ${date} → ${file}`,
  };
  appendEvent(workspaceId, note);

  return { date, filePath: file, text: md, summary, generatedAt: now };
}

/** Latest digest on disk for a workspace. Returns `null` if none exist. */
export function readLatestDigest(workspaceId: string): DigestResult | null {
  const dir = digestDir(workspaceId);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().reverse();
  const latest = files[0];
  if (!latest) return null;
  const filePath = path.join(dir, latest);
  const text = fs.readFileSync(filePath, 'utf8');
  const date = latest.replace(/\.md$/, '');
  const stat = fs.statSync(filePath);
  return {
    date, filePath, text,
    summary: {
      workspaceId, windowMs: DAY_MS, endTs: stat.mtimeMs,
      briefs: 0, phasesCompleted: 0, agentsHired: 0, agentsRetired: 0,
      approvalsApproved: 0, approvalsDenied: 0, skillsPromoted: 0,
      tokensIn: 0, tokensOut: 0,
    },
    generatedAt: stat.mtimeMs,
  };
}

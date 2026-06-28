// Per-task chat-history transcript writer.
//
// Renders the chunks emitted during a single agent run into a Markdown file
// at <repo>/atrune/agents/<role>/sessions/<taskId>.md. The Team sidebar
// surfaces this file via markdown.showPreviewToSide so the user sees the
// full Claude-chat-style conversation that produced a task.
//
// Append-only: reopens (verify-and-repair) tack a `🔁 Reopened` separator
// onto the existing file so the full history across runs stays in one place.

import fs from 'node:fs';
import path from 'node:path';
import { paths } from '@guideai/shared/paths';
import type { Chunk } from '@guideai/shared/chunks';

export interface TranscriptContext {
  workspaceId: string;
  role: string;
  /** Stable taskId — phase-scoped today (e.g. `<briefId>-<phase>`). */
  taskId: string;
  taskTitle: string;
  briefId?: string;
  systemPrompt?: string;
  /** Set true to append a verify-and-repair separator instead of (re)starting. */
  reopened?: boolean;
}

export function transcriptPath(workspaceId: string, role: string, taskId: string): string {
  return path.join(paths.workspaceMdDir(workspaceId), 'agents', role, 'sessions', `${taskId}.md`);
}

export function writeTaskTranscript(ctx: TranscriptContext, chunks: Chunk[]): string {
  const file = transcriptPath(ctx.workspaceId, ctx.role, ctx.taskId);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const exists = fs.existsSync(file);
  const parts: string[] = [];

  if (!exists) {
    parts.push(renderHeader(ctx));
    if (ctx.systemPrompt?.trim()) {
      parts.push(`## 🧑 System prompt\n\n${fence(ctx.systemPrompt.trim())}\n`);
    }
  } else if (ctx.reopened) {
    parts.push(`\n---\n\n## 🔁 Reopened on ${formatTime(Date.now())} — verification mode\n`);
  } else {
    // Same task re-ran without an explicit reopen: just append a divider.
    parts.push(`\n---\n\n## ▶ Resumed on ${formatTime(Date.now())}\n`);
  }

  let turn = 1;
  for (const c of chunks) {
    const rendered = renderChunk(c, turn);
    if (!rendered) continue;
    parts.push(rendered);
    if (c.kind === 'ai') turn++;
  }

  fs.appendFileSync(file, parts.join('\n'), 'utf-8');
  return file;
}

/** Make a streaming appender for a single task run. Returns a function the
 *  caller (orchestrator) invokes for every chunk as it arrives from the
 *  adapter's onChunk callback. The header + system prompt are written on
 *  the FIRST chunk so the file exists immediately — VS Code's markdown
 *  preview can open it from the start, and content fills in live.
 *
 *  The append is fs.appendFileSync (sync) — chunks arrive at human-scale
 *  rates (Claude's stream), not millions per second, so blocking briefly
 *  per chunk is fine and keeps order deterministic. */
export function makeStreamingAppender(ctx: TranscriptContext) {
  const file = transcriptPath(ctx.workspaceId, ctx.role, ctx.taskId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let aiTurn = 1;
  let headerWritten = fs.existsSync(file);

  function ensureHeader() {
    if (headerWritten) return;
    const parts: string[] = [];
    parts.push(renderHeader(ctx));
    if (ctx.systemPrompt?.trim()) {
      parts.push(`## 🧑 System prompt\n\n${fence(ctx.systemPrompt.trim())}\n`);
    }
    fs.appendFileSync(file, parts.join('\n'), 'utf-8');
    headerWritten = true;
  }

  return {
    path: file,
    /** Append a single chunk's rendered Markdown to the transcript. */
    append(chunk: Chunk): void {
      ensureHeader();
      const rendered = renderChunk(chunk, aiTurn);
      if (!rendered) return;
      fs.appendFileSync(file, '\n' + rendered, 'utf-8');
      if (chunk.kind === 'ai') aiTurn++;
    },
    /** Called when the run finishes. Currently a no-op (header already
     *  written, all chunks already appended) — kept as a hook for future
     *  "task finished" markers if we want them. */
    finalize(): void {},
  };
}

function renderHeader(ctx: TranscriptContext): string {
  const lines = [
    `# Task: ${ctx.taskTitle}`,
    '',
    `**Agent**: \`${ctx.role}\`` + (ctx.briefId ? ` · **Brief**: \`${ctx.briefId}\`` : '')
      + ` · **Started**: ${formatTime(Date.now())}`,
    '',
    '---',
    '',
  ];
  return lines.join('\n');
}

function renderChunk(c: Chunk, turn: number): string | null {
  switch (c.kind) {
    case 'ai': {
      const txt = c.text?.trim();
      if (!txt) return null;
      const usage = (c.tokensIn || c.tokensOut)
        ? ` _(${c.tokensIn ?? 0} in · ${c.tokensOut ?? 0} out)_`
        : '';
      return `## 🤖 Claude · turn ${turn}${usage}\n\n${txt}\n`;
    }
    case 'tool': {
      const args = stringify(c.args);
      const result = stringify(c.result);
      const hdr = `### 🔧 Tool · \`${c.tool}\``;
      const block = [hdr, '', '**Input:**', fence(args, 'json')];
      if (result) {
        block.push('', '**Result:**', fence(result));
      }
      return block.join('\n') + '\n';
    }
    case 'system': {
      const text = c.text?.trim();
      if (!text) return null;
      const prefix = c.level === 'error' ? '🛑' : c.level === 'warn' ? '⚠️' : '💬';
      return `> ${prefix} ${text}\n`;
    }
    case 'user': {
      const text = c.text?.trim();
      if (!text) return null;
      return `## 🧑 User\n\n${text}\n`;
    }
    case 'phase':
    case 'approval':
      return null;
  }
}

function stringify(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function fence(body: string, lang = ''): string {
  return '```' + lang + '\n' + body + '\n```';
}

function formatTime(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { paths } from '@guideai/shared/paths';
import type { Chunk } from '@guideai/shared/chunks';

function ensureFile(p: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (!fs.existsSync(p)) fs.writeFileSync(p, '');
}

export function eventsPath(workspaceId: string) {
  return paths.workspaceEvents(workspaceId);
}

/** Append one chunk to the workspace's events.jsonl. */
export function appendEvent(workspaceId: string, chunk: Chunk): void {
  const p = eventsPath(workspaceId);
  ensureFile(p);
  fs.appendFileSync(p, JSON.stringify(chunk) + '\n');
}

export interface ReadEventsOpts {
  sinceTs?: number;
  sinceOffset?: number;
  limit?: number;
}

/** Read existing chunks. Returns the chunks and the new file offset for tailing. */
export async function readEvents(
  workspaceId: string,
  opts: ReadEventsOpts = {},
): Promise<{ chunks: Chunk[]; endOffset: number }> {
  const p = eventsPath(workspaceId);
  if (!fs.existsSync(p)) return { chunks: [], endOffset: 0 };
  const stat = fs.statSync(p);
  const start = opts.sinceOffset ?? 0;
  if (start >= stat.size) return { chunks: [], endOffset: stat.size };

  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(p, { start, encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });
    const chunks: Chunk[] = [];
    rl.on('line', (line) => {
      if (!line) return;
      try {
        const obj = JSON.parse(line) as Chunk;
        if (opts.sinceTs !== undefined && obj.ts < opts.sinceTs) return;
        chunks.push(obj);
        if (opts.limit !== undefined && chunks.length >= opts.limit) rl.close();
      } catch {
        // Ignore malformed lines (partial writes are possible during tail).
      }
    });
    rl.on('close', () => resolve({ chunks, endOffset: stat.size }));
    rl.on('error', reject);
  });
}

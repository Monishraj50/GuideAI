import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import chokidar from 'chokidar';
import type { Chunk } from '@guideai/shared/chunks';
import { eventsPath } from './events.js';

export interface WatchHandle {
  close(): Promise<void>;
}

/**
 * Tail the workspace's events.jsonl. Emits each new chunk via `onChunk` as it
 * arrives. Maintains a byte offset so we never replay the same line twice.
 */
export function watchWorkspace(
  workspaceId: string,
  onChunk: (chunk: Chunk) => void,
  opts: { fromOffset?: number } = {},
): WatchHandle {
  const file = eventsPath(workspaceId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');

  let offset = opts.fromOffset ?? fs.statSync(file).size;
  let draining = false;
  let pendingRescan = false;

  const drain = async () => {
    if (draining) { pendingRescan = true; return; }
    draining = true;
    try {
      let stat: fs.Stats;
      try { stat = fs.statSync(file); } catch { return; }
      if (stat.size < offset) offset = 0;  // file truncated/rotated
      if (stat.size === offset) return;
      const stream = fs.createReadStream(file, { start: offset, encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream });
      const bytes: number[] = [];
      await new Promise<void>((resolve, reject) => {
        rl.on('line', (line) => {
          // +1 for the newline we consumed
          bytes.push(Buffer.byteLength(line, 'utf8') + 1);
          if (!line) return;
          try { onChunk(JSON.parse(line) as Chunk); } catch {}
        });
        rl.on('close', () => resolve());
        rl.on('error', reject);
      });
      offset += bytes.reduce((a, b) => a + b, 0);
    } finally {
      draining = false;
      if (pendingRescan) { pendingRescan = false; await drain(); }
    }
  };

  const watcher = chokidar.watch(file, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: false,
    usePolling: true,    // fs.watch on Linux misses rapid sequential appends
    interval: 50,
  });
  watcher.on('add', () => { offset = 0; drain(); });
  watcher.on('change', () => { drain(); });

  // Belt-and-suspenders periodic drain in case the watcher silently misses an event.
  const fallback = setInterval(() => { drain(); }, 250);

  return {
    async close() {
      clearInterval(fallback);
      await watcher.close();
    },
  };
}

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { paths } from '@guideai/shared/paths';

export interface InboxMessage {
  id: string;
  ts: number;
  from: string;       // sender agentId or 'user' or 'cos'
  to: string;         // recipient agentId
  subject?: string;
  body: string;
  refs?: string[];    // optional references (other message ids, task ids)
}

function ensureFile(p: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (!fs.existsSync(p)) fs.writeFileSync(p, '');
}

export function inboxPath(workspaceId: string, agentId: string) {
  return paths.agentInbox(workspaceId, agentId);
}

export function send(workspaceId: string, msg: InboxMessage): void {
  const p = inboxPath(workspaceId, msg.to);
  ensureFile(p);
  fs.appendFileSync(p, JSON.stringify(msg) + '\n');
}

export async function readInbox(
  workspaceId: string,
  agentId: string,
  opts: { sinceOffset?: number } = {},
): Promise<{ messages: InboxMessage[]; endOffset: number }> {
  const p = inboxPath(workspaceId, agentId);
  if (!fs.existsSync(p)) return { messages: [], endOffset: 0 };
  const stat = fs.statSync(p);
  const start = opts.sinceOffset ?? 0;
  if (start >= stat.size) return { messages: [], endOffset: stat.size };

  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(p, { start, encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });
    const messages: InboxMessage[] = [];
    rl.on('line', (line) => {
      if (!line) return;
      try { messages.push(JSON.parse(line) as InboxMessage); } catch {}
    });
    rl.on('close', () => resolve({ messages, endOffset: stat.size }));
    rl.on('error', reject);
  });
}

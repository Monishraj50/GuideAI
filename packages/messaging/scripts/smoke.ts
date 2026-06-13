// Step 3 smoke: SSE end-to-end.
// 1. Boots the server in this process (programmatic, no subprocess).
// 2. Connects an SSE client via fetch().
// 3. Appends 3 synthetic events to events.jsonl (one Read, one through HTTP POST, one via watcher path).
// 4. Asserts the client receives all 3 within timeout.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, eventsPath } from '../src/events.js';
import { send as sendInbox, readInbox } from '../src/inbox.js';
import type { Chunk, SystemChunk } from '@guideai/shared/chunks';

const WORKSPACE_ID = '_msg_smoke';
const PORT = 4321;
const BASE = `http://localhost:${PORT}`;

function mkSysChunk(text: string): SystemChunk {
  return {
    id: randomUUID(),
    ts: Date.now(),
    workspaceId: WORKSPACE_ID,
    kind: 'system',
    text,
    level: 'info',
  };
}

async function waitForServer(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not come up in ' + timeoutMs + 'ms');
}

async function main() {
  // Reset workspace events file.
  const file = eventsPath(WORKSPACE_ID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');

  // 1) Boot server as subprocess so we exercise the real Fastify route.
  const serverBin = new URL('../../../apps/server/src/index.ts', import.meta.url).pathname;
  const proc = spawn('tsx', [serverBin], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (b) => process.stdout.write(`[srv] ${b}`));
  proc.stderr.on('data', (b) => process.stderr.write(`[srv-err] ${b}`));

  try {
    await waitForServer();
    console.log('[smoke] server up');

    // 2) Open SSE connection and collect events.
    const received: Chunk[] = [];
    const sseUrl = `${BASE}/api/workspaces/${WORKSPACE_ID}/events`;
    const ctl = new AbortController();
    const ssePromise = (async () => {
      const res = await fetch(sseUrl, { headers: { Accept: 'text/event-stream' }, signal: ctl.signal });
      if (!res.body) throw new Error('no SSE body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          const json = dataLine.slice(6);
          try { received.push(JSON.parse(json) as Chunk); } catch {}
        }
      }
    })();

    // Give the watcher time to attach.
    await new Promise((r) => setTimeout(r, 500));

    // 3a) Write a chunk via direct events.jsonl append.
    appendEvent(WORKSPACE_ID, mkSysChunk('via-file-append'));

    // 3b) Write a chunk via HTTP POST.
    const postResp = await fetch(`${BASE}/api/workspaces/${WORKSPACE_ID}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mkSysChunk('via-http-post')),
    });
    if (!postResp.ok) throw new Error('POST event failed: ' + postResp.status);

    // 3c) Write one more after a short delay.
    await new Promise((r) => setTimeout(r, 300));
    appendEvent(WORKSPACE_ID, mkSysChunk('via-second-append'));

    // 4) Wait for receipt (up to 5s). Count only system chunks we wrote.
    const expected = new Set(['via-file-append', 'via-http-post', 'via-second-append']);
    const seen = () =>
      received.filter((c) => c.kind === 'system' && expected.has(c.text)).length;
    const deadline = Date.now() + 5000;
    while (seen() < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    ctl.abort();
    try { await ssePromise; } catch {}

    console.log('[smoke] received chunks:', received.length);
    for (const c of received) {
      if (c.kind === 'system') console.log('  -', c.text);
    }

    // 5) Verify inbox round-trip while we're here.
    sendInbox(WORKSPACE_ID, {
      id: randomUUID(), ts: Date.now(), from: 'user', to: 'alice',
      subject: 'hi', body: 'check the schema diagram',
    });
    const inbox = await readInbox(WORKSPACE_ID, 'alice');
    console.log('[smoke] inbox alice messages:', inbox.messages.length, '->', inbox.messages[0]?.body);

    // 6) Verify backlog replay: open a new connection AFTER all events exist.
    const replayed: Chunk[] = [];
    const ctl2 = new AbortController();
    const replayUrl = `${BASE}/api/workspaces/${WORKSPACE_ID}/events`;
    const replayP = (async () => {
      const res = await fetch(replayUrl, { headers: { Accept: 'text/event-stream' }, signal: ctl2.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const start = Date.now();
      while (Date.now() - start < 1500) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          try { replayed.push(JSON.parse(dataLine.slice(6))); } catch {}
        }
      }
    })();
    await new Promise((r) => setTimeout(r, 1500));
    ctl2.abort();
    try { await replayP; } catch {}
    console.log('[smoke] backlog replay count:', replayed.length);

    // Assertions
    const sawAll =
      received.some((c) => c.kind === 'system' && c.text === 'via-file-append') &&
      received.some((c) => c.kind === 'system' && c.text === 'via-http-post') &&
      received.some((c) => c.kind === 'system' && c.text === 'via-second-append');
    const replayOk = replayed.length >= 3;
    const inboxOk = inbox.messages.length === 1 && inbox.messages[0]!.body.includes('schema');

    if (!sawAll) throw new Error('FAIL: SSE did not deliver all 3 events');
    if (!replayOk) throw new Error('FAIL: SSE backlog replay only got ' + replayed.length);
    if (!inboxOk) throw new Error('FAIL: inbox round-trip broken');

    console.log('[smoke] PASS');
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    if (!proc.killed) proc.kill('SIGKILL');
  }
}

main().catch((err) => { console.error('[smoke] error:', err); process.exit(1); });

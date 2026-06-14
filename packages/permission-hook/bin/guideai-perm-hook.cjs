#!/usr/bin/env node
/* eslint-disable */
// PreToolUse hook for Claude Code. Runs once per tool call. Reads the tool
// call from stdin (JSON), asks GuideAI for a decision, writes back JSON
// telling Claude to allow / deny / ask.
//
// Pure Node, zero deps, so it can be invoked directly from settings.json
// without any build step.

'use strict';

const ENDPOINT = process.env.GUIDEAI_PERMISSIONS_URL || 'http://127.0.0.1:4000/api/permissions/evaluate';
const WORKSPACE = process.env.GUIDEAI_WORKSPACE_ID || 'demo';
const AGENT     = process.env.GUIDEAI_AGENT_ID     || '';
const BRIEF     = process.env.GUIDEAI_BRIEF_ID     || '';
const WAIT_MS   = Number(process.env.GUIDEAI_HOOK_WAIT_MS || 60000);

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

function post(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let lib;
    try { lib = url.startsWith('https') ? require('node:https') : require('node:http'); }
    catch (e) { return reject(e); }
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = lib.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { 'content-type': 'application/json', 'content-length': data.length },
      timeout: timeoutMs,
    }, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let j; try { j = JSON.parse(text); } catch { j = { _raw: text }; }
        resolve({ status: res.statusCode, body: j });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.write(data); req.end();
  });
}

function emit(out) {
  // Claude Code expects JSON on stdout describing the decision. Be liberal:
  // emit both legacy (`continue`) and modern (`permissionDecision`) keys so
  // multiple Claude versions work.
  const decision = out.decision; // 'approved' | 'denied' | 'pending'
  if (decision === 'approved' || decision === 'auto-approved') {
    process.stdout.write(JSON.stringify({
      continue: true,
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: out.reason || 'GuideAI auto-approved' },
    }));
    process.exit(0);
  }
  if (decision === 'denied') {
    process.stdout.write(JSON.stringify({
      continue: false,
      stopReason: out.reason || 'GuideAI denied this tool call',
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: out.reason || 'GuideAI denied this tool call' },
    }));
    process.exit(2);
  }
  // Fallback: deny on the safe side.
  process.stdout.write(JSON.stringify({
    continue: false,
    stopReason: 'GuideAI hook timeout — denied for safety',
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'GuideAI hook timeout' },
  }));
  process.exit(2);
}

async function main() {
  let input;
  try {
    const raw = await readStdin();
    input = JSON.parse(raw || '{}');
  } catch { input = {}; }

  const tool = input.tool_name || input.toolName || '';
  const args = input.tool_input ?? input.toolInput ?? input.input ?? {};

  let resp;
  try {
    resp = await post(ENDPOINT, {
      workspaceId: WORKSPACE,
      agentId: AGENT || undefined,
      briefId: BRIEF || undefined,
      tool, args,
      waitMs: WAIT_MS,
    }, WAIT_MS + 5000);
  } catch (e) {
    // Server unreachable — deny on the safe side, but let the user know.
    emit({ decision: 'denied', reason: `GuideAI server unreachable (${e?.message || e})` });
    return;
  }

  if (resp.status >= 400) {
    emit({ decision: 'denied', reason: `GuideAI returned ${resp.status}: ${JSON.stringify(resp.body).slice(0, 120)}` });
    return;
  }

  emit({
    decision: resp.body?.decision,
    reason: resp.body?.reason || resp.body?.ruleId || 'GuideAI decision',
  });
}

main().catch((err) => {
  // Last-resort fallback — never crash silently.
  process.stderr.write(`guideai-perm-hook fatal: ${err?.stack || err}\n`);
  emit({ decision: 'denied', reason: 'hook crashed' });
});

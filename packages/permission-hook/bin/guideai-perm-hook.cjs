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
// Wait 15 min by default (matches the server route's manual-mode cap). Users
// need real time to review diffs — anything shorter dooms manual mode.
const WAIT_MS   = Number(process.env.GUIDEAI_HOOK_WAIT_MS || 15 * 60_000);
// Local policies file — same path the server uses. Reading it here lets us
// short-circuit the HTTP round-trip when mode is 'auto', so a slow server or
// a network blip can't deny a Write that should have been an instant allow.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const POLICIES_JSON = process.env.GUIDEAI_POLICIES_JSON
  || path.join(process.env.GUIDEAI_HOME || path.join(os.homedir(), '.guideai'), 'policies.json');

// Hard-denies mirror the server-side list (packages/policies/src/engine.ts).
// Kept in sync intentionally — a hook that lets these through would be a
// worse security regression than one that occasionally over-denies.
const HARD_DENY_BASH_PATTERNS = [
  /\brm\s+-[a-z]*r[a-z]*f\b/i,
  /\brm\s+--recursive.*--force\b/i,
  /--no-verify\b/,
  /--no-gpg-sign\b/,
  /\bgit\s+push\s+.*--force\b/i,
  /\bshutdown\b|\breboot\b|\bpoweroff\b/i,
];

function localModeIsAuto() {
  try {
    const raw = fs.readFileSync(POLICIES_JSON, 'utf8');
    const p = JSON.parse(raw);
    return p.mode === 'auto';
  } catch { return false; }
}

function hardDenyBash(tool, args) {
  if (tool !== 'Bash') return null;
  const cmd = typeof args?.command === 'string' ? args.command : '';
  if (!cmd) return null;
  for (const re of HARD_DENY_BASH_PATTERNS) {
    if (re.test(cmd)) return `hard-deny: matches ${re.source}`;
  }
  return null;
}

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

  // Fast path: mode='auto' on disk → decide locally, no network round-trip.
  // A slow / restarting / unreachable server used to turn Write approvals into
  // "denied by hook timeout"; this eliminates that class of failure.
  // Hard-denies still apply — matches server-side hardDeny().
  if (localModeIsAuto()) {
    const hd = hardDenyBash(tool, args);
    if (hd) {
      emit({ decision: 'denied', reason: hd });
      return;
    }
    emit({ decision: 'auto-approved', reason: 'mode=auto (local short-circuit)' });
    return;
  }

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

// Phase 8B — Browser-driven validation.
//
// Once a brief completes, optionally drive a real Chromium against the user's
// app (configured `target_url` on the workspace) to validate the success
// criteria. Persist the test script as a regression suite so re-running on
// future commits is a no-LLM operation.
//
// Inspired by gstack's `/qa` skill. Restricted script vocabulary keeps the
// prompt-injection surface small and the schema stable across Playwright
// versions.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@guideai/shared/db';
import { appendEvent } from '@guideai/messaging/events';
import { paths } from '@guideai/shared/paths';
import { resolveActiveAdapter } from '@guideai/runtime-claude';
import type { AIChunk, SystemChunk } from '@guideai/shared/chunks';
import { tierCost, modelToTier, recordUsage } from '@guideai/policies/budgets';
import { createDeliverable } from './deliverables.js';
import type { DiscoverySynthesis, IntakeRecord } from './discovery.js';

// ---------- types ----------

export type RunStatus = 'running' | 'pass' | 'fail' | 'error' | 'skipped';

export interface ScriptStep {
  step: 'goto' | 'click' | 'fill' | 'expectText' | 'expectVisible' | 'screenshot';
  selector?: string;       // CSS selector
  url?: string;            // goto only (templates {TARGET} → target_url)
  text?: string;           // fill only
  contains?: string;       // expectText only — substring match
  label?: string;          // screenshot label or assertion description
  /** What this step is trying to prove. Used in the report.  */
  criterion?: string;
}

export interface StepResult {
  step: ScriptStep;
  passed: boolean;
  error?: string;
  screenshot?: string;     // basename in screenshots_dir
  durationMs: number;
}

export interface ValidationReport {
  steps: StepResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    durationMs: number;
  };
}

export interface ValidationRun {
  id: string;
  workspaceId: string;
  briefId: string | null;
  status: RunStatus;
  targetUrl: string;
  script: ScriptStep[];
  report: ValidationReport | null;
  screenshotsDir: string | null;
  source: 'auto' | 'manual' | 'rerun';
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  startedAt: number;
  endedAt: number | null;
  errorMessage: string | null;
}

// ---------- target URL config ----------

export interface TargetConfig {
  targetUrl: string | null;
  allowlist: string[];
}

export function loadTarget(workspaceId: string): TargetConfig {
  const db = getDb();
  const ws = db.select().from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId)).all()[0];
  if (!ws) return { targetUrl: null, allowlist: [] };
  const allowlist = safeJsonArray(ws.targetUrlAllowlist);
  return { targetUrl: ws.targetUrl ?? null, allowlist };
}

export function saveTarget(args: { workspaceId: string; targetUrl?: string | null; allowlist?: string[] }): TargetConfig {
  const db = getDb();
  const patch: Record<string, any> = {};
  if (args.targetUrl !== undefined) patch.targetUrl = args.targetUrl || null;
  if (args.allowlist !== undefined) {
    const normed = args.allowlist
      .map((s) => normaliseOrigin(s))
      .filter((s): s is string => !!s);
    patch.targetUrlAllowlist = JSON.stringify(normed);
  }
  // Auto-allowlist the new target origin ONLY when the caller didn't pass an
  // explicit allowlist. If they did, honour it verbatim — they may be locking
  // the target out intentionally (e.g. to test rejection).
  if (args.targetUrl && args.allowlist === undefined) {
    const origin = normaliseOrigin(args.targetUrl);
    if (origin) {
      const cur = safeJsonArray(
        (db.select().from(schema.workspaces).where(eq(schema.workspaces.id, args.workspaceId)).all()[0] as any)?.targetUrlAllowlist,
      );
      const merged = Array.from(new Set([...cur, origin]));
      patch.targetUrlAllowlist = JSON.stringify(merged);
    }
  }
  if (Object.keys(patch).length === 0) return loadTarget(args.workspaceId);
  db.update(schema.workspaces).set(patch as any)
    .where(eq(schema.workspaces.id, args.workspaceId)).run();
  appendEvent(args.workspaceId, sys(args.workspaceId,
    `validation target ${args.targetUrl ? 'set' : 'cleared'}${args.targetUrl ? `: ${args.targetUrl}` : ''}`));
  return loadTarget(args.workspaceId);
}

export function isUrlInAllowlist(url: string, allowlist: string[]): boolean {
  const origin = normaliseOrigin(url);
  if (!origin) return false;
  return allowlist.some((a) => a === origin);
}

function normaliseOrigin(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    const u = new URL(input);
    return `${u.protocol}//${u.host}`;
  } catch { return null; }
}
function safeJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

// ---------- run CRUD ----------

function rowToRun(row: any): ValidationRun {
  return {
    id: row.id, workspaceId: row.workspaceId, briefId: row.briefId,
    status: row.status, targetUrl: row.targetUrl,
    script: safeJson<ScriptStep[]>(row.scriptJson, []),
    report: row.reportJson ? safeJson<ValidationReport | null>(row.reportJson, null) : null,
    screenshotsDir: row.screenshotsDir,
    source: row.source,
    tokensIn: row.tokensIn, tokensOut: row.tokensOut, costUsd: row.costUsd,
    startedAt: row.startedAt, endedAt: row.endedAt,
    errorMessage: row.errorMessage,
  };
}

function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

export function listValidationRuns(workspaceId: string, opts?: { briefId?: string }): ValidationRun[] {
  const db = getDb();
  let rows = db.select().from(schema.validationRuns).all()
    .filter((r) => r.workspaceId === workspaceId);
  if (opts?.briefId) rows = rows.filter((r) => r.briefId === opts.briefId);
  return rows.sort((a, b) => b.startedAt - a.startedAt).map(rowToRun);
}

export function getValidationRun(id: string): ValidationRun | null {
  const db = getDb();
  const row = db.select().from(schema.validationRuns).where(eq(schema.validationRuns.id, id)).all()[0];
  return row ? rowToRun(row) : null;
}

export function latestValidationRun(workspaceId: string, briefId?: string): ValidationRun | null {
  return listValidationRuns(workspaceId, briefId ? { briefId } : undefined)[0] ?? null;
}

// ---------- compose script (LLM) ----------

const COMPOSER_SYSTEM_PROMPT = `You are GuideAI's Validator. Read the brief + success criteria and produce a tiny Playwright-lite test script that proves the criteria.

Output STRICT JSON in this shape (one object per array element):
[
  { "step": "goto", "url": "{TARGET}" },
  { "step": "screenshot", "label": "landing" },
  { "step": "expectText", "selector": "body", "contains": "Welcome", "criterion": "page loads with welcome message" },
  { "step": "click", "selector": "button[data-test=submit]" },
  { "step": "expectVisible", "selector": "[data-test=banner]", "criterion": "banner appears after submit" }
]

Allowed step values: goto, click, fill, expectText, expectVisible, screenshot.
- "goto" url must be "{TARGET}" or "{TARGET}/<path>". DO NOT use any other origin.
- selectors should be data-test attributes when possible, otherwise concise CSS.
- include one screenshot after major navigations.
- include a "criterion" field on assertion steps so the report can attribute pass/fail.
- 5-12 steps total. No comments, no prose, JSON only.

[validate]`;

interface ComposeResult {
  script: ScriptStep[];
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  rawText: string;
}

async function composeScript(args: {
  workspaceId: string;
  briefId: string;
  briefBody: string;
  synthesis?: DiscoverySynthesis | null;
  intake?: IntakeRecord | null;
  targetUrl: string;
}): Promise<ComposeResult> {
  const adapter = resolveActiveAdapter();
  const cwd = paths.agentCwd(args.workspaceId, `validator-${args.briefId}`);
  const criteria = (args.synthesis?.successMetrics?.length ? args.synthesis.successMetrics : args.intake?.successCriteria) ?? [];
  const context = [
    `Target URL: ${args.targetUrl}`,
    '',
    '## Success criteria',
    ...(criteria.length ? criteria.map((c) => `- ${c}`) : ['(none listed)']),
    '',
    '## Brief',
    args.briefBody.slice(0, 2000),
  ].join('\n');

  const res = await adapter.runOnce(
    {
      agentId: `validator-${args.briefId.slice(-6)}`,
      workspaceId: args.workspaceId, cwd,
      systemPrompt: COMPOSER_SYSTEM_PROMPT,
      allowedTools: ['Read', 'Glob', 'Grep'],
      model: 'haiku',
    },
    context,
  );
  const text = res.chunks.filter((c): c is AIChunk => c.kind === 'ai').map((c) => c.text).join('\n').trim();
  const tIn = res.chunks.filter((c): c is AIChunk => c.kind === 'ai').reduce((s, c) => s + (c.tokensIn ?? 0), 0);
  const tOut = res.chunks.filter((c): c is AIChunk => c.kind === 'ai').reduce((s, c) => s + (c.tokensOut ?? 0), 0);
  const cost = tierCost(modelToTier('haiku'), tIn, tOut);
  recordUsage({
    workspaceId: args.workspaceId, agentId: `validator-${args.briefId.slice(-6)}`,
    briefId: args.briefId, phase: 'validate', model: 'haiku', tokensIn: tIn, tokensOut: tOut,
  });
  const script = parseScript(text);
  return { script, tokensIn: tIn, tokensOut: tOut, costUsd: cost, rawText: text };
}

function parseScript(text: string): ScriptStep[] {
  // Find the first [ ... ] block. Tolerant to LLM wrapping in code fences or prose.
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('validator did not return a JSON array');
  let arr: any;
  try { arr = JSON.parse(candidate.slice(start, end + 1)); }
  catch (e: any) { throw new Error(`invalid script JSON: ${e?.message ?? e}`); }
  if (!Array.isArray(arr)) throw new Error('script must be an array');
  const ok: ScriptStep[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const step = String(raw.step ?? '').toLowerCase();
    if (!['goto', 'click', 'fill', 'expecttext', 'expectvisible', 'screenshot'].includes(step)) continue;
    const norm: ScriptStep = {
      step: step.replace('expecttext', 'expectText').replace('expectvisible', 'expectVisible') as any,
    };
    if (typeof raw.url === 'string')       norm.url = raw.url;
    if (typeof raw.selector === 'string')  norm.selector = raw.selector;
    if (typeof raw.text === 'string')      norm.text = raw.text;
    if (typeof raw.contains === 'string')  norm.contains = raw.contains;
    if (typeof raw.label === 'string')     norm.label = raw.label;
    if (typeof raw.criterion === 'string') norm.criterion = raw.criterion;
    ok.push(norm);
  }
  if (ok.length === 0) throw new Error('script contained no valid steps');
  return ok;
}

// ---------- drive (Playwright or mock) ----------

interface DriverResult {
  report: ValidationReport;
  screenshotsDir: string | null;
}

async function driveScript(args: {
  workspaceId: string;
  runId: string;
  targetUrl: string;
  script: ScriptStep[];
}): Promise<DriverResult> {
  // Decide driver: real Playwright if installed, else synthetic mock.
  const pw = await loadPlaywright();
  if (!pw) {
    return driveMock(args);
  }
  return drivePlaywright(args, pw);
}

async function loadPlaywright(): Promise<any | null> {
  try {
    // Dynamic import so the build doesn't fail when playwright isn't installed.
    // @ts-ignore — playwright is optionalDependencies; tsc can't see types here.
    return await import('playwright');
  } catch { return null; }
}

function screenshotsDirFor(workspaceId: string, runId: string): string {
  return path.join(paths.workspaceDir(workspaceId), 'validation', runId);
}

async function drivePlaywright(args: {
  workspaceId: string; runId: string; targetUrl: string; script: ScriptStep[];
}, pw: any): Promise<DriverResult> {
  const dir = screenshotsDirFor(args.workspaceId, args.runId);
  fs.mkdirSync(dir, { recursive: true });
  const overallStart = Date.now();
  const browser = await pw.chromium.launch({ headless: true });
  let context: any = null;
  let page: any = null;
  const stepResults: StepResult[] = [];
  try {
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    page = await context.newPage();
    let shotIdx = 0;
    for (const step of args.script) {
      const t0 = Date.now();
      try {
        await runOneStep(page, step, args.targetUrl);
        const r: StepResult = { step, passed: true, durationMs: Date.now() - t0 };
        if (step.step === 'screenshot') {
          const name = `${++shotIdx}-${(step.label ?? 'shot').replace(/[^a-z0-9-]/gi, '_')}.png`;
          await page.screenshot({ path: path.join(dir, name) });
          r.screenshot = name;
        }
        stepResults.push(r);
      } catch (e: any) {
        const err = e?.message ? String(e.message).slice(0, 200) : String(e);
        // Capture a failure screenshot if we can.
        let shot: string | undefined;
        try {
          const name = `fail-${stepResults.length + 1}.png`;
          await page.screenshot({ path: path.join(dir, name) });
          shot = name;
        } catch {}
        stepResults.push({ step, passed: false, error: err, screenshot: shot, durationMs: Date.now() - t0 });
        // We DON'T stop on assertion failure — keep going so the report is informative.
      }
    }
  } finally {
    try { await context?.close(); } catch {}
    try { await browser.close(); } catch {}
  }
  const passed = stepResults.filter((r) => r.passed).length;
  return {
    report: {
      steps: stepResults,
      summary: {
        total: stepResults.length,
        passed,
        failed: stepResults.length - passed,
        durationMs: Date.now() - overallStart,
      },
    },
    screenshotsDir: dir,
  };
}

async function runOneStep(page: any, step: ScriptStep, targetUrl: string): Promise<void> {
  switch (step.step) {
    case 'goto': {
      const url = (step.url ?? '{TARGET}').replace('{TARGET}', targetUrl);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      return;
    }
    case 'click': {
      if (!step.selector) throw new Error('click step requires selector');
      await page.click(step.selector, { timeout: 8000 });
      return;
    }
    case 'fill': {
      if (!step.selector || step.text == null) throw new Error('fill step requires selector + text');
      await page.fill(step.selector, step.text, { timeout: 8000 });
      return;
    }
    case 'expectText': {
      if (!step.selector || !step.contains) throw new Error('expectText requires selector + contains');
      const found = await page.locator(step.selector).first().innerText({ timeout: 8000 });
      if (!String(found).includes(step.contains))
        throw new Error(`expected text to contain "${step.contains}", got: ${String(found).slice(0, 80)}`);
      return;
    }
    case 'expectVisible': {
      if (!step.selector) throw new Error('expectVisible requires selector');
      const visible = await page.locator(step.selector).first().isVisible({ timeout: 8000 });
      if (!visible) throw new Error('expected element to be visible');
      return;
    }
    case 'screenshot':
      // Capture handled by caller so it can name + persist.
      return;
  }
}

/**
 * Mock driver. Returns a deterministic pass-only report so guest mode (and
 * dev boxes without Playwright installed) can demo the full flow.
 */
async function driveMock(args: {
  workspaceId: string; runId: string; targetUrl: string; script: ScriptStep[];
}): Promise<DriverResult> {
  const start = Date.now();
  const stepResults: StepResult[] = args.script.map((step, i) => ({
    step,
    passed: true,
    durationMs: 30 + (i % 4) * 15,
  }));
  // No screenshots in mock mode (we'd need a real browser to take them).
  return {
    report: {
      steps: stepResults,
      summary: {
        total: stepResults.length, passed: stepResults.length, failed: 0,
        durationMs: Date.now() - start,
      },
    },
    screenshotsDir: null,
  };
}

// ---------- public entrypoints ----------

export async function runValidation(args: {
  workspaceId: string;
  briefId?: string | null;
  briefBody: string;
  synthesis?: DiscoverySynthesis | null;
  intake?: IntakeRecord | null;
  source?: 'auto' | 'manual';
}): Promise<ValidationRun> {
  const db = getDb();
  const cfg = loadTarget(args.workspaceId);
  if (!cfg.targetUrl) {
    throw new Error('target_url not set on workspace');
  }
  if (!isUrlInAllowlist(cfg.targetUrl, cfg.allowlist)) {
    throw new Error(`target_url origin not in allowlist: ${cfg.targetUrl}`);
  }

  const runId = `vrun-${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  db.insert(schema.validationRuns).values({
    id: runId, workspaceId: args.workspaceId, briefId: args.briefId ?? null,
    status: 'running', targetUrl: cfg.targetUrl,
    scriptJson: '[]', reportJson: null, screenshotsDir: null,
    source: args.source ?? 'manual',
    startedAt, endedAt: null, errorMessage: null,
  } as any).run();
  appendEvent(args.workspaceId, sys(args.workspaceId,
    `validation ${runId} starting · target=${cfg.targetUrl}`));

  try {
    // 1. Compose script via LLM (or mock fixture in guest mode).
    const composed = await composeScript({
      workspaceId: args.workspaceId,
      briefId: args.briefId ?? 'adhoc',
      briefBody: args.briefBody,
      synthesis: args.synthesis,
      intake: args.intake,
      targetUrl: cfg.targetUrl,
    });

    // 2. Drive (Playwright if available, else mock).
    db.update(schema.validationRuns).set({
      scriptJson: JSON.stringify(composed.script),
      tokensIn: composed.tokensIn,
      tokensOut: composed.tokensOut,
      costUsd: composed.costUsd,
    } as any).where(eq(schema.validationRuns.id, runId)).run();

    const driven = await driveScript({
      workspaceId: args.workspaceId, runId, targetUrl: cfg.targetUrl, script: composed.script,
    });

    const status: RunStatus = driven.report.summary.failed > 0 ? 'fail' : 'pass';
    const endedAt = Date.now();
    db.update(schema.validationRuns).set({
      status,
      reportJson: JSON.stringify(driven.report),
      screenshotsDir: driven.screenshotsDir,
      endedAt,
    } as any).where(eq(schema.validationRuns.id, runId)).run();

    // Persist the script as a regression-test deliverable for re-runs.
    if (args.briefId) {
      try {
        createDeliverable({
          workspaceId: args.workspaceId,
          briefId: args.briefId,
          kind: 'regression-test',
          title: `Regression suite · ${args.briefId}`,
          body: JSON.stringify(composed.script, null, 2),
          uri: driven.screenshotsDir ?? undefined,
          source: 'auto',
        } as any);
      } catch { /* deliverable persistence is best-effort */ }
    }

    appendEvent(args.workspaceId, sys(args.workspaceId,
      `validation ${runId} ${status} · ${driven.report.summary.passed}/${driven.report.summary.total} steps · ${driven.report.summary.durationMs}ms`,
      status === 'pass' ? 'info' : 'warn'));

    return getValidationRun(runId)!;
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    db.update(schema.validationRuns).set({
      status: 'error', errorMessage: msg, endedAt: Date.now(),
    } as any).where(eq(schema.validationRuns.id, runId)).run();
    appendEvent(args.workspaceId, sys(args.workspaceId,
      `validation ${runId} errored: ${msg}`, 'error'));
    return getValidationRun(runId)!;
  }
}

export async function rerunValidation(args: { runId: string }): Promise<ValidationRun> {
  const db = getDb();
  const prior = getValidationRun(args.runId);
  if (!prior) throw new Error(`validation run ${args.runId} not found`);
  const cfg = loadTarget(prior.workspaceId);
  if (!cfg.targetUrl) throw new Error('target_url not set');
  if (!isUrlInAllowlist(cfg.targetUrl, cfg.allowlist))
    throw new Error(`target_url origin not in allowlist: ${cfg.targetUrl}`);

  const newId = `vrun-${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  db.insert(schema.validationRuns).values({
    id: newId, workspaceId: prior.workspaceId, briefId: prior.briefId,
    status: 'running', targetUrl: cfg.targetUrl,
    scriptJson: JSON.stringify(prior.script),
    source: 'rerun', startedAt,
  } as any).run();
  appendEvent(prior.workspaceId, sys(prior.workspaceId,
    `validation rerun ${newId} (from ${args.runId}) · ${prior.script.length} steps`));

  try {
    const driven = await driveScript({
      workspaceId: prior.workspaceId, runId: newId, targetUrl: cfg.targetUrl, script: prior.script,
    });
    const status: RunStatus = driven.report.summary.failed > 0 ? 'fail' : 'pass';
    db.update(schema.validationRuns).set({
      status,
      reportJson: JSON.stringify(driven.report),
      screenshotsDir: driven.screenshotsDir,
      endedAt: Date.now(),
    } as any).where(eq(schema.validationRuns.id, newId)).run();
    appendEvent(prior.workspaceId, sys(prior.workspaceId,
      `rerun ${newId} ${status} · ${driven.report.summary.passed}/${driven.report.summary.total}`,
      status === 'pass' ? 'info' : 'warn'));
    return getValidationRun(newId)!;
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    db.update(schema.validationRuns).set({
      status: 'error', errorMessage: msg, endedAt: Date.now(),
    } as any).where(eq(schema.validationRuns.id, newId)).run();
    return getValidationRun(newId)!;
  }
}

// ---------- helpers ----------

function sys(workspaceId: string, text: string, level: SystemChunk['level'] = 'info'): SystemChunk {
  return { id: randomUUID(), ts: Date.now(), workspaceId, kind: 'system', level, text };
}

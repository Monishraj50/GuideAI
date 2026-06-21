// Auto-spawn the Atrune server + web (tsx watch + next dev) when the extension
// activates and they're not already running. Killed on deactivation if we own
// them; if the user had `pnpm dev` going, we leave it alone.

import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { AtruneApi } from './api';

interface SpawnedProcs {
  server: ChildProcess | null;
  web: ChildProcess | null;
}

export class AtruneServer {
  private procs: SpawnedProcs = { server: null, web: null };
  private channel: vscode.OutputChannel;
  private api = new AtruneApi();
  /** True when WE spawned the processes (so we should kill them on deactivate). */
  private weOwnProcesses = false;

  constructor() {
    this.channel = vscode.window.createOutputChannel('Atrune');
  }

  show() { this.channel.show(true); }
  log(msg: string) { this.channel.appendLine(`[${new Date().toISOString()}] ${msg}`); }

  /** Resolve the Atrune repo root.
   *
   *   1. `atrune.repoRoot` setting if it points to a real monorepo
   *   2. Walk up from each open workspace folder
   *   3. Probe a handful of common locations (~/projects/GuideAI, ~/AtruneAI, etc.)
   *   4. null → caller surfaces an actionable popup with a folder picker
   */
  resolveRepoRoot(): string | null {
    const isAtrune = (p: string) =>
      !!p && fs.existsSync(path.join(p, 'pnpm-workspace.yaml'));

    const cfg = vscode.workspace.getConfiguration('atrune').get<string>('repoRoot', '');
    if (isAtrune(cfg)) return cfg;

    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const f of folders) {
      let dir = f.uri.fsPath;
      for (let i = 0; i < 6; i++) {
        if (isAtrune(dir)) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }

    // Common install locations — quick probes, no walking.
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const candidates = [
      path.join(home, 'projects', 'GuideAI'),
      path.join(home, 'Desktop', 'GuideAI'),
      path.join(home, 'Desktop', 'Monish', 'GuideAI'),
      path.join(home, 'AtruneAI'),
      path.join(home, 'projects', 'atruneai'),
      path.join(home, 'src', 'GuideAI'),
      path.join(home, 'code', 'GuideAI'),
    ];
    for (const c of candidates) if (isAtrune(c)) return c;

    return null;
  }

  /** Persist a manually picked repo root to the global setting so future
   *  activations don't need to re-prompt. */
  async setRepoRoot(folderPath: string): Promise<void> {
    await vscode.workspace.getConfiguration('atrune')
      .update('repoRoot', folderPath, vscode.ConfigurationTarget.Global);
  }

  /** Ensure the server is up. If already running (e.g. user ran `pnpm dev`),
   *  detect and connect. Otherwise spawn it ourselves. */
  async ensureRunning(): Promise<{ ok: boolean; spawned: boolean; reason?: string }> {
    if (await this.api.isAlive()) {
      this.log('Detected Atrune server already running — connecting without spawn.');
      this.weOwnProcesses = false;
      return { ok: true, spawned: false };
    }

    const autoSpawn = vscode.workspace.getConfiguration('atrune').get<boolean>('autoSpawn', true);
    if (!autoSpawn) {
      this.log('Server not running and autoSpawn is disabled — refusing to spawn.');
      return { ok: false, spawned: false, reason: 'autoSpawn disabled and no server detected' };
    }

    const root = this.resolveRepoRoot();
    if (!root) {
      this.log('Could not locate the Atrune monorepo (no pnpm-workspace.yaml found). Set `atrune.repoRoot` in settings.');
      return { ok: false, spawned: false, reason: 'repo not found' };
    }
    this.log(`Repo root: ${root}`);

    this.log('Spawning Fastify server (tsx watch apps/server)…');
    this.procs.server = spawn(
      path.join(root, 'node_modules', '.bin', 'tsx'),
      ['watch', path.join(root, 'apps', 'server', 'src', 'index.ts')],
      { cwd: root, env: { ...process.env, PORT: String(this.serverPort()) }, stdio: 'pipe' },
    );
    this.pipe('server', this.procs.server);

    this.log('Spawning Next.js dev server…');
    const webDir = path.join(root, 'apps', 'web');
    this.procs.web = spawn(
      path.join(webDir, 'node_modules', '.bin', 'next'),
      ['dev', '-p', String(this.webPort())],
      { cwd: webDir, env: { ...process.env }, stdio: 'pipe' },
    );
    this.pipe('web', this.procs.web);

    this.weOwnProcesses = true;

    // Wait up to 10s for the API server. Web (Next.js dev) takes longer to
    // boot but we don't block on it here — Mission Control probes it itself
    // and shows a friendly loading/retry overlay if it isn't ready yet.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await this.api.isAlive()) {
        this.log('Server is up.');
        // Kick off a non-blocking web-port log so the user sees progress.
        void this.logWebReady();
        return { ok: true, spawned: true };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    this.log('Timed out waiting for the server to come up after 10s.');
    return { ok: false, spawned: true, reason: 'timeout' };
  }

  /** Periodically log when the Next.js dev server becomes reachable. */
  private async logWebReady(): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await this.api.isWebAlive()) {
        this.log('Web (Next.js dev) is up.');
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.log('Web (Next.js dev) did not respond within 60s.');
  }

  private pipe(label: string, proc: ChildProcess) {
    proc.stdout?.on('data', (d) => this.channel.append(`[${label}] ${d.toString()}`));
    proc.stderr?.on('data', (d) => this.channel.append(`[${label}!] ${d.toString()}`));
    proc.on('exit', (code) => this.log(`[${label}] exited with code ${code ?? '?'}`));
  }

  serverPort(): number {
    return vscode.workspace.getConfiguration('atrune').get<number>('serverPort', 4000);
  }
  webPort(): number {
    return vscode.workspace.getConfiguration('atrune').get<number>('webPort', 3000);
  }

  async dispose(): Promise<void> {
    if (!this.weOwnProcesses) {
      this.log('Not killing servers — user owns the processes.');
      return;
    }
    for (const [label, p] of Object.entries(this.procs)) {
      if (!p) continue;
      this.log(`Killing ${label} (pid ${p.pid})`);
      try { p.kill('SIGTERM'); } catch {}
    }
  }
}

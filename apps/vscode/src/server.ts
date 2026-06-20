// Auto-spawn the Atrium server + web (tsx watch + next dev) when the extension
// activates and they're not already running. Killed on deactivation if we own
// them; if the user had `pnpm dev` going, we leave it alone.

import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { AtriumApi } from './api';

interface SpawnedProcs {
  server: ChildProcess | null;
  web: ChildProcess | null;
}

export class AtriumServer {
  private procs: SpawnedProcs = { server: null, web: null };
  private channel: vscode.OutputChannel;
  private api = new AtriumApi();
  /** True when WE spawned the processes (so we should kill them on deactivate). */
  private weOwnProcesses = false;

  constructor() {
    this.channel = vscode.window.createOutputChannel('Atrium');
  }

  show() { this.channel.show(true); }
  log(msg: string) { this.channel.appendLine(`[${new Date().toISOString()}] ${msg}`); }

  /** Resolve the Atrium repo root. Try config first, then auto-detect from
   *  the open workspace folder, then walk up looking for pnpm-workspace.yaml. */
  private resolveRepoRoot(): string | null {
    const cfg = vscode.workspace.getConfiguration('atrium').get<string>('repoRoot', '');
    if (cfg && fs.existsSync(path.join(cfg, 'pnpm-workspace.yaml'))) return cfg;

    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const f of folders) {
      let dir = f.uri.fsPath;
      for (let i = 0; i < 6; i++) {
        if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    return null;
  }

  /** Ensure the server is up. If already running (e.g. user ran `pnpm dev`),
   *  detect and connect. Otherwise spawn it ourselves. */
  async ensureRunning(): Promise<{ ok: boolean; spawned: boolean; reason?: string }> {
    if (await this.api.isAlive()) {
      this.log('Detected Atrium server already running — connecting without spawn.');
      this.weOwnProcesses = false;
      return { ok: true, spawned: false };
    }

    const autoSpawn = vscode.workspace.getConfiguration('atrium').get<boolean>('autoSpawn', true);
    if (!autoSpawn) {
      this.log('Server not running and autoSpawn is disabled — refusing to spawn.');
      return { ok: false, spawned: false, reason: 'autoSpawn disabled and no server detected' };
    }

    const root = this.resolveRepoRoot();
    if (!root) {
      this.log('Could not locate the Atrium monorepo (no pnpm-workspace.yaml found). Set `atrium.repoRoot` in settings.');
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

    // Wait up to 10s for the server to come alive.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await this.api.isAlive()) {
        this.log('Server is up.');
        return { ok: true, spawned: true };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    this.log('Timed out waiting for the server to come up after 10s.');
    return { ok: false, spawned: true, reason: 'timeout' };
  }

  private pipe(label: string, proc: ChildProcess) {
    proc.stdout?.on('data', (d) => this.channel.append(`[${label}] ${d.toString()}`));
    proc.stderr?.on('data', (d) => this.channel.append(`[${label}!] ${d.toString()}`));
    proc.on('exit', (code) => this.log(`[${label}] exited with code ${code ?? '?'}`));
  }

  serverPort(): number {
    return vscode.workspace.getConfiguration('atrium').get<number>('serverPort', 4000);
  }
  webPort(): number {
    return vscode.workspace.getConfiguration('atrium').get<number>('webPort', 3000);
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

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { paths } from '../paths.js';
import * as schema from './schema.js';
import { initDbAt } from './init.js';

type DrizzleDb = ReturnType<typeof drizzle>;

// Per-folder DB handle cache. The server keeps one Database instance per
// consented project folder so cross-window requests don't trample each
// other's state. Keyed by absolute folder path (NOT the db.sqlite path).
const handles = new Map<string, DrizzleDb>();

// Default fallback handle: used by code paths that don't run inside a
// per-request scope (CLI tools, scripts, startup tasks). Resolved on
// first use from `paths.db`, which reads ATRUNE_DB_PATH.
let defaultHandle: DrizzleDb | null = null;

// Async-local storage carries the current request's workspace folder so
// every `getDb()` call inside the same Fastify handler sees the right DB
// without each route having to thread it through manually.
const requestScope = new AsyncLocalStorage<{ folder: string }>();

/** Run `fn` with `folder` set as the active workspace. Every `getDb()`
 *  inside (including transitive calls through orchestrator code) returns
 *  that folder's `<folder>/.atrune/db.sqlite`. */
export function withWorkspaceDb<T>(folder: string, fn: () => T): T {
  return requestScope.run({ folder }, fn);
}

/** Set the workspace folder for the current async context without needing
 *  a wrapping callback. Used by the server's Fastify onRequest hook so the
 *  rest of the request (route handler + transitive async work) sees the
 *  right DB via `getDb()`. */
export function setWorkspaceContext(folder: string): void {
  requestScope.enterWith({ folder });
}

function openHandle(dbPath: string): DrizzleDb {
  // First-touch creation: ensure schema is in place.
  const exists = fs.existsSync(dbPath);
  if (!exists) {
    initDbAt(dbPath);
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite, { schema });
}

/** Returns the Drizzle handle for the active workspace (from AsyncLocal
 *  context) if set, else the env-default DB. Handles are cached per
 *  folder so repeat calls return the same handle. */
export function getDb(): DrizzleDb {
  const ctx = requestScope.getStore();
  if (ctx?.folder) {
    const dbPath = path.join(ctx.folder, '.atrune', 'db.sqlite');
    let h = handles.get(ctx.folder);
    if (!h) {
      h = openHandle(dbPath);
      handles.set(ctx.folder, h);
    }
    return h;
  }
  if (!defaultHandle) {
    defaultHandle = openHandle(paths.db);
  }
  return defaultHandle;
}

/** Drop the cached handle for `folder` (e.g. when consent is revoked
 *  and the file is gone). The next `getDb()` for that folder will
 *  re-init from scratch if needed. */
export function evictDbHandle(folder: string): void {
  handles.delete(folder);
}

export { schema };
export { initDb, initDbIfMissing, initDbAt } from './init.js';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { paths } from '../paths.js';
import * as schema from './schema.js';
import { initDbAt } from './init.js';

type DrizzleDb = ReturnType<typeof drizzle>;
type NativeSqlite = InstanceType<typeof Database>;

// Per-folder DB handle cache. The server keeps one Database instance per
// consented project folder so cross-window requests don't trample each
// other's state. Keyed by absolute folder path (NOT the db.sqlite path).
//
// Alongside the drizzle wrapper we track:
//   - the underlying better-sqlite3 Database instance (so we can close it), and
//   - the inode of the file at open time (so we can detect delete+recreate).
// Both are essential for the "user rm -rf .atrune/ then re-consents" path —
// without them, Better-SQLite3 keeps serving rows from the deleted (but still
// open) file for as long as the FD lives.
interface CachedHandle {
  db: DrizzleDb;
  sqlite: NativeSqlite;
  inode: number | null;
  dbPath: string;
}
const handles = new Map<string, CachedHandle>();

// Default fallback handle: used by code paths that don't run inside a
// per-request scope (CLI tools, scripts, startup tasks). Resolved on
// first use from `paths.db`, which reads ATRUNE_DB_PATH.
let defaultHandle: CachedHandle | null = null;

/** Read the inode of a file. Returns null when the file doesn't exist —
 *  used as a stale-cache signal. */
function safeInode(p: string): number | null {
  try { return fs.statSync(p).ino; } catch { return null; }
}

/** True when the handle's file is missing on disk OR has a different inode
 *  (i.e. was deleted + recreated). Either way the cached handle is stale. */
function isHandleStale(h: CachedHandle): boolean {
  const nowIno = safeInode(h.dbPath);
  if (nowIno === null) return true;          // file gone
  if (h.inode !== null && nowIno !== h.inode) return true;  // recreated
  return false;
}

function closeQuietly(h: CachedHandle): void {
  try { h.sqlite.close(); } catch {}
}

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

function openHandle(dbPath: string): CachedHandle {
  // First-touch creation: ensure schema is in place.
  const exists = fs.existsSync(dbPath);
  if (!exists) {
    initDbAt(dbPath);
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return {
    db: drizzle(sqlite, { schema }),
    sqlite,
    inode: safeInode(dbPath),
    dbPath,
  };
}

/** Returns the Drizzle handle for the active workspace (from AsyncLocal
 *  context) if set, else the env-default DB. Handles are cached per
 *  folder — but before returning we check the file's inode against the
 *  cached one so a deleted+recreated `.atrune/db.sqlite` doesn't keep
 *  serving rows from the ghost file (Unix keeps the inode alive while
 *  a FD is open; users don't expect that after `rm -rf .atrune/`). */
export function getDb(): DrizzleDb {
  const ctx = requestScope.getStore();
  if (ctx?.folder) {
    const dbPath = path.join(ctx.folder, '.atrune', 'db.sqlite');
    let h = handles.get(ctx.folder);
    if (h && isHandleStale(h)) {
      closeQuietly(h);
      handles.delete(ctx.folder);
      h = undefined;
    }
    if (!h) {
      h = openHandle(dbPath);
      handles.set(ctx.folder, h);
    }
    return h.db;
  }
  if (defaultHandle && isHandleStale(defaultHandle)) {
    closeQuietly(defaultHandle);
    defaultHandle = null;
  }
  if (!defaultHandle) {
    defaultHandle = openHandle(paths.db);
  }
  return defaultHandle.db;
}

/** Drop the cached handle for `folder` (e.g. when consent is revoked
 *  and the file is gone). The next `getDb()` for that folder will
 *  re-init from scratch if needed. */
export function evictDbHandle(folder: string): void {
  const h = handles.get(folder);
  if (h) closeQuietly(h);
  handles.delete(folder);
}

/** Wipe every cached handle. Used from the extension on consent-transition
 *  respawn — belt to the server-side inode check. */
export function evictAllDbHandles(): void {
  for (const h of handles.values()) closeQuietly(h);
  handles.clear();
  if (defaultHandle) { closeQuietly(defaultHandle); defaultHandle = null; }
}

export { schema };
export { initDb, initDbIfMissing, initDbAt } from './init.js';

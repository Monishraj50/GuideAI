import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { paths } from '../paths.js';
import * as schema from './schema.js';

let cached: ReturnType<typeof drizzle> | null = null;

export function getDb() {
  if (cached) return cached;
  const sqlite = new Database(paths.db);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  cached = drizzle(sqlite, { schema });
  return cached;
}

export { schema };
export { initDb, initDbIfMissing } from './init.js';

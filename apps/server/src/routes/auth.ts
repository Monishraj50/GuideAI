import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@guideai/shared/db';
import { paths } from '@guideai/shared/paths';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

interface SessionRow {
  token: string;
  username: string;
  displayName?: string;
  isGuest: boolean;
  createdAt: number;
}

// In-memory session store. Lost on server restart, which is fine for a
// local-first dev tool. Cookie + session.json carry across restarts via
// a re-sign-in flow.
const SESSIONS = new Map<string, SessionRow>();
const COOKIE_NAME = 'guideai_session';
const SESSION_FILE = path.join(paths.home, 'session.json');

function newToken() { return randomBytes(24).toString('hex'); }
function newSalt()  { return randomBytes(16).toString('hex'); }

async function hashPassword(password: string, salt: string): Promise<string> {
  const buf = await scryptAsync(password, Buffer.from(salt, 'hex'), 64);
  return buf.toString('hex');
}

async function verifyPassword(password: string, salt: string, expected: string): Promise<boolean> {
  const buf = await scryptAsync(password, Buffer.from(salt, 'hex'), 64);
  const exp = Buffer.from(expected, 'hex');
  return buf.length === exp.length && timingSafeEqual(buf, exp);
}

function parseCookies(req: FastifyRequest): Record<string, string> {
  const raw = req.headers.cookie ?? '';
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(reply: FastifyReply, token: string) {
  reply.header('Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
}
function clearSessionCookie(reply: FastifyReply) {
  reply.header('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function currentSession(req: FastifyRequest): SessionRow | null {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  return SESSIONS.get(token) ?? null;
}

function writeSessionFile(row: SessionRow | null) {
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  if (!row) {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
    return;
  }
  fs.writeFileSync(SESSION_FILE,
    JSON.stringify({ username: row.username, displayName: row.displayName, isGuest: row.isGuest, since: row.createdAt }, null, 2),
    { mode: 0o600 });
}

function publicSession(row: SessionRow | null) {
  if (!row) return { authed: false };
  return {
    authed: true,
    user: { username: row.username, displayName: row.displayName ?? row.username, isGuest: row.isGuest },
  };
}

function validateCredentials(username: string, password: string): string | null {
  if (!username || username.length < 3) return 'Username must be at least 3 characters.';
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return 'Username can only contain letters, numbers, _ . -';
  if (!password || password.length < 6)  return 'Password must be at least 6 characters.';
  return null;
}

export function registerAuthRoutes(app: FastifyInstance) {
  // Status — read the cookie, return current session.
  app.get('/api/auth/status', async (req) => publicSession(currentSession(req)));

  // Sign up — create user + auto-sign-in.
  app.post<{ Body: { username?: string; password?: string; displayName?: string } }>(
    '/api/auth/signup',
    async (req, reply) => {
      const username = (req.body?.username ?? '').toString().trim().toLowerCase();
      const password = (req.body?.password ?? '').toString();
      const displayName = (req.body?.displayName ?? username).toString().trim() || username;
      const err = validateCredentials(username, password);
      if (err) { reply.code(400); return { error: err }; }

      const db = getDb();
      const exists = db.select().from(schema.users).all().find((u) => u.username === username);
      if (exists) { reply.code(409); return { error: 'Username already taken.' }; }

      const salt = newSalt();
      const hash = await hashPassword(password, salt);
      const id = `u-${randomBytes(6).toString('hex')}`;
      db.insert(schema.users).values({
        id, username, displayName,
        passwordHash: hash, salt,
        createdAt: Date.now(),
        lastLoginAt: Date.now(),
      }).run();

      const token = newToken();
      const row: SessionRow = { token, username, displayName, isGuest: false, createdAt: Date.now() };
      SESSIONS.set(token, row);
      writeSessionFile(row);
      setSessionCookie(reply, token);
      return publicSession(row);
    },
  );

  // Sign in — verify, issue session.
  app.post<{ Body: { username?: string; password?: string } }>(
    '/api/auth/signin',
    async (req, reply) => {
      const username = (req.body?.username ?? '').toString().trim().toLowerCase();
      const password = (req.body?.password ?? '').toString();
      if (!username || !password) { reply.code(400); return { error: 'Username and password are required.' }; }

      const db = getDb();
      const u = db.select().from(schema.users).all().find((row) => row.username === username);
      if (!u) { reply.code(401); return { error: 'Invalid username or password.' }; }
      const ok = await verifyPassword(password, u.salt, u.passwordHash);
      if (!ok) { reply.code(401); return { error: 'Invalid username or password.' }; }

      db.update(schema.users).set({ lastLoginAt: Date.now() })
        .where(eq(schema.users.id, u.id)).run();

      const token = newToken();
      const row: SessionRow = { token, username: u.username, displayName: u.displayName ?? u.username, isGuest: false, createdAt: Date.now() };
      SESSIONS.set(token, row);
      writeSessionFile(row);
      setSessionCookie(reply, token);
      return publicSession(row);
    },
  );

  // Guest — no credentials, ephemeral identity.
  app.post<{ Body: { displayName?: string } }>(
    '/api/auth/guest',
    async (req, reply) => {
      const display = (req.body?.displayName ?? '').toString().trim() || 'Guest';
      const username = `guest-${randomBytes(4).toString('hex')}`;
      const token = newToken();
      const row: SessionRow = { token, username, displayName: display, isGuest: true, createdAt: Date.now() };
      SESSIONS.set(token, row);
      writeSessionFile(row);
      setSessionCookie(reply, token);
      return publicSession(row);
    },
  );

  // Sign out — revoke session.
  app.post('/api/auth/signout', async (req, reply) => {
    const token = parseCookies(req)[COOKIE_NAME];
    if (token) SESSIONS.delete(token);
    writeSessionFile(null);
    clearSessionCookie(reply);
    return { ok: true };
  });

  // Change password — current session required.
  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>(
    '/api/auth/password',
    async (req, reply) => {
      const sess = currentSession(req);
      if (!sess || sess.isGuest) { reply.code(401); return { error: 'Sign in required.' }; }
      const cur = (req.body?.currentPassword ?? '').toString();
      const next = (req.body?.newPassword ?? '').toString();
      if (next.length < 6) { reply.code(400); return { error: 'New password must be at least 6 characters.' }; }

      const db = getDb();
      const u = db.select().from(schema.users).all().find((row) => row.username === sess.username);
      if (!u) { reply.code(401); return { error: 'Account missing.' }; }
      if (!await verifyPassword(cur, u.salt, u.passwordHash)) {
        reply.code(401); return { error: 'Current password is incorrect.' };
      }
      const salt = newSalt();
      const hash = await hashPassword(next, salt);
      db.update(schema.users).set({ passwordHash: hash, salt })
        .where(eq(schema.users.id, u.id)).run();
      return { ok: true };
    },
  );

  // Convert guest → registered account in place.
  app.post<{ Body: { username?: string; password?: string; displayName?: string } }>(
    '/api/auth/upgrade-guest',
    async (req, reply) => {
      const sess = currentSession(req);
      if (!sess || !sess.isGuest) { reply.code(400); return { error: 'Only guests can upgrade.' }; }
      const username = (req.body?.username ?? '').toString().trim().toLowerCase();
      const password = (req.body?.password ?? '').toString();
      const displayName = (req.body?.displayName ?? sess.displayName ?? username).toString().trim() || username;
      const err = validateCredentials(username, password);
      if (err) { reply.code(400); return { error: err }; }

      const db = getDb();
      if (db.select().from(schema.users).all().find((u) => u.username === username)) {
        reply.code(409); return { error: 'Username already taken.' };
      }
      const salt = newSalt();
      const hash = await hashPassword(password, salt);
      const id = `u-${randomBytes(6).toString('hex')}`;
      db.insert(schema.users).values({
        id, username, displayName, passwordHash: hash, salt,
        createdAt: Date.now(), lastLoginAt: Date.now(),
      }).run();
      // Rebind the in-memory session to the new identity.
      sess.username = username;
      sess.displayName = displayName;
      sess.isGuest = false;
      writeSessionFile(sess);
      return publicSession(sess);
    },
  );
}

export interface PublicSession {
  authed: boolean;
  user?: { username: string; displayName: string; isGuest: boolean };
}

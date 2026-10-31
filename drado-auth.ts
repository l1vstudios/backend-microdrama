import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { Database } from 'bun:sqlite';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

const cookieName = 'drado_session';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function createDradoAuth(directory: string) {
  const username = Bun.env.DRADO_ADMIN_USERNAME?.trim() || 'admin';
  const passwordHash = Bun.password.hashSync(Bun.env.DRADO_ADMIN_PASSWORD || 'admin');
  const version = digest(`${username}\0${Bun.env.DRADO_ADMIN_PASSWORD || 'admin'}`);
  const configuredDays = Number(Bun.env.DRADO_SESSION_DAYS || 7);
  const days = Number.isFinite(configuredDays) ? Math.min(365, Math.max(1, Math.floor(configuredDays))) : 7;
  const db = new Database(join(directory, 'auth.sqlite'), { create: true });
  db.run('PRAGMA journal_mode = WAL');
  db.run('CREATE TABLE IF NOT EXISTS login_sessions (token_hash TEXT PRIMARY KEY, credential_version TEXT NOT NULL, expires_at INTEGER NOT NULL)');
  db.query('DELETE FROM login_sessions WHERE expires_at <= ? OR credential_version != ?').run(Date.now(), version);
  const user = { id: 'drado-admin', username, displayName: 'Administrator' };
  const router = new Hono();
  const cookieOptions = (url: string) => ({ path: '/api/drado', httpOnly: true, sameSite: 'Lax' as const, secure: Bun.env.DRADO_COOKIE_SECURE === '1' || new URL(url).protocol === 'https:' });
  const failures = new Map<string, { count: number; until: number }>();

  const requireSession: MiddlewareHandler = async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const token = getCookie(c, cookieName);
    const row = token && token.length <= 128 ? db.query('SELECT expires_at FROM login_sessions WHERE token_hash = ? AND credential_version = ?').get(digest(token), version) as { expires_at: number } | null : null;
    if (!row || row.expires_at <= Date.now()) {
      if (token) deleteCookie(c, cookieName, cookieOptions(c.req.url));
      return c.json({ ok: false, error: 'UNAUTHORIZED' }, 401);
    }
    await next();
  };

  router.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  router.post('/login', async c => {
    const key = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
    const previous = failures.get(key);
    if (previous && previous.until > Date.now() && previous.count >= 10) return c.json({ ok: false, error: 'Terlalu banyak percobaan. Coba lagi dalam satu menit.' }, 429);
    const body = await c.req.json().catch(() => null);
    const validInput = body && typeof body.username === 'string' && body.username.length <= 80 && typeof body.password === 'string' && body.password.length <= 1024;
    const validPassword = validInput && await Bun.password.verify(body.password, passwordHash);
    if (!validInput || !validPassword || body.username.trim() !== username) {
      if (failures.size > 1000) failures.clear();
      failures.set(key, { count: previous && previous.until > Date.now() ? previous.count + 1 : 1, until: previous && previous.until > Date.now() ? previous.until : Date.now() + 60000 });
      return c.json({ ok: false, error: 'Username atau password salah.' }, 401);
    }
    failures.delete(key);
    const previousToken = getCookie(c, cookieName);
    if (previousToken) db.query('DELETE FROM login_sessions WHERE token_hash = ?').run(digest(previousToken));
    db.query('DELETE FROM login_sessions WHERE expires_at <= ?').run(Date.now());
    const token = randomBytes(32).toString('base64url');
    db.query('INSERT INTO login_sessions (token_hash, credential_version, expires_at) VALUES (?, ?, ?)').run(digest(token), version, Date.now() + days * 86400000);
    setCookie(c, cookieName, token, { ...cookieOptions(c.req.url), maxAge: days * 86400 });
    return c.json({ ok: true, user });
  });
  router.get('/me', requireSession, c => c.json({ ok: true, user }));
  router.post('/logout', async c => {
    const token = getCookie(c, cookieName);
    if (token) db.query('DELETE FROM login_sessions WHERE token_hash = ?').run(digest(token));
    deleteCookie(c, cookieName, cookieOptions(c.req.url));
    return c.json({ ok: true });
  });
  return { router, requireSession, close: () => db.close() };
}

// Login sessions. Each login is a row in the sessions table; the browser holds a random token in an httpOnly
// cookie and the table keeps only its SHA-256 hash. Deleting the row (log out, log out a device) ends it at once.
import crypto from 'node:crypto';

export const COOKIE = 'session';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// How long a login lasts without activity (idle) and at most (max). "Keep me logged in" lasts longer and survives
// closing the browser; otherwise the cookie goes when the browser closes.
export const SESSION_LIMITS = {
  remember: { idle: 7 * DAY, max: 30 * DAY },
  normal: { idle: 30 * MINUTE, max: 12 * HOUR },
};

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** A short name for the device a login came from, like "Chrome on Android". */
export function deviceName(userAgent = '') {
  const ua = String(userAgent);
  const browser = /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Browser';
  const os = /Android/.test(ua) ? 'Android'
    : /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /Linux/.test(ua) ? 'Linux'
    : 'unknown device';
  return `${browser} on ${os}`;
}

/** Session handling for the app. db: libsql client; now: the clock (tests pass their own). */
export function createSessions(db, { secureCookies, now = Date.now }) {
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: secureCookies, path: '/' };

  return {
    /** Logs `user` in on this browser. */
    async start(req, res, user, remember) {
      const token = crypto.randomBytes(32).toString('base64url');
      const limits = SESSION_LIMITS[remember ? 'remember' : 'normal'];
      const t = now();
      await db.batch([
        // Clear out ended sessions of everyone while we are writing anyway.
        { sql: 'DELETE FROM sessions WHERE expires_at <= ?1 OR last_seen_at + idle_ms <= ?1', args: [t] },
        {
          sql: `INSERT INTO sessions (token_hash, user_id, remember, idle_ms, created_at, last_seen_at, expires_at, device)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [hash(token), user.id, remember ? 1 : 0, limits.idle, t, t, t + limits.max, deviceName(req.headers['user-agent'])],
        },
      ], 'write');
      res.cookie(COOKIE, token, remember ? { ...cookieOptions, maxAge: limits.max } : cookieOptions);
    },

    /**
     * Middleware: sets req.user = { id, role } and req.session = { id, remember, idleMs } for a live session.
     * A session past its limits is deleted. req.sessionEnded tells the routes why a cookie no longer works:
     * 'idle' (too long without activity, or too old) or 'elsewhere' (logged out from another device).
     */
    attach: async (req, res, next) => {
      const token = readCookie(req, COOKIE);
      if (!token) return next();
      const { rows: [s] } = await db.execute({
        sql: `SELECT s.id, s.user_id, s.remember, s.idle_ms, s.last_seen_at, s.expires_at, u.role
              FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
        args: [hash(token)],
      });
      const t = now();
      if (!s || t >= s.expires_at || t - s.last_seen_at >= s.idle_ms) {
        if (s) await db.execute({ sql: 'DELETE FROM sessions WHERE id = ?', args: [s.id] });
        res.clearCookie(COOKIE, cookieOptions);
        req.sessionEnded = s ? 'idle' : 'elsewhere';
        return next();
      }
      // Activity keeps the session going; written at most once a minute.
      if (t - s.last_seen_at > MINUTE) await db.execute({ sql: 'UPDATE sessions SET last_seen_at = ? WHERE id = ?', args: [t, s.id] });
      req.user = { id: s.user_id, role: s.role };
      req.session = { id: s.id, remember: Boolean(s.remember), idleMs: s.idle_ms };
      next();
    },

    /** Logs this browser out. */
    async end(req, res) {
      if (req.session) await db.execute({ sql: 'DELETE FROM sessions WHERE id = ?', args: [req.session.id] });
      res.clearCookie(COOKIE, cookieOptions);
    },
  };
}

/** The answer for a request without a live session. */
export function notLoggedIn(req, res) {
  if (req.sessionEnded === 'idle') {
    return res.status(401).json({ error: 'You were logged out after a while without activity. Please log in again', code: 'session_ended' });
  }
  if (req.sessionEnded === 'elsewhere') {
    return res.status(401).json({ error: 'You were logged out of this device. Please log in again', code: 'session_revoked' });
  }
  return res.status(401).json({ error: 'Please log in' });
}

export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return notLoggedIn(req, res);
    if (req.user.role !== role) return res.status(403).json({ error: `Only ${role}s can do this` });
    next();
  };
}

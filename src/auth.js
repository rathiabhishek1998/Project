import jwt from 'jsonwebtoken';

export const COOKIE = 'token';

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function setAuthCookie(res, user, { jwtSecret, secureCookies }) {
  const token = jwt.sign({ sub: user.id, role: user.role }, jwtSecret, { expiresIn: '7d' });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

/** Sets req.user = { id, role } when the auth cookie holds a valid token. */
export function attachUser(jwtSecret) {
  return (req, _res, next) => {
    const token = readCookie(req, COOKIE);
    if (token) {
      try {
        const payload = jwt.verify(token, jwtSecret);
        req.user = { id: payload.sub, role: payload.role };
      } catch {
        // Expired or tampered token: treat as logged out.
      }
    }
    next();
  };
}

export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Please log in' });
    if (req.user.role !== role) return res.status(403).json({ error: `Only ${role}s can do this` });
    next();
  };
}

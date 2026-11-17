export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export function readCookie(req, name) {
  return parseCookies(req.headers.cookie || '')[name] || null;
}

export function setSessionCookie(res, token, maxAgeSeconds = 60 * 60 * 24 * 30) {
  res.append(
    'Set-Cookie',
    `sf_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`,
  );
}

export function clearSessionCookie(res) {
  res.append('Set-Cookie', 'sf_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

export function toInt(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function str(value, max = 500) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

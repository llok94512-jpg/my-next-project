import { Router } from 'express';
import { all, get, run } from '../db.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import { asyncHandler, clearSessionCookie, HttpError, setSessionCookie, str, toInt } from '../lib/http.js';
import { createSession, destroySession, publicUser, requireAuth } from '../auth.js';
import { audit } from '../lib/notify.js';

const router = Router();
const attempts = new Map();

function throttle(key) {
  const now = Date.now();
  const entry = attempts.get(key) || { count: 0, first: now };
  if (now - entry.first > 10 * 60 * 1000) {
    entry.count = 0;
    entry.first = now;
  }
  entry.count += 1;
  attempts.set(key, entry);
  return entry.count > 10;
}

router.post(
  '/auth/register',
  asyncHandler(async (req, res) => {
    const fullName = str(req.body.full_name, 120);
    const displayName = str(req.body.display_name, 60) || fullName.split(' ')[0];
    const username = str(req.body.username, 40).toLowerCase();
    const password = String(req.body.password || '');
    const classLevel = toInt(req.body.class_level);
    const avatar = str(req.body.avatar, 8) || '🧑‍🎓';
    const parentContact = str(req.body.parent_contact, 120);

    if (!fullName) throw new HttpError(400, 'Please enter your full name.');
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
      throw new HttpError(400, 'Username must be 3-40 characters using letters, numbers, dot, dash or underscore.');
    }
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
    if (!classLevel || classLevel < 1 || classLevel > 8) throw new HttpError(400, 'Please choose your class.');

    const existing = get('SELECT id FROM users WHERE lower(username) = ?', [username]);
    if (existing) throw new HttpError(409, 'That username is already taken.');

    const studentId = `STD-${String(Math.floor(1000 + Math.random() * 8999))}`;
    const { lastId } = run(
      `INSERT INTO users (username, password_hash, role, full_name, display_name, student_id, class_level, avatar, parent_contact, status)
       VALUES (?, ?, 'student', ?, ?, ?, ?, ?, ?, 'active')`,
      [username, hashPassword(password), fullName, displayName, studentId, classLevel, avatar, parentContact],
    );

    const token = createSession(lastId);
    setSessionCookie(res, token);
    audit({ id: lastId, role: 'student' }, 'auth.register', username, `Class ${classLevel}`);
    res.status(201).json({ user: publicUser(get('SELECT * FROM users WHERE id = ?', [lastId])) });
  }),
);

router.post(
  '/auth/login',
  asyncHandler(async (req, res) => {
    const username = str(req.body.username, 60).toLowerCase();
    const password = String(req.body.password || '');
    if (throttle(`${req.ip}:${username}`)) {
      throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
    }
    const user = get('SELECT * FROM users WHERE lower(username) = ?', [username]);
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, 'Incorrect username or password.');
    }
    if (user.status !== 'active') {
      throw new HttpError(403, 'This account is suspended. Please contact your school administrator.');
    }
    run("UPDATE users SET last_login = datetime('now') WHERE id = ?", [user.id]);
    const token = createSession(user.id);
    setSessionCookie(res, token);
    res.json({ user: publicUser(user) });
  }),
);

router.post(
  '/auth/logout',
  asyncHandler(async (req, res) => {
    destroySession(req.session?.token);
    clearSessionCookie(res);
    res.json({ ok: true });
  }),
);

router.get('/auth/me', (req, res) => {
  res.json({ user: req.user, adminMode: Boolean(req.session?.admin_verified) });
});

router.patch(
  '/auth/profile',
  requireAuth,
  asyncHandler(async (req, res) => {
    const displayName = str(req.body.display_name, 60);
    const avatar = str(req.body.avatar, 8);
    const parentContact = str(req.body.parent_contact, 120);
    run('UPDATE users SET display_name = ?, avatar = ?, parent_contact = ? WHERE id = ?', [
      displayName || req.user.display_name,
      avatar || req.user.avatar,
      parentContact || req.user.parent_contact,
      req.user.id,
    ]);
    res.json({ user: publicUser(get('SELECT * FROM users WHERE id = ?', [req.user.id])) });
  }),
);

router.post(
  '/auth/password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const current = String(req.body.current_password || '');
    const next = String(req.body.new_password || '');
    if (next.length < 8) throw new HttpError(400, 'New password must be at least 8 characters.');
    const row = get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (!verifyPassword(current, row.password_hash)) throw new HttpError(400, 'Current password is incorrect.');
    run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(next), req.user.id]);
    run('DELETE FROM sessions WHERE user_id = ? AND token != ?', [req.user.id, req.session.token]);
    audit(req.user, 'auth.password_changed', req.user.username);
    res.json({ ok: true });
  }),
);

router.get('/auth/demo-accounts', (_req, res) => {
  const hint = get("SELECT value FROM settings WHERE key = 'demo_hints'");
  if (hint && hint.value === '0') return res.json({ enabled: false, accounts: [] });
  const admin = get("SELECT username FROM users WHERE role = 'super_admin' LIMIT 1");
  res.json({
    enabled: true,
    accounts: [
      { label: 'Student', username: 'student1', password: 'Learn@2025', role: 'student' },
      { label: 'Teacher', username: 'teacher.rahman', password: 'Teach@2025', role: 'teacher' },
      ...(admin ? [{ label: 'Super Admin', username: admin.username, password: 'Studyflix@2025', role: 'super_admin' }] : []),
    ],
  });
});

router.post(
  '/admin/login',
  asyncHandler(async (req, res) => {
    const username = str(req.body.username, 60).toLowerCase();
    const password = String(req.body.password || '');
    if (throttle(`admin:${req.ip}:${username}`)) {
      throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
    }
    const user = get('SELECT * FROM users WHERE lower(username) = ?', [username]);
    if (!user || user.role !== 'super_admin' || !verifyPassword(password, user.password_hash)) {
      audit({ id: user?.id ?? null, role: 'unknown' }, 'admin.login_failed', username);
      throw new HttpError(401, 'Administrator credentials are not valid.');
    }
    if (user.status !== 'active') throw new HttpError(403, 'This administrator account is suspended.');

    let token = req.session?.token;
    if (token) {
      run('UPDATE sessions SET admin_verified = 1 WHERE token = ?', [token]);
    } else {
      token = createSession(user.id, 1);
      setSessionCookie(res, token);
    }
    run("UPDATE users SET last_login = datetime('now') WHERE id = ?", [user.id]);
    audit(user, 'admin.mode_entered', username);
    res.json({ user: publicUser(user), adminMode: true });
  }),
);

router.post(
  '/admin/exit',
  asyncHandler(async (req, res) => {
    if (!req.user) throw new HttpError(401, 'Please sign in to continue.');
    if (req.session?.token) run('UPDATE sessions SET admin_verified = 0 WHERE token = ?', [req.session.token]);
    audit(req.user, 'admin.mode_exited', req.user.username);
    res.json({ ok: true, adminMode: false });
  }),
);

router.get('/admin/session', (req, res) => {
  res.json({ adminMode: Boolean(req.session?.admin_verified), user: req.user });
});

export default router;

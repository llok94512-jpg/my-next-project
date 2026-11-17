import { all, get, run } from './db.js';
import { HttpError, readCookie } from './lib/http.js';

const SESSION_DAYS = 30;

export function publicUser(row) {
  if (!row) return null;
  const {
    password_hash: _password,
    ...rest
  } = row;
  return {
    id: rest.id,
    username: rest.username,
    role: rest.role,
    full_name: rest.full_name,
    display_name: rest.display_name || rest.full_name,
    student_id: rest.student_id,
    class_level: rest.class_level,
    avatar: rest.avatar,
    parent_contact: rest.parent_contact,
    status: rest.status,
    created_at: rest.created_at,
    last_login: rest.last_login,
  };
}

export function createSession(userId, adminVerified = 0) {
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  run('INSERT INTO sessions (token, user_id, admin_verified, expires_at) VALUES (?, ?, ?, ?)', [
    token,
    userId,
    adminVerified ? 1 : 0,
    expires,
  ]);
  return token;
}

export function destroySession(token) {
  if (token) run('DELETE FROM sessions WHERE token = ?', [token]);
}

export function sessionMiddleware(req, _res, next) {
  req.session = null;
  req.user = null;
  const token = readCookie(req, 'sf_session');
  if (token) {
    const row = get(
      `SELECT s.token, s.admin_verified, s.expires_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`,
      [token],
    );
    if (row && new Date(row.expires_at).getTime() > Date.now() && row.status === 'active') {
      req.session = { token: row.token, admin_verified: Boolean(row.admin_verified), expires_at: row.expires_at };
      req.user = publicUser(row);
    } else if (row) {
      run('DELETE FROM sessions WHERE token = ?', [token]);
    }
  }
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in to continue.'));
  next();
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Please sign in to continue.'));
    if (!roles.includes(req.user.role)) return next(new HttpError(403, 'You do not have permission for this action.'));
    next();
  };
}

export function requireStaff(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in to continue.'));
  if (!['super_admin', 'teacher'].includes(req.user.role)) {
    return next(new HttpError(403, 'Staff access only.'));
  }
  next();
}

export function requireAdminMode(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in to continue.'));
  if (req.user.role !== 'super_admin') return next(new HttpError(403, 'Administrator access only.'));
  if (!req.session?.admin_verified) {
    return next(new HttpError(403, 'Admin mode is locked. Verify your administrator credentials to continue.'));
  }
  next();
}

export function canAccessClass(user, classLevel) {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  if (user.role === 'student') return Number(user.class_level) === Number(classLevel);
  if (user.role === 'teacher') {
    if (classLevel === null || classLevel === undefined) return true;
    const row = get('SELECT id FROM teacher_assignments WHERE teacher_id = ? AND class_level = ?', [
      user.id,
      Number(classLevel),
    ]);
    return Boolean(row);
  }
  return false;
}

export function teacherSubjectIds(teacherId) {
  return all('SELECT DISTINCT subject_id FROM teacher_assignments WHERE teacher_id = ?', [teacherId]).map(
    (row) => row.subject_id,
  );
}

export function teacherClassLevels(teacherId) {
  return all('SELECT DISTINCT class_level FROM teacher_assignments WHERE teacher_id = ?', [teacherId]).map(
    (row) => row.class_level,
  );
}

export function canManageSubject(user, subjectId) {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  if (user.role !== 'teacher') return false;
  const row = get('SELECT id FROM teacher_assignments WHERE teacher_id = ? AND subject_id = ?', [user.id, subjectId]);
  return Boolean(row);
}

export function studentScope(user) {
  return { role: user.role, id: user.id, class_level: user.class_level };
}

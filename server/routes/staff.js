import { Router } from 'express';
import { all, get, run, saveNow } from '../db.js';
import { hashPassword } from '../lib/passwords.js';
import { asyncHandler, HttpError, str, toInt } from '../lib/http.js';
import { requireAdminMode, requireAuth, requireRole, requireStaff } from '../auth.js';
import { audit } from '../lib/notify.js';

const router = Router();

/* ------------------------------ TEACHER PORTAL ---------------------------- */

router.get(
  '/teacher/overview',
  requireStaff,
  asyncHandler(async (req, res) => {
    const user = req.user;
    const classes =
      user.role === 'super_admin'
        ? all('SELECT * FROM classes ORDER BY level')
        : all(
            'SELECT DISTINCT c.* FROM classes c JOIN teacher_assignments ta ON ta.class_level = c.level WHERE ta.teacher_id = ? ORDER BY c.level',
            [user.id],
          );
    const subjects =
      user.role === 'super_admin'
        ? all('SELECT * FROM subjects ORDER BY name')
        : all(
            'SELECT DISTINCT s.* FROM subjects s JOIN teacher_assignments ta ON ta.subject_id = s.id WHERE ta.teacher_id = ? ORDER BY s.name',
            [user.id],
          );
    const levels = classes.map((c) => c.level);
    const placeholders = levels.map(() => '?').join(',') || 'NULL';
    res.json({
      classes,
      subjects,
      stats: {
        students: get(
          `SELECT COUNT(*) AS c FROM users WHERE role = 'student' AND class_level IN (${placeholders})`,
          levels,
        ).c,
        assignments: get(
          `SELECT COUNT(*) AS c FROM assignments WHERE class_level IN (${placeholders})`,
          levels,
        ).c,
        pending_submissions: get(
          `SELECT COUNT(*) AS c FROM submissions sub JOIN assignments a ON a.id = sub.assignment_id
           WHERE a.class_level IN (${placeholders}) AND sub.status = 'submitted'`,
          levels,
        ).c,
        quizzes: get(
          `SELECT COUNT(*) AS c FROM quizzes WHERE created_by = ? OR class_level IN (${placeholders})`,
          [user.id, ...levels],
        ).c,
      },
    });
  }),
);

router.get(
  '/teacher/students',
  requireStaff,
  asyncHandler(async (req, res) => {
    const user = req.user;
    const levels =
      user.role === 'super_admin'
        ? [1, 2, 3, 4, 5, 6, 7, 8]
        : all('SELECT DISTINCT class_level FROM teacher_assignments WHERE teacher_id = ?', [user.id]).map((r) => r.class_level);
    const filter = toInt(req.query.class, null);
    if (filter && !levels.includes(filter)) throw new HttpError(403, 'You are not assigned to this class.');
    const target = filter ? [filter] : levels;
    if (!target.length) return res.json({ students: [] });
    const students = all(
      `SELECT id, full_name, display_name, student_id, class_level, avatar, status,
              (SELECT COUNT(*) FROM quiz_attempts WHERE user_id = users.id) AS quizzes_taken,
              (SELECT COUNT(*) FROM submissions WHERE user_id = users.id) AS submissions
       FROM users WHERE role = 'student' AND class_level IN (${target.map(() => '?').join(',')})
       ORDER BY class_level, display_name`,
      target,
    );
    res.json({ students });
  }),
);

/* --------------------------- ADMIN: CONTROL CENTRE ------------------------ */

router.get(
  '/admin/overview',
  requireAdminMode,
  asyncHandler(async (req, res) => {
    const count = (sql, params = []) => get(sql, params).c;
    res.json({
      stats: {
        students: count("SELECT COUNT(*) AS c FROM users WHERE role = 'student'"),
        active_students: count("SELECT COUNT(*) AS c FROM users WHERE role = 'student' AND status = 'active'"),
        teachers: count("SELECT COUNT(*) AS c FROM users WHERE role = 'teacher'"),
        classes: count('SELECT COUNT(*) AS c FROM classes'),
        subjects: count('SELECT COUNT(*) AS c FROM subjects'),
        published_chapters: count("SELECT COUNT(*) AS c FROM chapters WHERE status = 'published'"),
        approved_videos: count("SELECT COUNT(*) AS c FROM videos WHERE status = 'approved'"),
        pending_videos: count("SELECT COUNT(*) AS c FROM videos WHERE status = 'pending'"),
        documents: count('SELECT COUNT(*) AS c FROM documents'),
        published_books: count("SELECT COUNT(*) AS c FROM books WHERE status = 'published'"),
        assignments: count('SELECT COUNT(*) AS c FROM assignments'),
        submissions: count('SELECT COUNT(*) AS c FROM submissions'),
        quizzes: count('SELECT COUNT(*) AS c FROM quizzes'),
        quiz_attempts: count('SELECT COUNT(*) AS c FROM quiz_attempts'),
        announcements: count("SELECT COUNT(*) AS c FROM announcements WHERE status = 'published'"),
        islamic_lessons: count('SELECT COUNT(*) AS c FROM islamic_lessons'),
      },
      recent_activity: all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 12'),
      class_distribution: all(
        `SELECT class_level, COUNT(*) AS students FROM users WHERE role = 'student' GROUP BY class_level ORDER BY class_level`,
      ),
      pending_video_list: all('SELECT * FROM videos WHERE status = ? ORDER BY id DESC LIMIT 5', ['pending']),
    });
  }),
);

router.get(
  '/admin/audit',
  requireAdminMode,
  asyncHandler(async (req, res) => {
    res.json({ logs: all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200') });
  }),
);

/* ---------------------------- ADMIN: STUDENTS ----------------------------- */

router.get(
  '/admin/students',
  requireAdminMode,
  asyncHandler(async (req, res) => {
    const level = toInt(req.query.class, null);
    const search = str(req.query.q, 60);
    const students = all(
      `SELECT id, full_name, display_name, student_id, class_level, username, avatar, status, parent_contact, created_at, last_login,
              (SELECT COUNT(*) FROM quiz_attempts WHERE user_id = users.id) AS quizzes_taken,
              (SELECT COUNT(*) FROM submissions WHERE user_id = users.id) AS submissions,
              (SELECT COUNT(*) FROM attendance WHERE student_id = users.id AND status = 'present') AS days_present
       FROM users WHERE role = 'student'
         ${level ? 'AND class_level = ?' : ''}
         ${search ? 'AND (full_name LIKE ? OR display_name LIKE ? OR student_id LIKE ? OR username LIKE ?)' : ''}
       ORDER BY class_level, display_name`,
      [
        ...(level ? [level] : []),
        ...(search ? [`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`] : []),
      ],
    );
    res.json({ students });
  }),
);

router.patch(
  '/admin/students/:id',
  requireAdminMode,
  asyncHandler(async (req, res) => {
    const student = get("SELECT * FROM users WHERE id = ? AND role = 'student'", [toInt(req.params.id)]);
    if (!student) throw new HttpError(404, 'Student not found.');
    run('UPDATE users SET full_name = ?, display_name = ?, class_level = ?, status = ?, parent_contact = ? WHERE id = ?', [
      str(req.body.full_name, 120) || student.full_name,
      str(req.body.display_name, 60) || student.display_name,
      req.body.class_level === undefined ? student.class_level : toInt(req.body.class_level, student.class_level),
      ['active', 'suspended'].includes(req.body.status) ? req.body.status : student.status,
      req.body.parent_contact !== undefined ? str(req.body.parent_contact, 120) : student.parent_contact,
      student.id,
    ]);
    if (req.body.password) {
      if (String(req.body.password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
      run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(req.body.password), student.id]);
    }
    audit(req.user, 'student.updated', student.student_id);
    saveNow();
    res.json({ student: get('SELECT id, full_name, display_name, class_level, status FROM users WHERE id = ?', [student.id]) });
  }),
);

/* ---------------------------- ADMIN: TEACHERS ----------------------------- */

router.get(
  '/admin/teachers',
  requireAdminMode,
  asyncHandler(async (req, res) => {
    const teachers = all(
      `SELECT u.id, u.full_name, u.display_name, u.username, u.status, u.created_at, u.last_login, u.avatar,
              (SELECT COUNT(*) FROM teacher_assignments WHERE teacher_id = u.id) AS assignment_count
       FROM users u WHERE u.role = 'teacher' ORDER BY u.display_name`,
    );
    res.json({
      teachers: teachers.map((teacher) => ({
        ...teacher,
        assignments: all(
          `SELECT ta.class_level, s.name AS subject_name, s.id AS subject_id FROM teacher_assignments ta
           JOIN subjects s ON s.id = ta.subject_id WHERE ta.teacher_id = ? ORDER BY ta.class_level`,
          [teacher.id],
        ),
      })),
    });
  }),
);

router.post(
  '/admin/teachers',
  requireAdminMode,
  asyncHandler(async (req, res) => {
    const username = str(req.body.username, 40).toLowerCase();
    const password = String(req.body.password || '');
    const fullName = str(req.body.full_name, 120);
    if (!username || !fullName) throw new HttpError(400, 'Full name and username are required.');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
    if (get('SELECT id FROM users WHERE username = ?', [username])) throw new HttpError(409, 'That username is taken.');
    const { lastId } = run(
      "INSERT INTO users (username, password_hash, role, full_name, display_name, avatar) VALUES (?, ?, 'teacher', ?, ?, 'teal')",
      [username, hashPassword(password), fullName, str(req.body.display_name, 60) || fullName],
    );
    for (const assignment of Array.isArray(req.body.assignments) ? req.body.assignments : []) {
      run('INSERT INTO teacher_assignments (teacher_id, subject_id, class_level) VALUES (?, ?, ?)', [
        lastId,
        toInt(assignment.subject_id),
        toInt(assignment.class_level),
      ]);
    }
    audit(req.user, 'teacher.created', username);
    saveNow();
    res.status(201).json({ teacher: get('SELECT id, full_name, username FROM users WHERE id = ?', [lastId]) });
  }),
);

router.patch(
  '/admin/teachers/:id',
  requireAdminMode,
  asyncHandler(async (req, res) => {
    const teacher = get("SELECT * FROM users WHERE id = ? AND role = 'teacher'", [toInt(req.params.id)]);
    if (!teacher) throw new HttpError(404, 'Teacher not found.');
    run('UPDATE users SET full_name = ?, display_name = ?, status = ? WHERE id = ?', [
      str(req.body.full_name, 120) || teacher.full_name,
      str(req.body.display_name, 60) || teacher.display_name,
      ['active', 'suspended'].includes(req.body.status) ? req.body.status : teacher.status,
      teacher.id,
    ]);
    if (req.body.password) {
      if (String(req.body.password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
      run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(req.body.password), teacher.id]);
    }
    if (Array.isArray(req.body.assignments)) {
      run('DELETE FROM teacher_assignments WHERE teacher_id = ?', [teacher.id]);
      for (const assignment of req.body.assignments) {
        run('INSERT INTO teacher_assignments (teacher_id, subject_id, class_level) VALUES (?, ?, ?)', [
          teacher.id,
          toInt(assignment.subject_id),
          toInt(assignment.class_level),
        ]);
      }
    }
    audit(req.user, 'teacher.updated', teacher.username);
    saveNow();
    res.json({ ok: true });
  }),
);

router.delete(
  '/admin/teachers/:id',
  requireAdminMode,
  asyncHandler(async (req, res) => {
    const teacher = get("SELECT * FROM users WHERE id = ? AND role = 'teacher'", [toInt(req.params.id)]);
    if (!teacher) throw new HttpError(404, 'Teacher not found.');
    run('DELETE FROM teacher_assignments WHERE teacher_id = ?', [teacher.id]);
    run('DELETE FROM users WHERE id = ?', [teacher.id]);
    audit(req.user, 'teacher.deleted', teacher.username);
    saveNow();
    res.json({ ok: true });
  }),
);

/* ------------------------------- ADMIN: CLASSES --------------------------- */

router.get(
  '/admin/classes',
  requireAdminMode,
  asyncHandler(async (req, res) => {
    res.json({
      classes: all(
        `SELECT c.*, (SELECT COUNT(*) FROM users WHERE role = 'student' AND class_level = c.level) AS students
         FROM classes c ORDER BY c.level`,
      ),
    });
  }),
);

export default router;

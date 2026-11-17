import { Router } from 'express';
import { all, get, run, saveNow } from '../db.js';
import { asyncHandler, HttpError, str, toInt } from '../lib/http.js';
import { requireAdminMode, requireAuth, requireRole, requireStaff } from '../auth.js';
import { audit, notificationsFor, unreadCount } from '../lib/notify.js';

const router = Router();

/* ---------------------------------- NOTES --------------------------------- */

router.get(
  '/notes',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({
      notes: all('SELECT * FROM notes WHERE user_id = ? ORDER BY updated_at DESC', [req.user.id]),
    });
  }),
);

router.post(
  '/notes',
  requireAuth,
  asyncHandler(async (req, res) => {
    const title = str(req.body.title, 160);
    if (!title) throw new HttpError(400, 'Give your note a title.');
    const { lastId } = run('INSERT INTO notes (user_id, title, body, subject) VALUES (?, ?, ?, ?)', [
      req.user.id,
      title,
      str(req.body.body, 8000),
      str(req.body.subject, 80),
    ]);
    saveNow();
    res.status(201).json({ note: get('SELECT * FROM notes WHERE id = ?', [lastId]) });
  }),
);

router.patch(
  '/notes/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const note = get('SELECT * FROM notes WHERE id = ? AND user_id = ?', [toInt(req.params.id), req.user.id]);
    if (!note) throw new HttpError(404, 'Note not found.');
    run("UPDATE notes SET title = ?, body = ?, subject = ?, updated_at = datetime('now') WHERE id = ?", [
      str(req.body.title, 160) || note.title,
      req.body.body !== undefined ? str(req.body.body, 8000) : note.body,
      req.body.subject !== undefined ? str(req.body.subject, 80) : note.subject,
      note.id,
    ]);
    saveNow();
    res.json({ note: get('SELECT * FROM notes WHERE id = ?', [note.id]) });
  }),
);

router.delete(
  '/notes/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    run('DELETE FROM notes WHERE id = ? AND user_id = ?', [toInt(req.params.id), req.user.id]);
    saveNow();
    res.json({ ok: true });
  }),
);

/* ------------------------------- LEARNING GOALS --------------------------- */

router.get(
  '/goals',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ goals: all('SELECT * FROM learning_goals WHERE user_id = ? ORDER BY done, id DESC', [req.user.id]) });
  }),
);

router.post(
  '/goals',
  requireAuth,
  asyncHandler(async (req, res) => {
    const title = str(req.body.title, 160);
    if (!title) throw new HttpError(400, 'Describe your goal.');
    const { lastId } = run('INSERT INTO learning_goals (user_id, title, period, target, progress) VALUES (?, ?, ?, ?, ?)', [
      req.user.id,
      title,
      ['daily', 'weekly', 'term'].includes(req.body.period) ? req.body.period : 'weekly',
      toInt(req.body.target, 1),
      toInt(req.body.progress, 0),
    ]);
    saveNow();
    res.status(201).json({ goal: get('SELECT * FROM learning_goals WHERE id = ?', [lastId]) });
  }),
);

router.patch(
  '/goals/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const goal = get('SELECT * FROM learning_goals WHERE id = ? AND user_id = ?', [toInt(req.params.id), req.user.id]);
    if (!goal) throw new HttpError(404, 'Goal not found.');
    const progress = req.body.progress === undefined ? goal.progress : toInt(req.body.progress, goal.progress);
    const target = req.body.target === undefined ? goal.target : toInt(req.body.target, goal.target);
    const done = req.body.done === undefined ? (progress >= target ? 1 : goal.done) : req.body.done ? 1 : 0;
    run('UPDATE learning_goals SET progress = ?, target = ?, done = ? WHERE id = ?', [progress, target, done, goal.id]);
    saveNow();
    res.json({ goal: get('SELECT * FROM learning_goals WHERE id = ?', [goal.id]) });
  }),
);

router.delete(
  '/goals/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    run('DELETE FROM learning_goals WHERE id = ? AND user_id = ?', [toInt(req.params.id), req.user.id]);
    saveNow();
    res.json({ ok: true });
  }),
);

/* ------------------------------- NOTIFICATIONS ---------------------------- */

router.get(
  '/notifications',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ notifications: notificationsFor(req.user), unread: unreadCount(req.user) });
  }),
);

router.post(
  '/notifications/:id/read',
  requireAuth,
  asyncHandler(async (req, res) => {
    run('UPDATE notifications SET read = 1 WHERE id = ? AND (user_id = ? OR user_id IS NULL)', [
      toInt(req.params.id),
      req.user.id,
    ]);
    saveNow();
    res.json({ ok: true, unread: unreadCount(req.user) });
  }),
);

router.post(
  '/notifications/read-all',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user.role === 'student') {
      run('UPDATE notifications SET read = 1 WHERE user_id = ? OR (user_id IS NULL AND (class_level IS NULL OR class_level = ?))', [
        req.user.id,
        Number(req.user.class_level),
      ]);
    } else {
      run('UPDATE notifications SET read = 1 WHERE user_id = ? OR user_id IS NULL', [req.user.id]);
    }
    saveNow();
    res.json({ ok: true, unread: 0 });
  }),
);

/* -------------------------------- ANNOUNCEMENTS --------------------------- */

router.get(
  '/announcements',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user;
    let rows;
    if (user.role === 'student') {
      rows = all(
        `SELECT a.*, u.display_name AS author FROM announcements a LEFT JOIN users u ON u.id = a.created_by
         WHERE a.status = 'published' AND a.audience IN ('all','students')
           AND (a.class_level IS NULL OR a.class_level = ?)
         ORDER BY a.id DESC LIMIT 30`,
        [Number(user.class_level)],
      );
    } else if (user.role === 'teacher') {
      rows = all(
        `SELECT a.*, u.display_name AS author FROM announcements a LEFT JOIN users u ON u.id = a.created_by
         WHERE a.status = 'published' AND a.audience IN ('all','teachers','students') ORDER BY a.id DESC LIMIT 30`,
      );
    } else {
      rows = all(
        `SELECT a.*, u.display_name AS author FROM announcements a LEFT JOIN users u ON u.id = a.created_by
         ORDER BY a.id DESC LIMIT 60`,
      );
    }
    res.json({ announcements: rows });
  }),
);

router.post(
  '/announcements',
  requireStaff,
  asyncHandler(async (req, res) => {
    const title = str(req.body.title, 180);
    if (!title) throw new HttpError(400, 'Announcement title is required.');
    const audience = ['all', 'students', 'teachers'].includes(req.body.audience) ? req.body.audience : 'all';
    const classLevel = toInt(req.body.class_level, null);
    if (req.user.role === 'teacher' && audience === 'all') {
      throw new HttpError(403, 'Teachers can publish to their own classes only.');
    }
    if (req.user.role === 'teacher' && !classLevel) {
      throw new HttpError(400, 'Choose the class for this announcement.');
    }
    const { lastId } = run(
      'INSERT INTO announcements (title, body, audience, class_level, created_by, publish_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        title,
        str(req.body.body, 4000),
        audience,
        classLevel,
        req.user.id,
        str(req.body.publish_at, 40) || new Date().toISOString().slice(0, 16).replace('T', ' '),
        req.body.status === 'draft' ? 'draft' : 'published',
      ],
    );
    if (req.body.status !== 'draft') {
      if (classLevel) {
        run('INSERT INTO notifications (class_level, title, body, kind, link) VALUES (?, ?, ?, ?, ?)', [
          classLevel,
          `Announcement: ${title}`,
          str(req.body.body, 300),
          'announcement',
          '/notifications',
        ]);
      } else {
        run("INSERT INTO notifications (user_id, title, body, kind, link) SELECT id, ?, ?, 'announcement', '/notifications' FROM users WHERE role != 'super_admin'", [
          `Announcement: ${title}`,
          str(req.body.body, 300),
        ]);
      }
    }
    audit(req.user, 'announcement.published', title);
    saveNow();
    res.status(201).json({ announcement: get('SELECT * FROM announcements WHERE id = ?', [lastId]) });
  }),
);

router.patch(
  '/announcements/:id',
  requireStaff,
  asyncHandler(async (req, res) => {
    const announcement = get('SELECT * FROM announcements WHERE id = ?', [toInt(req.params.id)]);
    if (!announcement) throw new HttpError(404, 'Announcement not found.');
    if (req.user.role === 'teacher' && announcement.created_by !== req.user.id) {
      throw new HttpError(403, 'You can only edit your own announcements.');
    }
    run('UPDATE announcements SET title = ?, body = ?, status = ?, class_level = ? WHERE id = ?', [
      str(req.body.title, 180) || announcement.title,
      req.body.body !== undefined ? str(req.body.body, 4000) : announcement.body,
      ['published', 'draft', 'archived'].includes(req.body.status) ? req.body.status : announcement.status,
      req.body.class_level === undefined ? announcement.class_level : toInt(req.body.class_level, null),
      announcement.id,
    ]);
    saveNow();
    res.json({ announcement: get('SELECT * FROM announcements WHERE id = ?', [announcement.id]) });
  }),
);

router.delete(
  '/announcements/:id',
  requireRole('super_admin'),
  asyncHandler(async (req, res) => {
    run('DELETE FROM announcements WHERE id = ?', [toInt(req.params.id)]);
    saveNow();
    res.json({ ok: true });
  }),
);

/* -------------------------------- ACHIEVEMENTS ---------------------------- */

router.get(
  '/achievements',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ achievements: all('SELECT * FROM achievements WHERE user_id = ? ORDER BY earned_at DESC', [req.user.id]) });
  }),
);

export default router;

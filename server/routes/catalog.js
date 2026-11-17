import { Router } from 'express';
import { all, get, run } from '../db.js';
import { asyncHandler, HttpError, str, toInt } from '../lib/http.js';
import { canManageSubject, requireAdminMode, requireAuth, requireRole, requireStaff } from '../auth.js';
import { audit } from '../lib/notify.js';

const router = Router();

const subjectRows = (where = '', params = []) =>
  all(
    `SELECT s.*, (SELECT COUNT(*) FROM chapters c WHERE c.subject_id = s.id) AS chapter_count,
            (SELECT GROUP_CONCAT(sc.class_level) FROM subject_classes sc WHERE sc.subject_id = s.id) AS class_levels
     FROM subjects s ${where} ORDER BY s.name`,
    params,
  );

const classListOf = (row) =>
  row.class_levels ? row.class_levels.split(',').map(Number).sort((a, b) => a - b) : [];

function shapeSubject(row) {
  return { ...row, class_levels: classListOf(row) };
}

export function subjectsForUser(user) {
  const rows = subjectRows();
  return rows.map(shapeSubject).filter((subject) => {
    if (user.role === 'super_admin') return true;
    if (user.role === 'student') return subject.class_levels.includes(Number(user.class_level));
    const assigned = get(
      'SELECT id FROM teacher_assignments WHERE teacher_id = ? AND subject_id = ?',
      [user.id, subject.id],
    );
    return Boolean(assigned);
  });
}

router.get(
  '/bootstrap',
  requireAuth,
  asyncHandler(async (req, res) => {
    const classes = all('SELECT * FROM classes ORDER BY level');
    const subjects = subjectsForUser(req.user);
    const unread = get(
      `SELECT COUNT(*) AS c FROM notifications WHERE read = 0 AND (user_id = ? OR (user_id IS NULL AND class_level = ?))`,
      [req.user.id, req.user.class_level ?? -1],
    ).c;
    res.json({
      user: req.user,
      adminMode: Boolean(req.session?.admin_verified),
      classes,
      subjects,
      unread,
      features: {
        youtube: Boolean(process.env.YOUTUBE_API_KEY),
        ai: Boolean(process.env.AI_API_KEY || process.env.OPENAI_API_KEY),
      },
      band: classes.find((c) => c.level === Number(req.user.class_level))?.band || 'senior',
    });
  }),
);

router.get(
  '/dashboard',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user;
    if (user.role !== 'student') {
      return res.json({ role: user.role, user });
    }
    const level = Number(user.class_level);
    const subjects = subjectsForUser(user);
    const subjectIds = subjects.map((s) => s.id);

    const chapters = subjectIds.length
      ? all(
          `SELECT c.*, s.name AS subject_name, s.icon AS subject_icon, s.color AS subject_color
           FROM chapters c JOIN subjects s ON s.id = c.subject_id
           WHERE c.class_level = ? AND c.status = 'published' AND c.subject_id IN (${subjectIds.map(() => '?').join(',')})
           ORDER BY s.name, c.position LIMIT 6`,
          [level, ...subjectIds],
        )
      : [];

    const lessons = subjectIds.length
      ? all(
          `SELECT l.*, c.title AS chapter_title, s.name AS subject_name, s.icon AS subject_icon
           FROM lessons l JOIN chapters c ON c.id = l.chapter_id JOIN subjects s ON s.id = c.subject_id
           WHERE c.class_level = ? AND l.status = 'published' AND c.subject_id IN (${subjectIds.map(() => '?').join(',')})
           ORDER BY l.id DESC LIMIT 6`,
          [level, ...subjectIds],
        )
      : [];

    const assignments = all(
      `SELECT a.*, s.name AS subject_name,
              (SELECT status FROM submissions WHERE assignment_id = a.id AND user_id = ?) AS submission_status,
              (SELECT grade FROM submissions WHERE assignment_id = a.id AND user_id = ?) AS grade
       FROM assignments a LEFT JOIN subjects s ON s.id = a.subject_id
       WHERE a.class_level = ? AND a.status = 'published' ORDER BY a.due_at ASC LIMIT 8`,
      [user.id, user.id, level],
    );

    const quizzes = all(
      `SELECT q.*, s.name AS subject_name,
              (SELECT MAX(score) FROM quiz_attempts WHERE quiz_id = q.id AND user_id = ?) AS best_score,
              (SELECT MAX(max_score) FROM quiz_attempts WHERE quiz_id = q.id AND user_id = ?) AS max_score,
              (SELECT COUNT(*) FROM quiz_attempts WHERE quiz_id = q.id AND user_id = ?) AS attempts
       FROM quizzes q LEFT JOIN subjects s ON s.id = q.subject_id
       WHERE q.class_level = ? AND q.status = 'published' ORDER BY q.id DESC LIMIT 8`,
      [user.id, user.id, user.id, level],
    );

    const shelf = all(
      `SELECT b.*, sh.shelf, sh.progress, sh.last_page, sh.last_location, sh.updated_at
       FROM bookshelf sh JOIN books b ON b.id = sh.book_id
       WHERE sh.user_id = ? AND sh.shelf IN ('reading','completed') ORDER BY sh.updated_at DESC LIMIT 6`,
      [user.id],
    );

    const documents = all(
      `SELECT d.*, s.name AS subject_name FROM documents d LEFT JOIN subjects s ON s.id = d.subject_id
       WHERE d.class_level = ? AND d.status = 'published' ORDER BY d.id DESC LIMIT 6`,
      [level],
    );

    const videos = all(
      `SELECT v.*, s.name AS subject_name, vp.completed, vp.updated_at AS watched_at
       FROM videos v LEFT JOIN subjects s ON s.id = v.subject_id
       LEFT JOIN video_progress vp ON vp.video_id = v.id AND vp.user_id = ?
       WHERE v.status = 'approved' AND v.published = 1 AND (v.class_level = ? OR v.class_level IS NULL)
       ORDER BY COALESCE(vp.updated_at, v.created_at) DESC LIMIT 6`,
      [user.id, level],
    );

    const stats = {
      assignments_total: assignments.length,
      assignments_done: assignments.filter((a) => a.submission_status).length,
      quizzes_taken: get('SELECT COUNT(*) AS c FROM quiz_attempts WHERE user_id = ?', [user.id]).c,
      lessons_available: lessons.length,
      books_reading: get("SELECT COUNT(*) AS c FROM bookshelf WHERE user_id = ? AND shelf = 'reading'", [user.id]).c,
      books_completed: get("SELECT COUNT(*) AS c FROM bookshelf WHERE user_id = ? AND shelf = 'completed'", [user.id]).c,
      notes: get('SELECT COUNT(*) AS c FROM notes WHERE user_id = ?', [user.id]).c,
      bookmarks: get('SELECT COUNT(*) AS c FROM bookmarks WHERE user_id = ?', [user.id]).c,
      reading_minutes: Math.round(
        (get('SELECT COALESCE(SUM(reading_seconds),0) AS s FROM bookshelf WHERE user_id = ?', [user.id]).s || 0) / 60,
      ),
      attendance_present: get(
        "SELECT COUNT(*) AS c FROM attendance WHERE student_id = ? AND status IN ('present','excused')",
        [user.id],
      ).c,
      attendance_total: get('SELECT COUNT(*) AS c FROM attendance WHERE student_id = ?', [user.id]).c,
      videos_completed: get('SELECT COUNT(*) AS c FROM video_progress WHERE user_id = ? AND completed = 1', [user.id]).c,
      achievements: get('SELECT COUNT(*) AS c FROM achievements WHERE user_id = ?', [user.id]).c,
    };

    const avgScore = get(
      'SELECT AVG(score * 100.0 / NULLIF(max_score,0)) AS avg FROM quiz_attempts WHERE user_id = ?',
      [user.id],
    ).avg;
    const quizProgress = avgScore ? Math.round(avgScore) : 0;
    const assignmentProgress = stats.assignments_total
      ? Math.round((stats.assignments_done / stats.assignments_total) * 100)
      : 0;
    const attendanceRate = stats.attendance_total
      ? Math.round((stats.attendance_present / stats.attendance_total) * 100)
      : 100;

    res.json({
      role: 'student',
      user,
      band: get('SELECT band FROM classes WHERE level = ?', [level])?.band || 'senior',
      className: get('SELECT name FROM classes WHERE level = ?', [level])?.name || `Class ${level}`,
      subjects,
      chapters,
      lessons,
      assignments,
      quizzes,
      shelf,
      documents,
      videos,
      goals: all('SELECT * FROM learning_goals WHERE user_id = ? ORDER BY done, id DESC LIMIT 6', [user.id]),
      achievements: all('SELECT * FROM achievements WHERE user_id = ? ORDER BY earned_at DESC LIMIT 6', [user.id]),
      notes: all('SELECT * FROM notes WHERE user_id = ? ORDER BY updated_at DESC LIMIT 4', [user.id]),
      bookmarks: all(
        `SELECT bm.*, b.title AS book_title FROM bookmarks bm JOIN books b ON b.id = bm.book_id
         WHERE bm.user_id = ? ORDER BY bm.created_at DESC LIMIT 5`,
        [user.id],
      ),
      announcements: all(
        `SELECT a.*, u.display_name AS author FROM announcements a LEFT JOIN users u ON u.id = a.created_by
         WHERE a.status = 'published' AND (a.audience = 'all' OR (a.audience = 'class' AND a.class_level = ?))
         ORDER BY a.publish_at DESC LIMIT 4`,
        [level],
      ),
      progress: {
        quiz: quizProgress,
        assignments: assignmentProgress,
        attendance: attendanceRate,
        reading: Math.min(100, stats.books_completed * 25),
        overall: Math.round((quizProgress + assignmentProgress + attendanceRate) / 3),
      },
      stats,
      week: {
        minutes_read: stats.reading_minutes,
        quizzes: stats.quizzes_taken,
        lessons: stats.lessons_available,
        books_completed: stats.books_completed,
      },
    });
  }),
);

router.get(
  '/classes',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ classes: all('SELECT * FROM classes ORDER BY level') });
  }),
);

router.get(
  '/subjects',
  requireAuth,
  asyncHandler(async (req, res) => {
    const classLevel = toInt(req.query.class);
    let subjects = subjectsForUser(req.user);
    if (classLevel && req.user.role !== 'student') {
      subjects = subjects.filter((s) => s.class_levels.includes(classLevel));
    }
    res.json({ subjects });
  }),
);

router.get(
  '/subjects/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const subject = get('SELECT * FROM subjects WHERE id = ?', [toInt(req.params.id)]);
    if (!subject) throw new HttpError(404, 'Subject not found.');
    const allowed = subjectsForUser(req.user).some((s) => s.id === subject.id);
    if (!allowed) throw new HttpError(403, 'This subject is not available for your account.');
    const level = req.user.role === 'student' ? Number(req.user.class_level) : toInt(req.query.class, null);
    const chapters = all(
      `SELECT * FROM chapters WHERE subject_id = ? ${level ? 'AND class_level = ?' : ''} AND status = 'published'
       ORDER BY class_level, position`,
      level ? [subject.id, level] : [subject.id],
    );
    const withLessons = chapters.map((chapter) => ({
      ...chapter,
      lessons: all("SELECT * FROM lessons WHERE chapter_id = ? AND status = 'published' ORDER BY position", [chapter.id]),
    }));
    res.json({
      subject: { ...subject, class_levels: classListOf(get(`SELECT GROUP_CONCAT(class_level) AS class_levels FROM subject_classes WHERE subject_id = ?`, [subject.id])) },
      chapters: withLessons,
      videos: all(
        `SELECT * FROM videos WHERE subject_id = ? AND status = 'approved' AND published = 1 ${level ? 'AND (class_level = ? OR class_level IS NULL)' : ''} ORDER BY id DESC`,
        level ? [subject.id, level] : [subject.id],
      ),
      documents: all(
        `SELECT * FROM documents WHERE subject_id = ? AND status = 'published' ${level ? 'AND class_level = ?' : ''} ORDER BY id DESC`,
        level ? [subject.id, level] : [subject.id],
      ),
      books: all(
        `SELECT * FROM books WHERE status = 'published' ${level ? 'AND class_level = ?' : ''} ORDER BY featured DESC, title LIMIT 8`,
        level ? [level] : [],
      ),
    });
  }),
);

router.post(
  '/subjects',
  requireAdminMode,
  asyncHandler(async (req, res) => {
    const name = str(req.body.name, 80);
    if (!name) throw new HttpError(400, 'Subject name is required.');
    const { lastId } = run(
      'INSERT INTO subjects (name, icon, color, description, status) VALUES (?, ?, ?, ?, ?)',
      [name, str(req.body.icon, 8) || '📘', str(req.body.color, 20) || '#2f6fd0', str(req.body.description, 400), 'published'],
    );
    for (const level of req.body.class_levels || []) {
      run('INSERT OR IGNORE INTO subject_classes (subject_id, class_level) VALUES (?, ?)', [lastId, Number(level)]);
    }
    audit(req.user, 'subject.created', name);
    res.status(201).json({ subject: get('SELECT * FROM subjects WHERE id = ?', [lastId]) });
  }),
);

router.patch(
  '/subjects/:id',
  requireAdminMode,
  asyncHandler(async (req, res) => {
    const id = toInt(req.params.id);
    const subject = get('SELECT * FROM subjects WHERE id = ?', [id]);
    if (!subject) throw new HttpError(404, 'Subject not found.');
    run('UPDATE subjects SET name = ?, icon = ?, color = ?, description = ?, status = ? WHERE id = ?', [
      str(req.body.name, 80) || subject.name,
      str(req.body.icon, 8) || subject.icon,
      str(req.body.color, 20) || subject.color,
      req.body.description !== undefined ? str(req.body.description, 400) : subject.description,
      ['published', 'archived'].includes(req.body.status) ? req.body.status : subject.status,
      id,
    ]);
    if (Array.isArray(req.body.class_levels)) {
      run('DELETE FROM subject_classes WHERE subject_id = ?', [id]);
      for (const level of req.body.class_levels) {
        run('INSERT OR IGNORE INTO subject_classes (subject_id, class_level) VALUES (?, ?)', [id, Number(level)]);
      }
    }
    audit(req.user, 'subject.updated', subject.name);
    res.json({ subject: get('SELECT * FROM subjects WHERE id = ?', [id]) });
  }),
);

router.delete(
  '/subjects/:id',
  requireAdminMode,
  asyncHandler(async (req, res) => {
    const subject = get('SELECT * FROM subjects WHERE id = ?', [toInt(req.params.id)]);
    if (!subject) throw new HttpError(404, 'Subject not found.');
    run('DELETE FROM subjects WHERE id = ?', [subject.id]);
    audit(req.user, 'subject.deleted', subject.name);
    res.json({ ok: true });
  }),
);

router.post(
  '/chapters',
  requireStaff,
  asyncHandler(async (req, res) => {
    const subjectId = toInt(req.body.subject_id);
    if (!canManageSubject(req.user, subjectId)) throw new HttpError(403, 'You cannot manage this subject.');
    const title = str(req.body.title, 140);
    if (!title) throw new HttpError(400, 'Chapter title is required.');
    const { lastId } = run(
      'INSERT INTO chapters (subject_id, class_level, title, description, position, status) VALUES (?, ?, ?, ?, ?, ?)',
      [subjectId, toInt(req.body.class_level, 1), title, str(req.body.description, 400), toInt(req.body.position, 1), 'published'],
    );
    audit(req.user, 'chapter.created', title);
    res.status(201).json({ chapter: get('SELECT * FROM chapters WHERE id = ?', [lastId]) });
  }),
);

router.patch(
  '/chapters/:id',
  requireStaff,
  asyncHandler(async (req, res) => {
    const chapter = get('SELECT * FROM chapters WHERE id = ?', [toInt(req.params.id)]);
    if (!chapter) throw new HttpError(404, 'Chapter not found.');
    if (!canManageSubject(req.user, chapter.subject_id)) throw new HttpError(403, 'You cannot manage this chapter.');
    run('UPDATE chapters SET title = ?, description = ?, position = ?, status = ? WHERE id = ?', [
      str(req.body.title, 140) || chapter.title,
      req.body.description !== undefined ? str(req.body.description, 400) : chapter.description,
      toInt(req.body.position, chapter.position),
      ['published', 'archived'].includes(req.body.status) ? req.body.status : chapter.status,
      chapter.id,
    ]);
    res.json({ chapter: get('SELECT * FROM chapters WHERE id = ?', [chapter.id]) });
  }),
);

router.delete(
  '/chapters/:id',
  requireStaff,
  asyncHandler(async (req, res) => {
    const chapter = get('SELECT * FROM chapters WHERE id = ?', [toInt(req.params.id)]);
    if (!chapter) throw new HttpError(404, 'Chapter not found.');
    if (!canManageSubject(req.user, chapter.subject_id)) throw new HttpError(403, 'You cannot manage this chapter.');
    run('DELETE FROM chapters WHERE id = ?', [chapter.id]);
    audit(req.user, 'chapter.deleted', chapter.title);
    res.json({ ok: true });
  }),
);

router.post(
  '/lessons',
  requireStaff,
  asyncHandler(async (req, res) => {
    const chapter = get('SELECT * FROM chapters WHERE id = ?', [toInt(req.body.chapter_id)]);
    if (!chapter) throw new HttpError(404, 'Chapter not found.');
    if (!canManageSubject(req.user, chapter.subject_id)) throw new HttpError(403, 'You cannot manage this chapter.');
    const title = str(req.body.title, 140);
    if (!title) throw new HttpError(400, 'Lesson title is required.');
    const { lastId } = run(
      'INSERT INTO lessons (chapter_id, title, kind, content, duration_minutes, position, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        chapter.id,
        title,
        ['reading', 'activity', 'video'].includes(req.body.kind) ? req.body.kind : 'reading',
        str(req.body.content, 4000),
        toInt(req.body.duration_minutes, 10),
        toInt(req.body.position, 1),
        'published',
      ],
    );
    res.status(201).json({ lesson: get('SELECT * FROM lessons WHERE id = ?', [lastId]) });
  }),
);

router.delete(
  '/lessons/:id',
  requireStaff,
  asyncHandler(async (req, res) => {
    const lesson = get('SELECT l.*, c.subject_id FROM lessons l JOIN chapters c ON c.id = l.chapter_id WHERE l.id = ?', [
      toInt(req.params.id),
    ]);
    if (!lesson) throw new HttpError(404, 'Lesson not found.');
    if (!canManageSubject(req.user, lesson.subject_id)) throw new HttpError(403, 'You cannot manage this lesson.');
    run('DELETE FROM lessons WHERE id = ?', [lesson.id]);
    res.json({ ok: true });
  }),
);

router.get(
  '/search',
  requireAuth,
  asyncHandler(async (req, res) => {
    const q = str(req.query.q, 80);
    if (q.length < 2) return res.json({ query: q, results: [] });
    const like = `%${q}%`;
    const user = req.user;
    const level = Number(user.class_level);
    const isStudent = user.role === 'student';
    const results = [];

    for (const subject of subjectsForUser(user)) {
      if (subject.name.toLowerCase().includes(q.toLowerCase()) || (subject.description || '').toLowerCase().includes(q.toLowerCase())) {
        results.push({ type: 'Subject', title: subject.name, subtitle: subject.description, link: `/subjects/${subject.id}`, icon: subject.icon });
      }
    }

    const chapters = all(
      `SELECT c.*, s.name AS subject_name, s.icon FROM chapters c JOIN subjects s ON s.id = c.subject_id
       WHERE c.status = 'published' AND (c.title LIKE ? OR c.description LIKE ?) ${isStudent ? 'AND c.class_level = ?' : ''}
       LIMIT 10`,
      isStudent ? [like, like, level] : [like, like],
    );
    for (const chapter of chapters) {
      results.push({ type: 'Chapter', title: chapter.title, subtitle: `${chapter.subject_name} · Class ${chapter.class_level}`, link: `/subjects/${chapter.subject_id}`, icon: chapter.icon });
    }

    const lessons = all(
      `SELECT l.*, c.title AS chapter_title, c.class_level, s.name AS subject_name, s.icon, c.subject_id
       FROM lessons l JOIN chapters c ON c.id = l.chapter_id JOIN subjects s ON s.id = c.subject_id
       WHERE l.status = 'published' AND (l.title LIKE ? OR l.content LIKE ?) ${isStudent ? 'AND c.class_level = ?' : ''}
       LIMIT 10`,
      isStudent ? [like, like, level] : [like, like],
    );
    for (const lesson of lessons) {
      results.push({ type: 'Lesson', title: lesson.title, subtitle: `${lesson.subject_name} · ${lesson.chapter_title}`, link: `/subjects/${lesson.subject_id}`, icon: lesson.icon });
    }

    const videos = all(
      `SELECT * FROM videos WHERE status = 'approved' AND published = 1 AND title LIKE ? ${isStudent ? 'AND (class_level = ? OR class_level IS NULL)' : ''} LIMIT 8`,
      isStudent ? [like, level] : [like],
    );
    for (const video of videos) {
      results.push({ type: 'Video lesson', title: video.title, subtitle: video.channel, link: `/videos/${video.id}`, icon: '▶️' });
    }

    const documents = all(
      `SELECT * FROM documents WHERE status = 'published' AND title LIKE ? ${isStudent ? 'AND class_level = ?' : ''} LIMIT 8`,
      isStudent ? [like, level] : [like],
    );
    for (const doc of documents) {
      results.push({ type: 'Document', title: doc.title, subtitle: doc.doc_type, link: `/library?doc=${doc.id}`, icon: '📄' });
    }

    const books = all(
      `SELECT * FROM books WHERE status = 'published' AND (title LIKE ? OR author LIKE ? OR description LIKE ?) ${isStudent ? 'AND class_level = ?' : ''} LIMIT 8`,
      isStudent ? [like, like, like, level] : [like, like, like],
    );
    for (const book of books) {
      results.push({ type: 'Book', title: book.title, subtitle: `${book.author} · ${book.category}`, link: `/reading/${book.id}`, icon: '📚' });
    }

    const islamic = all('SELECT * FROM islamic_lessons WHERE title LIKE ? OR body LIKE ? LIMIT 6', [like, like]);
    for (const item of islamic) {
      results.push({ type: 'Islamic Academy', title: item.title, subtitle: item.category, link: '/islamic/studies', icon: '🕌' });
    }

    const assignments = all(
      `SELECT * FROM assignments WHERE status = 'published' AND (title LIKE ? OR description LIKE ?) ${isStudent ? 'AND class_level = ?' : ''} LIMIT 6`,
      isStudent ? [like, like, level] : [like, like],
    );
    for (const assignment of assignments) {
      results.push({ type: 'Assignment', title: assignment.title, subtitle: `Due ${assignment.due_at || 'soon'}`, link: '/assignments', icon: '📝' });
    }

    res.json({ query: q, results });
  }),
);

export default router;

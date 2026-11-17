import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { UPLOAD_DIR, all, get, run, saveNow } from '../db.js';
import { asyncHandler, HttpError, str, toInt } from '../lib/http.js';
import { requireAuth, requireStaff } from '../auth.js';
import { audit, award, notify } from '../lib/notify.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

export function teacherClasses(user) {
  if (user.role === 'super_admin') return [1, 2, 3, 4, 5, 6, 7, 8];
  return all('SELECT DISTINCT class_level FROM teacher_assignments WHERE teacher_id = ?', [user.id]).map(
    (row) => row.class_level,
  );
}

export function teacherSubjects(user) {
  if (user.role === 'super_admin') return all('SELECT id, name FROM subjects ORDER BY name');
  return all(
    'SELECT DISTINCT s.id, s.name FROM teacher_assignments ta JOIN subjects s ON s.id = ta.subject_id WHERE ta.teacher_id = ? ORDER BY s.name',
    [user.id],
  );
}

function assertClassAccess(user, level) {
  if (user.role === 'super_admin') return;
  if (!teacherClasses(user).includes(Number(level))) {
    throw new HttpError(403, 'You are not assigned to this class.');
  }
}

/* --------------------------------- QUIZZES -------------------------------- */

const normalise = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

router.get(
  '/quizzes',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user;
    if (user.role === 'student') {
      const quizzes = all(
        `SELECT q.*, s.name AS subject_name,
                (SELECT MAX(score) FROM quiz_attempts WHERE quiz_id = q.id AND user_id = ?) AS best_score,
                (SELECT MAX(max_score) FROM quiz_attempts WHERE quiz_id = q.id AND user_id = ?) AS max_score,
                (SELECT COUNT(*) FROM quiz_attempts WHERE quiz_id = q.id AND user_id = ?) AS attempts,
                (SELECT COUNT(*) FROM quiz_questions WHERE quiz_id = q.id) AS question_count
         FROM quizzes q LEFT JOIN subjects s ON s.id = q.subject_id
         WHERE q.status = 'published' AND (q.class_level = ? OR q.class_level IS NULL)
         ORDER BY q.id DESC`,
        [user.id, user.id, user.id, Number(user.class_level)],
      );
      return res.json({ quizzes });
    }
    const quizzes = all(
      `SELECT q.*, s.name AS subject_name,
              (SELECT COUNT(*) FROM quiz_questions WHERE quiz_id = q.id) AS question_count,
              (SELECT COUNT(*) FROM quiz_attempts WHERE quiz_id = q.id) AS attempt_count
       FROM quizzes q LEFT JOIN subjects s ON s.id = q.subject_id
       ${user.role === 'teacher' ? 'WHERE q.created_by = ? OR q.class_level IN (' + teacherClasses(user).map(() => '?').join(',') + ')' : ''}
       ORDER BY q.id DESC`,
      user.role === 'teacher' ? [user.id, ...teacherClasses(user)] : [],
    );
    res.json({ quizzes });
  }),
);

router.get(
  '/quizzes/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const quiz = get(
      'SELECT q.*, s.name AS subject_name FROM quizzes q LEFT JOIN subjects s ON s.id = q.subject_id WHERE q.id = ?',
      [toInt(req.params.id)],
    );
    if (!quiz) throw new HttpError(404, 'Quiz not found.');
    const isStudent = req.user.role === 'student';
    if (isStudent && (quiz.status !== 'published' || (quiz.class_level && quiz.class_level !== Number(req.user.class_level)))) {
      throw new HttpError(403, 'This quiz is not assigned to your class.');
    }
    const questions = all('SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY position, id', [quiz.id]);
    const attempts = isStudent
      ? all('SELECT * FROM quiz_attempts WHERE quiz_id = ? AND user_id = ? ORDER BY id DESC', [quiz.id, req.user.id])
      : all(
          `SELECT qa.*, u.display_name, u.student_id FROM quiz_attempts qa JOIN users u ON u.id = qa.user_id
           WHERE qa.quiz_id = ? ORDER BY qa.submitted_at DESC`,
          [quiz.id],
        );
    const lastAttempt = attempts[0] || null;
    const revealAnswers = !isStudent || Boolean(lastAttempt);
    res.json({
      quiz,
      attempts,
      attempt: lastAttempt,
      questions: questions.map((question) => ({
        ...question,
        options: JSON.parse(question.options || '[]'),
        answer: revealAnswers ? question.answer : undefined,
      })),
    });
  }),
);

router.post(
  '/quizzes',
  requireStaff,
  asyncHandler(async (req, res) => {
    const title = str(req.body.title, 160);
    const classLevel = toInt(req.body.class_level, null);
    if (!title) throw new HttpError(400, 'Quiz title is required.');
    if (classLevel) assertClassAccess(req.user, classLevel);
    const { lastId } = run(
      'INSERT INTO quizzes (title, description, subject_id, class_level, time_limit, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        title,
        str(req.body.description, 600),
        toInt(req.body.subject_id, null),
        classLevel,
        toInt(req.body.time_limit, 15),
        req.body.status === 'published' ? 'published' : 'draft',
        req.user.id,
      ],
    );
    const questions = Array.isArray(req.body.questions) ? req.body.questions : [];
    questions.forEach((question, index) => {
      run(
        'INSERT INTO quiz_questions (quiz_id, type, prompt, options, answer, marks, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          lastId,
          ['mcq', 'truefalse', 'short'].includes(question.type) ? question.type : 'mcq',
          str(question.prompt, 600) || `Question ${index + 1}`,
          JSON.stringify(question.options || []),
          str(question.answer, 400),
          toInt(question.marks, 1),
          index + 1,
        ],
      );
    });
    if (req.body.status === 'published' && classLevel) {
      notify({ classLevel, title: 'New quiz assigned', body: title, kind: 'quiz', link: `/quizzes/${lastId}` });
    }
    audit(req.user, 'quiz.created', title);
    saveNow();
    res.status(201).json({ quiz: get('SELECT * FROM quizzes WHERE id = ?', [lastId]) });
  }),
);

router.patch(
  '/quizzes/:id',
  requireStaff,
  asyncHandler(async (req, res) => {
    const quiz = get('SELECT * FROM quizzes WHERE id = ?', [toInt(req.params.id)]);
    if (!quiz) throw new HttpError(404, 'Quiz not found.');
    if (req.user.role === 'teacher' && quiz.created_by !== req.user.id) {
      throw new HttpError(403, 'You can only edit quizzes you created.');
    }
    run('UPDATE quizzes SET title = ?, description = ?, time_limit = ?, status = ?, class_level = ? WHERE id = ?', [
      str(req.body.title, 160) || quiz.title,
      req.body.description !== undefined ? str(req.body.description, 600) : quiz.description,
      toInt(req.body.time_limit, quiz.time_limit),
      ['draft', 'published', 'archived'].includes(req.body.status) ? req.body.status : quiz.status,
      req.body.class_level === undefined ? quiz.class_level : toInt(req.body.class_level, null),
      quiz.id,
    ]);
    if (Array.isArray(req.body.questions)) {
      run('DELETE FROM quiz_questions WHERE quiz_id = ?', [quiz.id]);
      req.body.questions.forEach((question, index) => {
        run(
          'INSERT INTO quiz_questions (quiz_id, type, prompt, options, answer, marks, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [
            quiz.id,
            ['mcq', 'truefalse', 'short'].includes(question.type) ? question.type : 'mcq',
            str(question.prompt, 600) || `Question ${index + 1}`,
            JSON.stringify(question.options || []),
            str(question.answer, 400),
            toInt(question.marks, 1),
            index + 1,
          ],
        );
      });
    }
    audit(req.user, 'quiz.updated', quiz.title);
    saveNow();
    res.json({ quiz: get('SELECT * FROM quizzes WHERE id = ?', [quiz.id]) });
  }),
);

router.delete(
  '/quizzes/:id',
  requireStaff,
  asyncHandler(async (req, res) => {
    const quiz = get('SELECT * FROM quizzes WHERE id = ?', [toInt(req.params.id)]);
    if (!quiz) throw new HttpError(404, 'Quiz not found.');
    if (req.user.role === 'teacher' && quiz.created_by !== req.user.id) {
      throw new HttpError(403, 'You can only delete quizzes you created.');
    }
    run('DELETE FROM quizzes WHERE id = ?', [quiz.id]);
    audit(req.user, 'quiz.deleted', quiz.title);
    saveNow();
    res.json({ ok: true });
  }),
);

router.post(
  '/quizzes/:id/submit',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'student') throw new HttpError(403, 'Only students submit quiz answers.');
    const quiz = get('SELECT * FROM quizzes WHERE id = ?', [toInt(req.params.id)]);
    if (!quiz || quiz.status !== 'published') throw new HttpError(404, 'Quiz not available.');
    if (quiz.class_level && quiz.class_level !== Number(req.user.class_level)) {
      throw new HttpError(403, 'This quiz is not assigned to your class.');
    }
    const questions = all('SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY position, id', [quiz.id]);
    const answers = Array.isArray(req.body.answers) ? req.body.answers : [];
    let score = 0;
    let maxScore = 0;
    let pending = 0;
    const graded = questions.map((question) => {
      const given = answers.find((a) => Number(a.question_id) === question.id)?.answer ?? '';
      maxScore += question.marks;
      const isCorrect = normalise(given) === normalise(question.answer);
      if (question.type === 'short') {
        if (isCorrect) score += question.marks;
        else if (String(given).trim()) pending += 1;
      } else if (isCorrect) {
        score += question.marks;
      }
      return { question_id: question.id, prompt: question.prompt, given, correct: question.answer, isCorrect, marks: question.marks };
    });
    const { lastId } = run(
      'INSERT INTO quiz_attempts (quiz_id, user_id, score, max_score, answers, status) VALUES (?, ?, ?, ?, ?, ?)',
      [quiz.id, req.user.id, score, maxScore, JSON.stringify(graded), pending ? 'submitted' : 'graded'],
    );
    const percent = maxScore ? Math.round((score / maxScore) * 100) : 0;
    if (percent >= 80) award(req.user.id, 'quiz_achiever', 'Assignment Achiever', 'Scored 80% or more in a quiz.');
    if (percent === 100 && maxScore > 0) award(req.user.id, 'perfect_quiz', 'Perfect Score', 'Answered every question correctly.');
    saveNow();
    res.status(201).json({
      attempt: get('SELECT * FROM quiz_attempts WHERE id = ?', [lastId]),
      percent,
      pending_review: pending,
      review: graded,
    });
  }),
);

/* ------------------------------- ASSIGNMENTS ------------------------------ */

router.get(
  '/assignments',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user;
    if (user.role === 'student') {
      const assignments = all(
        `SELECT a.*, s.name AS subject_name, sub.status AS submission_status, sub.grade, sub.feedback, sub.submitted_at
         FROM assignments a LEFT JOIN subjects s ON s.id = a.subject_id
         LEFT JOIN submissions sub ON sub.assignment_id = a.id AND sub.user_id = ?
         WHERE a.status = 'published' AND a.class_level = ? ORDER BY a.due_at`,
        [user.id, Number(user.class_level)],
      );
      return res.json({ assignments });
    }
    const classes = teacherClasses(user);
    const assignments = all(
      `SELECT a.*, s.name AS subject_name,
              (SELECT COUNT(*) FROM submissions WHERE assignment_id = a.id) AS submission_count,
              (SELECT COUNT(*) FROM users WHERE role = 'student' AND class_level = a.class_level AND status = 'active') AS student_count
       FROM assignments a LEFT JOIN subjects s ON s.id = a.subject_id
       WHERE a.class_level IN (${classes.map(() => '?').join(',')}) ORDER BY a.id DESC`,
      classes,
    );
    res.json({ assignments });
  }),
);

router.post(
  '/assignments',
  requireStaff,
  asyncHandler(async (req, res) => {
    const title = str(req.body.title, 160);
    const classLevel = toInt(req.body.class_level, null);
    if (!title) throw new HttpError(400, 'Assignment title is required.');
    if (classLevel) assertClassAccess(req.user, classLevel);
    const { lastId } = run(
      `INSERT INTO assignments (title, description, subject_id, class_level, due_at, attachment_doc, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        title,
        str(req.body.description, 3000),
        toInt(req.body.subject_id, null),
        classLevel,
        str(req.body.due_at, 40),
        toInt(req.body.attachment_doc, null),
        req.body.status === 'draft' ? 'draft' : 'published',
        req.user.id,
      ],
    );
    if (req.body.status !== 'draft' && classLevel) {
      notify({ classLevel, title: 'New assignment', body: `${title} — due ${req.body.due_at || 'soon'}`, kind: 'assignment', link: '/assignments' });
    }
    audit(req.user, 'assignment.created', title);
    saveNow();
    res.status(201).json({ assignment: get('SELECT * FROM assignments WHERE id = ?', [lastId]) });
  }),
);

router.patch(
  '/assignments/:id',
  requireStaff,
  asyncHandler(async (req, res) => {
    const assignment = get('SELECT * FROM assignments WHERE id = ?', [toInt(req.params.id)]);
    if (!assignment) throw new HttpError(404, 'Assignment not found.');
    if (req.user.role === 'teacher') assertClassAccess(req.user, assignment.class_level);
    run(
      'UPDATE assignments SET title = ?, description = ?, due_at = ?, status = ?, class_level = ? WHERE id = ?',
      [
        str(req.body.title, 160) || assignment.title,
        req.body.description !== undefined ? str(req.body.description, 3000) : assignment.description,
        str(req.body.due_at, 40) || assignment.due_at,
        ['published', 'draft', 'archived'].includes(req.body.status) ? req.body.status : assignment.status,
        req.body.class_level === undefined ? assignment.class_level : toInt(req.body.class_level, assignment.class_level),
        assignment.id,
      ],
    );
    res.json({ assignment: get('SELECT * FROM assignments WHERE id = ?', [assignment.id]) });
  }),
);

router.delete(
  '/assignments/:id',
  requireStaff,
  asyncHandler(async (req, res) => {
    const assignment = get('SELECT * FROM assignments WHERE id = ?', [toInt(req.params.id)]);
    if (!assignment) throw new HttpError(404, 'Assignment not found.');
    if (req.user.role === 'teacher') assertClassAccess(req.user, assignment.class_level);
    run('DELETE FROM assignments WHERE id = ?', [assignment.id]);
    audit(req.user, 'assignment.deleted', assignment.title);
    saveNow();
    res.json({ ok: true });
  }),
);

router.post(
  '/assignments/:id/submit',
  requireAuth,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'student') throw new HttpError(403, 'Only students can submit assignments.');
    const assignment = get('SELECT * FROM assignments WHERE id = ?', [toInt(req.params.id)]);
    if (!assignment || assignment.status !== 'published') throw new HttpError(404, 'Assignment not available.');
    if (assignment.class_level !== Number(req.user.class_level)) {
      throw new HttpError(403, 'This assignment is not for your class.');
    }
    let fileName = null;
    if (req.file) {
      if (req.file.size > 20 * 1024 * 1024) throw new HttpError(400, 'Files must be smaller than 20 MB.');
      fileName = `${Date.now()}-${req.file.originalname.replace(/[^\w.\- ]/g, '_')}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, fileName), req.file.buffer);
    }
    const existing = get('SELECT * FROM submissions WHERE assignment_id = ? AND user_id = ?', [assignment.id, req.user.id]);
    if (existing) {
      run(
        "UPDATE submissions SET body = ?, file_name = COALESCE(?, file_name), status = 'submitted', submitted_at = datetime('now') WHERE id = ?",
        [str(req.body.body, 6000), fileName, existing.id],
      );
    } else {
      run('INSERT INTO submissions (assignment_id, user_id, body, file_name) VALUES (?, ?, ?, ?)', [
        assignment.id,
        req.user.id,
        str(req.body.body, 6000),
        fileName,
      ]);
    }
    award(req.user.id, 'first_assignment', 'Assignment Achiever', 'Submitted your first assignment.');
    saveNow();
    res.status(201).json({ submission: get('SELECT * FROM submissions WHERE assignment_id = ? AND user_id = ?', [assignment.id, req.user.id]) });
  }),
);

router.get(
  '/assignments/:id/submissions',
  requireStaff,
  asyncHandler(async (req, res) => {
    const assignment = get('SELECT * FROM assignments WHERE id = ?', [toInt(req.params.id)]);
    if (!assignment) throw new HttpError(404, 'Assignment not found.');
    if (req.user.role === 'teacher') assertClassAccess(req.user, assignment.class_level);
    res.json({
      assignment,
      submissions: all(
        `SELECT sub.*, u.display_name, u.student_id, u.avatar FROM submissions sub JOIN users u ON u.id = sub.user_id
         WHERE sub.assignment_id = ? ORDER BY sub.submitted_at DESC`,
        [assignment.id],
      ),
    });
  }),
);

router.get(
  '/submissions/:id/file',
  requireStaff,
  asyncHandler(async (req, res) => {
    const submission = get('SELECT * FROM submissions WHERE id = ?', [toInt(req.params.id)]);
    if (!submission?.file_name) throw new HttpError(404, 'No file attached to this submission.');
    const filePath = path.join(UPLOAD_DIR, submission.file_name);
    if (!fs.existsSync(filePath)) throw new HttpError(404, 'File is missing.');
    res.download(filePath);
  }),
);

router.patch(
  '/submissions/:id',
  requireStaff,
  asyncHandler(async (req, res) => {
    const submission = get(
      `SELECT sub.*, a.class_level FROM submissions sub JOIN assignments a ON a.id = sub.assignment_id WHERE sub.id = ?`,
      [toInt(req.params.id)],
    );
    if (!submission) throw new HttpError(404, 'Submission not found.');
    if (req.user.role === 'teacher') assertClassAccess(req.user, submission.class_level);
    const grade = req.body.grade === undefined || req.body.grade === '' ? null : Number(req.body.grade);
    const status = req.body.return_for_correction ? 'returned' : 'graded';
    run('UPDATE submissions SET grade = ?, feedback = ?, status = ? WHERE id = ?', [
      grade,
      str(req.body.feedback, 2000),
      status,
      submission.id,
    ]);
    notify({
      userId: submission.user_id,
      title: status === 'returned' ? 'Assignment returned for correction' : 'Assignment graded',
      body: str(req.body.feedback, 200) || 'Open your assignment to see the feedback.',
      kind: 'assignment',
      link: '/assignments',
    });
    audit(req.user, 'submission.graded', `submission ${submission.id}`);
    saveNow();
    res.json({ submission: get('SELECT * FROM submissions WHERE id = ?', [submission.id]) });
  }),
);

/* -------------------------------- ATTENDANCE ------------------------------ */

router.get(
  '/attendance',
  requireStaff,
  asyncHandler(async (req, res) => {
    const level = toInt(req.query.class, teacherClasses(req.user)[0]);
    assertClassAccess(req.user, level);
    const date = str(req.query.date, 20) || new Date().toISOString().slice(0, 10);
    const students = all(
      "SELECT id, display_name, full_name, student_id, avatar FROM users WHERE role = 'student' AND class_level = ? AND status = 'active' ORDER BY display_name",
      [level],
    );
    const marked = all('SELECT * FROM attendance WHERE class_level = ? AND date = ?', [level, date]);
    res.json({
      date,
      class_level: level,
      students: students.map((student) => ({
        ...student,
        status: marked.find((row) => row.student_id === student.id)?.status || null,
      })),
    });
  }),
);

router.post(
  '/attendance',
  requireStaff,
  asyncHandler(async (req, res) => {
    const level = toInt(req.body.class_level);
    assertClassAccess(req.user, level);
    const date = str(req.body.date, 20) || new Date().toISOString().slice(0, 10);
    const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
    for (const entry of entries) {
      const status = ['present', 'absent', 'excused'].includes(entry.status) ? entry.status : 'present';
      run(
        `INSERT INTO attendance (student_id, class_level, date, status, marked_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(student_id, date) DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by`,
        [toInt(entry.student_id), level, date, status, req.user.id],
      );
    }
    audit(req.user, 'attendance.recorded', `class ${level} ${date}`);
    saveNow();
    res.json({ ok: true, saved: entries.length, date });
  }),
);

router.get(
  '/attendance/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const records = all('SELECT * FROM attendance WHERE student_id = ? ORDER BY date DESC LIMIT 60', [req.user.id]);
    const present = records.filter((r) => r.status === 'present').length;
    res.json({
      records,
      summary: {
        present,
        absent: records.filter((r) => r.status === 'absent').length,
        excused: records.filter((r) => r.status === 'excused').length,
        rate: records.length ? Math.round((present / records.length) * 100) : 100,
      },
    });
  }),
);

router.get(
  '/attendance/report',
  requireStaff,
  asyncHandler(async (req, res) => {
    const level = toInt(req.query.class, null);
    if (level) assertClassAccess(req.user, level);
    const rows = all(
      `SELECT a.*, u.display_name, u.student_id, u.class_level FROM attendance a JOIN users u ON u.id = a.student_id
       ${level ? 'WHERE a.class_level = ?' : 'WHERE a.class_level IN (' + teacherClasses(req.user).map(() => '?').join(',') + ')'}
       ORDER BY a.date DESC, u.display_name`,
      level ? [level] : teacherClasses(req.user),
    );
    if (req.query.format === 'csv') {
      const header = 'Date,Student,Student ID,Class,Status\n';
      const body = rows
        .map((r) => `${r.date},"${r.display_name}",${r.student_id},${r.class_level},${r.status}`)
        .join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="attendance-report.csv"');
      return res.send(header + body);
    }
    res.json({ records: rows });
  }),
);

/* --------------------------------- REPORTS -------------------------------- */

function studentReport(studentId) {
  const student = get("SELECT * FROM users WHERE id = ? AND role = 'student'", [studentId]);
  if (!student) throw new HttpError(404, 'Student not found.');
  const quizzes = all(
    `SELECT qa.*, q.title, q.subject_id, s.name AS subject_name FROM quiz_attempts qa
     JOIN quizzes q ON q.id = qa.quiz_id LEFT JOIN subjects s ON s.id = q.subject_id
     WHERE qa.user_id = ? ORDER BY qa.submitted_at DESC`,
    [studentId],
  );
  const assignments = all(
    `SELECT a.id, a.title, a.due_at, a.class_level, s.name AS subject_name, sub.status AS submission_status, sub.grade
     FROM assignments a LEFT JOIN submissions sub ON sub.assignment_id = a.id AND sub.user_id = ?
     LEFT JOIN subjects s ON s.id = a.subject_id WHERE a.class_level = ? AND a.status = 'published'`,
    [studentId, student.class_level],
  );
  const attendance = all('SELECT * FROM attendance WHERE student_id = ? ORDER BY date DESC', [studentId]);
  const reading = all(
    `SELECT sh.*, b.title, b.category FROM bookshelf sh JOIN books b ON b.id = sh.book_id WHERE sh.user_id = ?`,
    [studentId],
  );
  const videos = all('SELECT * FROM video_progress WHERE user_id = ?', [studentId]);
  const subjects = all(
    'SELECT s.id, s.name FROM subjects s JOIN subject_classes sc ON sc.subject_id = s.id WHERE sc.class_level = ?',
    [student.class_level],
  );
  const perSubject = subjects.map((subject) => {
    const subjectQuizzes = quizzes.filter((q) => q.subject_id === subject.id);
    const average = subjectQuizzes.length
      ? Math.round(subjectQuizzes.reduce((sum, q) => sum + (q.max_score ? (q.score / q.max_score) * 100 : 0), 0) / subjectQuizzes.length)
      : null;
    const subjectAssignments = assignments.filter((a) => a.subject_name === subject.name);
    const done = subjectAssignments.filter((a) => a.submission_status).length;
    return {
      subject: subject.name,
      quiz_average: average,
      quizzes_taken: subjectQuizzes.length,
      assignments_done: done,
      assignments_total: subjectAssignments.length,
      progress: average ?? (subjectAssignments.length ? Math.round((done / subjectAssignments.length) * 100) : 0),
    };
  });
  const attendanceRate = attendance.length
    ? Math.round((attendance.filter((a) => a.status !== 'absent').length / attendance.length) * 100)
    : 100;
  const quizAverage = quizzes.length
    ? Math.round(quizzes.reduce((sum, q) => sum + (q.max_score ? (q.score / q.max_score) * 100 : 0), 0) / quizzes.length)
    : 0;
  return {
    student: {
      id: student.id,
      full_name: student.full_name,
      display_name: student.display_name,
      student_id: student.student_id,
      class_level: student.class_level,
      avatar: student.avatar,
      status: student.status,
    },
    per_subject: perSubject,
    quizzes,
    assignments,
    attendance,
    reading,
    videos,
    achievements: all('SELECT * FROM achievements WHERE user_id = ? ORDER BY earned_at DESC', [studentId]),
    summary: {
      quiz_average: quizAverage,
      assignments_done: assignments.filter((a) => a.submission_status).length,
      assignments_total: assignments.length,
      attendance_rate: attendanceRate,
      books_completed: reading.filter((r) => r.shelf === 'completed').length,
      reading_minutes: Math.round(reading.reduce((sum, r) => sum + (r.reading_seconds || 0), 0) / 60),
      videos_completed: videos.filter((v) => v.completed).length,
      overall: Math.round((quizAverage + attendanceRate + (assignments.length ? (assignments.filter((a) => a.submission_status).length / assignments.length) * 100 : 100)) / 3),
    },
  };
}

router.get(
  '/reports/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'student') throw new HttpError(400, 'Report cards are for students.');
    res.json(studentReport(req.user.id));
  }),
);

router.get(
  '/reports/student/:id',
  requireStaff,
  asyncHandler(async (req, res) => {
    const student = get("SELECT * FROM users WHERE id = ? AND role = 'student'", [toInt(req.params.id)]);
    if (!student) throw new HttpError(404, 'Student not found.');
    assertClassAccess(req.user, student.class_level);
    res.json(studentReport(student.id));
  }),
);

router.get(
  '/reports/class/:level',
  requireStaff,
  asyncHandler(async (req, res) => {
    const level = toInt(req.params.level);
    assertClassAccess(req.user, level);
    const students = all(
      "SELECT id FROM users WHERE role = 'student' AND class_level = ? AND status = 'active' ORDER BY display_name",
      [level],
    );
    res.json({ class_level: level, students: students.map((s) => studentReport(s.id)) });
  }),
);

export default router;

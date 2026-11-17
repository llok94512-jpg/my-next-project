import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { UPLOAD_DIR, all, get, run, saveNow } from '../db.js';
import { asyncHandler, HttpError, str, toInt } from '../lib/http.js';
import { canManageSubject, requireAdminMode, requireAuth, requireStaff } from '../auth.js';
import { audit, award, notify } from '../lib/notify.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

const safeName = (original, fallbackExt = 'pdf') => {
  const ext = (path.extname(String(original || '')).toLowerCase() || `.${fallbackExt}`).replace(/[^.a-z0-9]/g, '');
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}${ext}`;
};

function storeFile(file, ext) {
  const name = safeName(file?.originalname, ext);
  fs.writeFileSync(path.join(UPLOAD_DIR, name), file.buffer);
  return { name, size: file.size };
}

const classAllowed = (row, user) =>
  user.role !== 'student' || row.class_level === null || Number(row.class_level) === Number(user.class_level);

/* ------------------------------- DOCUMENTS ------------------------------- */

router.get(
  '/documents',
  requireAuth,
  asyncHandler(async (req, res) => {
    const params = [];
    const where = [];
    if (req.user.role === 'student') {
      where.push('d.status = ?', 'd.class_level = ?');
      params.push('published', Number(req.user.class_level));
    } else if (req.query.all !== '1') {
      where.push("d.status = ?");
      params.push('published');
    }
    const subject = toInt(req.query.subject, null);
    if (subject) {
      where.push('d.subject_id = ?');
      params.push(subject);
    }
    const type = str(req.query.type, 40);
    if (type) {
      where.push('d.doc_type = ?');
      params.push(type);
    }
    const q = str(req.query.q, 80);
    if (q) {
      where.push('d.title LIKE ?');
      params.push(`%${q}%`);
    }
    const documents = all(
      `SELECT d.*, s.name AS subject_name, s.icon AS subject_icon FROM documents d
       LEFT JOIN subjects s ON s.id = d.subject_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY d.id DESC LIMIT 100`,
      params,
    );
    res.json({
      documents,
      types: all("SELECT DISTINCT doc_type FROM documents WHERE status = 'published' ORDER BY doc_type").map((r) => r.doc_type),
    });
  }),
);

router.get(
  '/documents/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const doc = get(
      `SELECT d.*, s.name AS subject_name FROM documents d LEFT JOIN subjects s ON s.id = d.subject_id WHERE d.id = ?`,
      [toInt(req.params.id)],
    );
    if (!doc) throw new HttpError(404, 'Document not found.');
    if (!classAllowed(doc, req.user) || (doc.status !== 'published' && req.user.role === 'student')) {
      throw new HttpError(403, 'This document is not available for your account.');
    }
    res.json({ document: doc });
  }),
);

router.get(
  '/documents/:id/file',
  requireAuth,
  asyncHandler(async (req, res) => {
    const doc = get('SELECT * FROM documents WHERE id = ?', [toInt(req.params.id)]);
    if (!doc) throw new HttpError(404, 'Document not found.');
    if (!classAllowed(doc, req.user) || (doc.status !== 'published' && req.user.role === 'student')) {
      throw new HttpError(403, 'This document is not available for your account.');
    }
    const filePath = path.join(UPLOAD_DIR, doc.file_name || '');
    if (!doc.file_name || !fs.existsSync(filePath)) throw new HttpError(404, 'The file for this document is missing.');
    if (req.query.download === '1') {
      run('UPDATE documents SET downloads = downloads + 1 WHERE id = ?', [doc.id]);
      scheduleFlush();
    }
    res.type(doc.mime || 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${(doc.title || 'document').replace(/[^\w -]/g, '')}.pdf"`);
    res.sendFile(filePath);
  }),
);

router.post(
  '/documents',
  requireStaff,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const title = str(req.body.title, 160);
    if (!title) throw new HttpError(400, 'Document title is required.');
    if (!req.file) throw new HttpError(400, 'Please choose a PDF file to upload.');
    if (!/\.pdf$/i.test(req.file.originalname) && req.file.mimetype !== 'application/pdf') {
      throw new HttpError(400, 'Only PDF documents are supported here.');
    }
    const isAdmin = req.user.role === 'super_admin' && req.session?.admin_verified;
    const stored = storeFile(req.file, 'pdf');
    const { lastId } = run(
      `INSERT INTO documents (title, doc_type, subject_id, chapter_id, class_level, file_name, mime, size, pages, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        title,
        str(req.body.doc_type, 40) || 'notes',
        toInt(req.body.subject_id, null),
        toInt(req.body.chapter_id, null),
        toInt(req.body.class_level, null),
        stored.name,
        'application/pdf',
        stored.size,
        toInt(req.body.pages, 0),
        isAdmin ? 'published' : 'pending',
        req.user.id,
      ],
    );
    if (isAdmin) {
      notify({
        classLevel: toInt(req.body.class_level, null),
        title: 'New document available',
        body: title,
        kind: 'document',
        link: '/library',
      });
    }
    audit(req.user, 'document.uploaded', title);
    saveNow();
    res.status(201).json({ document: get('SELECT * FROM documents WHERE id = ?', [lastId]) });
  }),
);

router.patch(
  '/documents/:id',
  requireAdminMode,
  asyncHandler(async (req, res) => {
    const doc = get('SELECT * FROM documents WHERE id = ?', [toInt(req.params.id)]);
    if (!doc) throw new HttpError(404, 'Document not found.');
    run(
      'UPDATE documents SET title = ?, doc_type = ?, subject_id = ?, class_level = ?, status = ? WHERE id = ?',
      [
        str(req.body.title, 160) || doc.title,
        str(req.body.doc_type, 40) || doc.doc_type,
        toInt(req.body.subject_id, doc.subject_id),
        req.body.class_level === undefined ? doc.class_level : toInt(req.body.class_level, null),
        ['published', 'archived'].includes(req.body.status) ? req.body.status : doc.status,
        doc.id,
      ],
    );
    if (req.body.status === 'published' && doc.status !== 'published') {
      notify({ classLevel: doc.class_level, title: 'New document available', body: doc.title, kind: 'document', link: '/library' });
    }
    audit(req.user, 'document.updated', doc.title);
    res.json({ document: get('SELECT * FROM documents WHERE id = ?', [doc.id]) });
  }),
);

router.post(
  '/documents/:id/replace',
  requireAdminMode,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const doc = get('SELECT * FROM documents WHERE id = ?', [toInt(req.params.id)]);
    if (!doc) throw new HttpError(404, 'Document not found.');
    if (!req.file) throw new HttpError(400, 'Please choose a replacement PDF.');
    const stored = storeFile(req.file, 'pdf');
    if (doc.file_name) {
      const old = path.join(UPLOAD_DIR, doc.file_name);
      if (fs.existsSync(old)) fs.unlinkSync(old);
    }
    run('UPDATE documents SET file_name = ?, size = ?, mime = ? WHERE id = ?', [stored.name, stored.size, 'application/pdf', doc.id]);
    audit(req.user, 'document.replaced', doc.title);
    saveNow();
    res.json({ document: get('SELECT * FROM documents WHERE id = ?', [doc.id]) });
  }),
);

router.delete(
  '/documents/:id',
  requireAdminMode,
  asyncHandler(async (req, res) => {
    const doc = get('SELECT * FROM documents WHERE id = ?', [toInt(req.params.id)]);
    if (!doc) throw new HttpError(404, 'Document not found.');
    run('DELETE FROM documents WHERE id = ?', [doc.id]);
    audit(req.user, 'document.deleted', doc.title);
    saveNow();
    res.json({ ok: true });
  }),
);

/* --------------------------------- BOOKS --------------------------------- */

function bookFilter(req, res) {
  const params = [];
  const where = [];
  if (req.user.role === 'student') {
    where.push('b.status = ?', 'b.class_level = ?');
    params.push('published', Number(req.user.class_level));
  } else if (req.query.all !== '1') {
    where.push('b.status = ?');
    params.push('published');
  }
  const category = str(req.query.category, 60);
  if (category) {
    where.push('(b.category = ? OR b.subcategory = ?)');
    params.push(category, category);
  }
  const format = str(req.query.format, 10);
  if (format) {
    where.push('b.format = ?');
    params.push(format);
  }
  const level = toInt(req.query.class, null);
  if (level && req.user.role !== 'student') {
    where.push('b.class_level = ?');
    params.push(level);
  }
  const q = str(req.query.q, 80);
  if (q) {
    where.push('(b.title LIKE ? OR b.author LIKE ? OR b.description LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  return { where, params };
}

router.get(
  '/books',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { where, params } = bookFilter(req, res);
    const books = all(
      `SELECT b.*, sh.shelf, sh.progress AS my_progress, sh.last_page
       FROM books b LEFT JOIN bookshelf sh ON sh.book_id = b.id AND sh.user_id = ?
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY b.featured DESC, b.title LIMIT 120`,
      [req.user.id, ...params],
    );
    const categories = all(
      "SELECT category, COUNT(*) AS count FROM books WHERE status = 'published' GROUP BY category ORDER BY category",
    );
    res.json({ books, categories });
  }),
);

router.get(
  '/books/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const book = get('SELECT * FROM books WHERE id = ?', [toInt(req.params.id)]);
    if (!book) throw new HttpError(404, 'Book not found.');
    if (!classAllowed(book, req.user) || (book.status !== 'published' && req.user.role === 'student')) {
      throw new HttpError(403, 'This book is not available for your class.');
    }
    res.json({
      book,
      shelf: get('SELECT * FROM bookshelf WHERE book_id = ? AND user_id = ?', [book.id, req.user.id]) || null,
      bookmarks: all('SELECT * FROM bookmarks WHERE book_id = ? AND user_id = ? ORDER BY page', [book.id, req.user.id]),
      notes: all('SELECT * FROM reading_notes WHERE book_id = ? AND user_id = ? ORDER BY id DESC', [book.id, req.user.id]),
      quiz: get("SELECT id, title FROM quizzes WHERE status = 'published' AND title LIKE ? LIMIT 1", [`%${book.title.split(' ')[0]}%`]) || null,
    });
  }),
);

router.get(
  '/books/:id/file',
  requireAuth,
  asyncHandler(async (req, res) => {
    const book = get('SELECT * FROM books WHERE id = ?', [toInt(req.params.id)]);
    if (!book) throw new HttpError(404, 'Book not found.');
    if (!classAllowed(book, req.user) || (book.status !== 'published' && req.user.role === 'student')) {
      throw new HttpError(403, 'This book is not available for your class.');
    }
    const filePath = path.join(UPLOAD_DIR, book.file_name || '');
    if (!book.file_name || !fs.existsSync(filePath)) throw new HttpError(404, 'The book file is missing.');
    res.type(book.format === 'epub' ? 'application/epub+zip' : 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${book.title.replace(/[^\w -]/g, '')}.${book.format}"`);
    res.sendFile(filePath);
  }),
);

router.post(
  '/books',
  requireAdminMode,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const title = str(req.body.title, 160);
    if (!title) throw new HttpError(400, 'Book title is required.');
    if (!req.file) throw new HttpError(400, 'Please upload a PDF or EPUB book file.');
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!['.pdf', '.epub'].includes(ext)) throw new HttpError(400, 'Books must be PDF or EPUB files.');
    const stored = storeFile(req.file, ext.slice(1));
    const { lastId } = run(
      `INSERT INTO books (title, author, description, category, subcategory, class_level, reading_level, language, format, cover_color, file_name, pages, featured, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)`,
      [
        title,
        str(req.body.author, 120) || 'STUDYFLIX Library',
        str(req.body.description, 1200),
        str(req.body.category, 60) || 'Fiction',
        str(req.body.subcategory, 60),
        toInt(req.body.class_level, null),
        str(req.body.reading_level, 30) || 'Growing',
        str(req.body.language, 30) || 'English',
        ext.slice(1),
        str(req.body.cover_color, 20) || '#0b2545',
        stored.name,
        toInt(req.body.pages, 0),
        req.body.featured ? 1 : 0,
        req.user.id,
      ],
    );
    notify({ classLevel: toInt(req.body.class_level, null), title: 'New book in Reading Corner', body: title, kind: 'book', link: '/reading' });
    audit(req.user, 'book.created', title);
    saveNow();
    res.status(201).json({ book: get('SELECT * FROM books WHERE id = ?', [lastId]) });
  }),
);

router.patch(
  '/books/:id',
  requireAdminMode,
  asyncHandler(async (req, res) => {
    const book = get('SELECT * FROM books WHERE id = ?', [toInt(req.params.id)]);
    if (!book) throw new HttpError(404, 'Book not found.');
    run(
      `UPDATE books SET title = ?, author = ?, description = ?, category = ?, subcategory = ?, class_level = ?,
       reading_level = ?, language = ?, featured = ?, status = ? WHERE id = ?`,
      [
        str(req.body.title, 160) || book.title,
        str(req.body.author, 120) || book.author,
        req.body.description !== undefined ? str(req.body.description, 1200) : book.description,
        str(req.body.category, 60) || book.category,
        str(req.body.subcategory, 60) || book.subcategory,
        req.body.class_level === undefined ? book.class_level : toInt(req.body.class_level, null),
        str(req.body.reading_level, 30) || book.reading_level,
        str(req.body.language, 30) || book.language,
        req.body.featured === undefined ? book.featured : req.body.featured ? 1 : 0,
        ['published', 'archived'].includes(req.body.status) ? req.body.status : book.status,
        book.id,
      ],
    );
    if (req.body.status === 'published' && book.status !== 'published') {
      notify({ classLevel: book.class_level, title: 'New book in Reading Corner', body: book.title, kind: 'book', link: '/reading' });
    }
    audit(req.user, 'book.updated', book.title);
    res.json({ book: get('SELECT * FROM books WHERE id = ?', [book.id]) });
  }),
);

router.delete(
  '/books/:id',
  requireAdminMode,
  asyncHandler(async (req, res) => {
    const book = get('SELECT * FROM books WHERE id = ?', [toInt(req.params.id)]);
    if (!book) throw new HttpError(404, 'Book not found.');
    run('DELETE FROM books WHERE id = ?', [book.id]);
    audit(req.user, 'book.deleted', book.title);
    saveNow();
    res.json({ ok: true });
  }),
);

/* ------------------------------- BOOKSHELF ------------------------------- */

router.get(
  '/bookshelf',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = all(
      `SELECT sh.*, b.title, b.author, b.category, b.format, b.cover_color, b.pages, b.class_level
       FROM bookshelf sh JOIN books b ON b.id = sh.book_id
       WHERE sh.user_id = ? ORDER BY sh.updated_at DESC`,
      [req.user.id],
    );
    const shelves = { reading: [], want: [], later: [], favourite: [], completed: [] };
    for (const row of rows) (shelves[row.shelf] || (shelves[row.shelf] = [])).push(row);
    res.json({
      shelves,
      bookmarks: all(
        `SELECT bm.*, b.title AS book_title, b.format FROM bookmarks bm JOIN books b ON b.id = bm.book_id
         WHERE bm.user_id = ? ORDER BY bm.created_at DESC LIMIT 30`,
        [req.user.id],
      ),
      notes: all(
        `SELECT rn.*, b.title AS book_title FROM reading_notes rn JOIN books b ON b.id = rn.book_id
         WHERE rn.user_id = ? ORDER BY rn.created_at DESC LIMIT 30`,
        [req.user.id],
      ),
      stats: {
        reading: rows.filter((r) => r.shelf === 'reading').length,
        completed: rows.filter((r) => r.shelf === 'completed').length,
        favourites: rows.filter((r) => r.shelf === 'favourite').length,
        minutes: Math.round(rows.reduce((sum, r) => sum + (r.reading_seconds || 0), 0) / 60),
        pages: rows.reduce((sum, r) => sum + (r.last_page || 0), 0),
      },
    });
  }),
);

router.post(
  '/books/:id/shelf',
  requireAuth,
  asyncHandler(async (req, res) => {
    const bookId = toInt(req.params.id);
    const book = get('SELECT * FROM books WHERE id = ?', [bookId]);
    if (!book) throw new HttpError(404, 'Book not found.');
    if (!classAllowed(book, req.user)) throw new HttpError(403, 'This book is not available for your class.');
    const shelf = ['reading', 'want', 'later', 'favourite', 'completed'].includes(req.body.shelf) ? req.body.shelf : 'want';
    const existing = get('SELECT * FROM bookshelf WHERE book_id = ? AND user_id = ?', [bookId, req.user.id]);
    if (existing) {
      run("UPDATE bookshelf SET shelf = ?, updated_at = datetime('now') WHERE id = ?", [shelf, existing.id]);
    } else {
      run('INSERT INTO bookshelf (user_id, book_id, shelf) VALUES (?, ?, ?)', [req.user.id, bookId, shelf]);
    }
    if (shelf === 'completed') {
      award(req.user.id, 'first_book', 'First Book', 'You completed your first book.');
      const completed = get("SELECT COUNT(*) AS c FROM bookshelf WHERE user_id = ? AND shelf = 'completed'", [req.user.id]).c;
      if (completed >= 5) award(req.user.id, 'five_books', 'Five Books Completed', 'Five books finished. Keep reading!');
      if (completed >= 10) award(req.user.id, 'reading_champion', 'Reading Champion', 'Ten books completed.');
      if (/islam/i.test(book.category || '')) award(req.user.id, 'islamic_reader', 'Islamic Knowledge Explorer', 'Completed an Islamic book.');
      if (/science|nature|space/i.test(`${book.category} ${book.subcategory}`)) award(req.user.id, 'science_reader', 'Science Reader', 'Completed a science book.');
    }
    saveNow();
    res.json({ shelf: get('SELECT * FROM bookshelf WHERE book_id = ? AND user_id = ?', [bookId, req.user.id]) });
  }),
);

router.post(
  '/books/:id/progress',
  requireAuth,
  asyncHandler(async (req, res) => {
    const bookId = toInt(req.params.id);
    const existing = get('SELECT * FROM bookshelf WHERE book_id = ? AND user_id = ?', [bookId, req.user.id]);
    const page = Math.max(1, toInt(req.body.page, 1));
    const progress = Math.min(100, Math.max(0, Number(req.body.progress ?? 0)));
    const seconds = Math.max(0, toInt(req.body.seconds, 0));
    const location = str(req.body.location, 400);
    if (existing) {
      run(
        `UPDATE bookshelf SET last_page = ?, last_location = COALESCE(?, last_location), progress = MAX(progress, ?),
         reading_seconds = reading_seconds + ?, shelf = CASE WHEN shelf = 'want' OR shelf = 'later' THEN 'reading' ELSE shelf END,
         updated_at = datetime('now') WHERE id = ?`,
        [page, location || null, progress, seconds, existing.id],
      );
    } else {
      run(
        `INSERT INTO bookshelf (user_id, book_id, shelf, last_page, last_location, progress, reading_seconds)
         VALUES (?, ?, 'reading', ?, ?, ?, ?)`,
        [req.user.id, bookId, page, location || null, progress, seconds],
      );
    }
    saveNow();
    res.json({ shelf: get('SELECT * FROM bookshelf WHERE book_id = ? AND user_id = ?', [bookId, req.user.id]) });
  }),
);

/* ------------------------------- BOOKMARKS ------------------------------- */

router.get(
  '/bookmarks',
  requireAuth,
  asyncHandler(async (req, res) => {
    const bookId = toInt(req.query.book, null);
    res.json({
      bookmarks: all(
        `SELECT bm.*, b.title AS book_title, b.format FROM bookmarks bm JOIN books b ON b.id = bm.book_id
         WHERE bm.user_id = ? ${bookId ? 'AND bm.book_id = ?' : ''} ORDER BY bm.created_at DESC`,
        bookId ? [req.user.id, bookId] : [req.user.id],
      ),
    });
  }),
);

router.post(
  '/bookmarks',
  requireAuth,
  asyncHandler(async (req, res) => {
    const bookId = toInt(req.body.book_id);
    const book = get('SELECT * FROM books WHERE id = ?', [bookId]);
    if (!book) throw new HttpError(404, 'Book not found.');
    const label = str(req.body.label, 120) || `Page ${toInt(req.body.page, 1)}`;
    const { lastId } = run('INSERT INTO bookmarks (user_id, book_id, location, page, label) VALUES (?, ?, ?, ?, ?)', [
      req.user.id,
      bookId,
      str(req.body.location, 400) || String(toInt(req.body.page, 1)),
      toInt(req.body.page, 1),
      label,
    ]);
    saveNow();
    res.status(201).json({ bookmark: get('SELECT * FROM bookmarks WHERE id = ?', [lastId]) });
  }),
);

router.delete(
  '/bookmarks/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const bookmark = get('SELECT * FROM bookmarks WHERE id = ? AND user_id = ?', [toInt(req.params.id), req.user.id]);
    if (!bookmark) throw new HttpError(404, 'Bookmark not found.');
    run('DELETE FROM bookmarks WHERE id = ?', [bookmark.id]);
    saveNow();
    res.json({ ok: true });
  }),
);

router.get(
  '/reading-notes',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({
      notes: all(
        `SELECT rn.*, b.title AS book_title FROM reading_notes rn LEFT JOIN books b ON b.id = rn.book_id
         WHERE rn.user_id = ? ORDER BY rn.created_at DESC`,
        [req.user.id],
      ),
    });
  }),
);

router.post(
  '/reading-notes',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = str(req.body.body, 4000);
    if (!body) throw new HttpError(400, 'Write something before saving your note.');
    const { lastId } = run('INSERT INTO reading_notes (user_id, book_id, page, body) VALUES (?, ?, ?, ?)', [
      req.user.id,
      toInt(req.body.book_id, null),
      toInt(req.body.page, 1),
      body,
    ]);
    saveNow();
    res.status(201).json({ note: get('SELECT * FROM reading_notes WHERE id = ?', [lastId]) });
  }),
);

router.delete(
  '/reading-notes/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const note = get('SELECT * FROM reading_notes WHERE id = ? AND user_id = ?', [toInt(req.params.id), req.user.id]);
    if (!note) throw new HttpError(404, 'Note not found.');
    run('DELETE FROM reading_notes WHERE id = ?', [note.id]);
    saveNow();
    res.json({ ok: true });
  }),
);

/* ----------------------------- READING LISTS ----------------------------- */

router.get(
  '/reading/lists',
  requireAuth,
  asyncHandler(async (req, res) => {
    const lists = all(
      `SELECT rl.*, u.display_name AS teacher_name FROM reading_lists rl LEFT JOIN users u ON u.id = rl.teacher_id
       WHERE ? = 'super_admin' OR rl.teacher_id = ? OR rl.class_level = ? ORDER BY rl.id DESC`,
      [req.user.role, req.user.id, req.user.class_level ?? -1],
    );
    res.json({
      lists: lists.map((list) => ({
        ...list,
        books: JSON.parse(list.book_ids || '[]')
          .map((id) => get('SELECT id, title, author, format, cover_color FROM books WHERE id = ?', [Number(id)]))
          .filter(Boolean),
      })),
    });
  }),
);

router.post(
  '/reading/lists',
  requireStaff,
  asyncHandler(async (req, res) => {
    const title = str(req.body.title, 140);
    if (!title) throw new HttpError(400, 'Give your reading list a title.');
    const { lastId } = run(
      'INSERT INTO reading_lists (teacher_id, title, class_level, book_ids, note) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, title, toInt(req.body.class_level, null), JSON.stringify(req.body.book_ids || []), str(req.body.note, 600)],
    );
    notify({ classLevel: toInt(req.body.class_level, null), title: 'New reading list', body: title, kind: 'book', link: '/reading' });
    saveNow();
    res.status(201).json({ list: get('SELECT * FROM reading_lists WHERE id = ?', [lastId]) });
  }),
);

router.delete(
  '/reading/lists/:id',
  requireStaff,
  asyncHandler(async (req, res) => {
    const list = get('SELECT * FROM reading_lists WHERE id = ?', [toInt(req.params.id)]);
    if (!list) throw new HttpError(404, 'Reading list not found.');
    if (req.user.role !== 'super_admin' && list.teacher_id !== req.user.id) {
      throw new HttpError(403, 'You can only remove your own reading lists.');
    }
    run('DELETE FROM reading_lists WHERE id = ?', [list.id]);
    res.json({ ok: true });
  }),
);

/* ------------------------------ READING HOME ----------------------------- */

router.get(
  '/reading/overview',
  requireAuth,
  asyncHandler(async (req, res) => {
    const level = Number(req.user.class_level);
    const isStudent = req.user.role === 'student';
    const params = isStudent ? ['published', level] : ['published'];
    const books = all(
      `SELECT b.*, sh.shelf, sh.progress AS my_progress, sh.last_page
       FROM books b LEFT JOIN bookshelf sh ON sh.book_id = b.id AND sh.user_id = ?
       WHERE b.status = ? ${isStudent ? 'AND b.class_level = ?' : ''}
       ORDER BY b.featured DESC, b.title`,
      [req.user.id, ...params],
    );
    const byCategory = {};
    for (const book of books) {
      const key = book.category || 'Other';
      byCategory[key] = byCategory[key] || [];
      byCategory[key].push(book);
    }
    res.json({
      books,
      featured: books.filter((b) => b.featured).slice(0, 6),
      collections: Object.entries(byCategory).map(([category, items]) => ({ category, count: items.length })),
      continue_reading: books.filter((b) => b.shelf === 'reading' && (b.my_progress || 0) > 0).slice(0, 6),
      achievements: all('SELECT * FROM achievements WHERE user_id = ? ORDER BY earned_at DESC', [req.user.id]),
      levels: all('SELECT DISTINCT reading_level FROM books ORDER BY reading_level').map((r) => r.reading_level),
    });
  }),
);

function scheduleFlush() {
  import('../db.js').then(({ scheduleSave }) => scheduleSave());
}

export default router;

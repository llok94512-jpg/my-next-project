import { Router } from 'express';
import { all, get, run, saveNow } from '../db.js';
import { asyncHandler, HttpError, str, toInt } from '../lib/http.js';
import { requireAdminMode, requireAuth } from '../auth.js';
import { audit } from '../lib/notify.js';

const router = Router();

/**
 * Quran text is never generated locally. It is fetched from the public
 * AlQuran Cloud API (King Fahd Complex Uthmani script + Sahih International
 * translation) and cached. If the source is unreachable and no cache exists the
 * endpoint reports that honestly instead of returning invented text.
 */
router.get(
  '/islamic/quran/:surah',
  requireAuth,
  asyncHandler(async (req, res) => {
    const surah = toInt(req.params.surah);
    if (!surah || surah < 1 || surah > 114) throw new HttpError(400, 'Choose a surah between 1 and 114.');
    const cached = get('SELECT * FROM quran_cache WHERE surah = ?', [surah]);
    if (cached) {
      return res.json({ source: 'api.alquran.cloud (cached)', surah, ...JSON.parse(cached.payload) });
    }
    const url = `https://api.alquran.cloud/v1/surah/${surah}/editions/quran-uthmani,en.sahih`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
      const data = await response.json();
      if (!response.ok || !data?.data?.[0]?.ayahs) {
        throw new Error(data?.data || `Quran source responded ${response.status}`);
      }
      const arabic = data.data[0];
      const english = data.data[1];
      const payload = {
        meta: {
          name_arabic: arabic.name,
          name_english: arabic.englishName,
          meaning: arabic.englishNameTranslation,
          ayahs: arabic.numberOfAyahs,
          revelation: arabic.revelationType,
        },
        ayahs: arabic.ayahs.map((ayah, index) => ({
          number: ayah.numberInSurah,
          arabic: ayah.text,
          translation: english?.ayahs?.[index]?.text || '',
        })),
      };
      run('INSERT OR REPLACE INTO quran_cache (surah, payload, fetched_at) VALUES (?, ?, datetime(\'now\'))', [
        surah,
        JSON.stringify(payload),
      ]);
      saveNow();
      res.json({ source: 'api.alquran.cloud', surah, ...payload });
    } catch (error) {
      res.status(503).json({
        source: 'api.alquran.cloud',
        error:
          'The Quran text source could not be reached and this surah is not cached yet. No text has been generated locally — please retry in a moment.',
        detail: String(error.message || error),
        surah,
      });
    }
  }),
);

router.get(
  '/islamic/home',
  requireAuth,
  asyncHandler(async (req, res) => {
    const level = Number(req.user.class_level);
    const isStudent = req.user.role === 'student';
    res.json({
      surahs: all('SELECT * FROM surahs ORDER BY id'),
      duas: all('SELECT * FROM islamic_duas ORDER BY position, id'),
      lessons: all(
        `SELECT * FROM islamic_lessons ${isStudent ? 'WHERE class_level IS NULL OR class_level = ?' : ''} ORDER BY category, position`,
        isStudent ? [level] : [],
      ),
      memorisation: all('SELECT * FROM memorisation WHERE user_id = ? ORDER BY updated_at DESC', [req.user.id]),
      quizzes: all(
        `SELECT q.*, s.name AS subject_name FROM quizzes q JOIN subjects s ON s.id = q.subject_id
         WHERE q.status = 'published' AND s.name IN ('Islamic Studies','Quran Studies')
         ${isStudent ? 'AND (q.class_level = ? OR q.class_level IS NULL)' : ''} ORDER BY q.id DESC`,
        isStudent ? [level] : [],
      ),
      books: all(
        `SELECT * FROM books WHERE status = 'published' AND category = 'Islamic'
         ${isStudent ? 'AND class_level = ?' : ''} ORDER BY title`,
        isStudent ? [level] : [],
      ),
      videos: all(
        `SELECT * FROM videos WHERE status = 'approved' AND published = 1
         AND (subject_id IN (SELECT id FROM subjects WHERE name IN ('Islamic Studies','Quran Studies')) OR title LIKE '%Quran%')
         ${isStudent ? 'AND (class_level = ? OR class_level IS NULL)' : ''} LIMIT 8`,
        isStudent ? [level] : [],
      ),
    });
  }),
);

router.get(
  '/islamic/duas',
  requireAuth,
  asyncHandler(async (req, res) => {
    const category = str(req.query.category, 60);
    res.json({
      duas: all(
        `SELECT * FROM islamic_duas ${category ? 'WHERE category = ?' : ''} ORDER BY position, id`,
        category ? [category] : [],
      ),
      categories: all('SELECT DISTINCT category FROM islamic_duas ORDER BY category').map((r) => r.category),
    });
  }),
);

router.get(
  '/islamic/studies',
  requireAuth,
  asyncHandler(async (req, res) => {
    const isStudent = req.user.role === 'student';
    const level = Number(req.user.class_level);
    res.json({
      lessons: all(
        `SELECT * FROM islamic_lessons ${isStudent ? 'WHERE class_level IS NULL OR class_level = ?' : ''} ORDER BY category, position`,
        isStudent ? [level] : [],
      ),
      categories: all('SELECT DISTINCT category FROM islamic_lessons ORDER BY category').map((r) => r.category),
    });
  }),
);

router.post(
  '/islamic/lessons',
  requireAdminMode,
  asyncHandler(async (req, res) => {
    const title = str(req.body.title, 160);
    const body = str(req.body.body, 8000);
    if (!title || !body) throw new HttpError(400, 'Title and content are required.');
    const { lastId } = run(
      'INSERT INTO islamic_lessons (title, category, body, reference, class_level, position) VALUES (?, ?, ?, ?, ?, ?)',
      [
        title,
        str(req.body.category, 60) || 'Islamic Studies',
        body,
        str(req.body.reference, 200),
        toInt(req.body.class_level, null),
        toInt(req.body.position, 1),
      ],
    );
    audit(req.user, 'islamic.lesson_created', title);
    saveNow();
    res.status(201).json({ lesson: get('SELECT * FROM islamic_lessons WHERE id = ?', [lastId]) });
  }),
);

router.delete(
  '/islamic/lessons/:id',
  requireAdminMode,
  asyncHandler(async (req, res) => {
    const lesson = get('SELECT * FROM islamic_lessons WHERE id = ?', [toInt(req.params.id)]);
    if (!lesson) throw new HttpError(404, 'Lesson not found.');
    run('DELETE FROM islamic_lessons WHERE id = ?', [lesson.id]);
    audit(req.user, 'islamic.lesson_deleted', lesson.title);
    saveNow();
    res.json({ ok: true });
  }),
);

router.post(
  '/islamic/duas',
  requireAdminMode,
  asyncHandler(async (req, res) => {
    const arabic = str(req.body.arabic, 1000);
    const translation = str(req.body.translation, 1000);
    if (!arabic || !translation) throw new HttpError(400, 'Arabic text and translation are required.');
    const { lastId } = run(
      'INSERT INTO islamic_duas (title, arabic, transliteration, translation, reference, category, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        str(req.body.title, 140) || 'Dua',
        arabic,
        str(req.body.transliteration, 600),
        translation,
        str(req.body.reference, 200),
        str(req.body.category, 60) || 'Daily',
        toInt(req.body.position, 1),
      ],
    );
    audit(req.user, 'islamic.dua_created', req.body.title);
    saveNow();
    res.status(201).json({ dua: get('SELECT * FROM islamic_duas WHERE id = ?', [lastId]) });
  }),
);

router.post(
  '/islamic/memorisation',
  requireAuth,
  asyncHandler(async (req, res) => {
    const surah = toInt(req.body.surah);
    if (!surah || surah < 1 || surah > 114) throw new HttpError(400, 'Choose a valid surah.');
    const existing = get('SELECT * FROM memorisation WHERE user_id = ? AND surah = ?', [req.user.id, surah]);
    const status = ['learning', 'memorised', 'revising'].includes(req.body.status) ? req.body.status : 'learning';
    if (existing) {
      run('UPDATE memorisation SET ayah_from = ?, ayah_to = ?, status = ?, notes = ?, updated_at = datetime(\'now\') WHERE id = ?', [
        toInt(req.body.ayah_from, 1),
        toInt(req.body.ayah_to, existing.ayah_to),
        status,
        str(req.body.notes, 600),
        existing.id,
      ]);
    } else {
      run('INSERT INTO memorisation (user_id, surah, ayah_from, ayah_to, status, notes) VALUES (?, ?, ?, ?, ?, ?)', [
        req.user.id,
        surah,
        toInt(req.body.ayah_from, 1),
        toInt(req.body.ayah_to, 1),
        status,
        str(req.body.notes, 600),
      ]);
    }
    saveNow();
    res.json({ memorisation: all('SELECT * FROM memorisation WHERE user_id = ? ORDER BY updated_at DESC', [req.user.id]) });
  }),
);

router.delete(
  '/islamic/memorisation/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const row = get('SELECT * FROM memorisation WHERE id = ? AND user_id = ?', [toInt(req.params.id), req.user.id]);
    if (!row) throw new HttpError(404, 'Memorisation entry not found.');
    run('DELETE FROM memorisation WHERE id = ?', [row.id]);
    saveNow();
    res.json({ ok: true });
  }),
);

export default router;

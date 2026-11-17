import { Router } from 'express';
import { all, get, run } from '../db.js';
import { asyncHandler, HttpError, str, toInt } from '../lib/http.js';
import { requireAdminMode, requireAuth, requireStaff } from '../auth.js';
import { audit, notify } from '../lib/notify.js';

const router = Router();

const YOUTUBE_KEY = () => process.env.YOUTUBE_API_KEY || '';

export function parseYoutubeId(input) {
  const raw = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})/,
    /(?:youtu\.be\/)([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/** Student-facing list: only approved + published videos for the student's class. */
router.get(
  '/videos',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user;
    const params = [];
    const where = ["v.status = 'approved'", 'v.published = 1'];
    if (user.role === 'student') {
      where.push('(v.class_level = ? OR v.class_level IS NULL)');
      params.push(Number(user.class_level));
    }
    const subjectId = toInt(req.query.subject, null);
    if (subjectId) {
      where.push('v.subject_id = ?');
      params.push(subjectId);
    }
    const search = str(req.query.q, 80);
    if (search) {
      where.push('(v.title LIKE ? OR v.description LIKE ? OR v.channel LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (req.query.favourites === '1') {
      where.push('EXISTS (SELECT 1 FROM video_favorites f WHERE f.video_id = v.id AND f.user_id = ?)');
      params.push(user.id);
    }

    const videos = all(
      `SELECT v.*, s.name AS subject_name, s.icon AS subject_icon, c.title AS chapter_title,
              (SELECT completed FROM video_progress WHERE video_id = v.id AND user_id = ?) AS completed,
              EXISTS (SELECT 1 FROM video_favorites f WHERE f.video_id = v.id AND f.user_id = ?) AS favourite
       FROM videos v LEFT JOIN subjects s ON s.id = v.subject_id LEFT JOIN chapters c ON c.id = v.chapter_id
       WHERE ${where.join(' AND ')} ORDER BY v.created_at DESC LIMIT 60`,
      [user.id, user.id, ...params],
    );
    res.json({ videos });
  }),
);

router.get(
  '/videos/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const video = get(
      `SELECT v.*, s.name AS subject_name, c.title AS chapter_title FROM videos v
       LEFT JOIN subjects s ON s.id = v.subject_id LEFT JOIN chapters c ON c.id = v.chapter_id WHERE v.id = ?`,
      [toInt(req.params.id)],
    );
    if (!video) throw new HttpError(404, 'Video not found.');
    const allowed =
      req.user.role !== 'student' ||
      (video.status === 'approved' &&
        video.published === 1 &&
        (video.class_level === null || video.class_level === Number(req.user.class_level)));
    if (!allowed) throw new HttpError(403, 'This video is not available for your class.');
    res.json({
      video,
      progress: get('SELECT * FROM video_progress WHERE video_id = ? AND user_id = ?', [video.id, req.user.id]) || null,
      favourite: Boolean(get('SELECT 1 AS x FROM video_favorites WHERE video_id = ? AND user_id = ?', [video.id, req.user.id])),
      related: all(
        `SELECT id, title, thumbnail, channel, duration FROM videos
         WHERE status = 'approved' AND published = 1 AND id != ? ${video.subject_id ? 'AND subject_id = ?' : ''} LIMIT 4`,
        video.subject_id ? [video.id, video.subject_id] : [video.id],
      ),
    });
  }),
);

router.post(
  '/videos/:id/progress',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = toInt(req.params.id);
    const video = get('SELECT * FROM videos WHERE id = ?', [id]);
    if (!video) throw new HttpError(404, 'Video not found.');
    const seconds = Math.max(0, toInt(req.body.seconds, 0));
    const completed = req.body.completed ? 1 : 0;
    const existing = get('SELECT * FROM video_progress WHERE video_id = ? AND user_id = ?', [id, req.user.id]);
    if (existing) {
      run('UPDATE video_progress SET completed = ?, seconds = MAX(seconds, ?), updated_at = datetime(\'now\') WHERE id = ?', [
        completed || existing.completed,
        seconds,
        existing.id,
      ]);
    } else {
      run('INSERT INTO video_progress (user_id, video_id, completed, seconds) VALUES (?, ?, ?, ?)', [
        req.user.id,
        id,
        completed,
        seconds,
      ]);
    }
    if (completed && !existing?.completed) {
      const { awardIfNew } = await import('../lib/notify.js');
      awardIfNew(req.user.id, 'first_lesson', 'First Lesson Completed', 'You finished your first video lesson.');
    }
    res.json({ ok: true });
  }),
);

router.post(
  '/videos/:id/favourite',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = toInt(req.params.id);
    const existing = get('SELECT 1 AS x FROM video_favorites WHERE video_id = ? AND user_id = ?', [id, req.user.id]);
    if (existing) {
      run('DELETE FROM video_favorites WHERE video_id = ? AND user_id = ?', [id, req.user.id]);
      return res.json({ favourite: false });
    }
    run('INSERT INTO video_favorites (video_id, user_id) VALUES (?, ?)', [id, req.user.id]);
    res.json({ favourite: true });
  }),
);

/** Live YouTube Data API v3 search — server side only, key never leaves the server. */
router.get(
  '/admin/videos/search',
  requireAdminMode,
  asyncHandler(async (req, res) => {
    const query = str(req.query.q, 120);
    if (!YOUTUBE_KEY()) {
      return res.json({
        configured: false,
        message:
          'YOUTUBE_API_KEY is not configured. Add it in Settings → Environment variables to search YouTube live, or add a video by pasting its YouTube link below.',
        results: [],
      });
    }
    if (!query) throw new HttpError(400, 'Enter a topic to search.');
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('type', 'video');
    url.searchParams.set('maxResults', '12');
    url.searchParams.set('q', query);
    url.searchParams.set('safeSearch', 'strict');
    url.searchParams.set('key', YOUTUBE_KEY());
    const response = await fetch(url);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status === 403 ? 502 : response.status).json({
        configured: true,
        error: data?.error?.message || 'YouTube search failed.',
        results: [],
      });
    }
    const ids = (data.items || []).map((item) => item.id.videoId).filter(Boolean);
    let durations = {};
    if (ids.length) {
      const detailUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
      detailUrl.searchParams.set('part', 'contentDetails');
      detailUrl.searchParams.set('id', ids.join(','));
      detailUrl.searchParams.set('key', YOUTUBE_KEY());
      const detail = await fetch(detailUrl).then((r) => r.json()).catch(() => ({}));
      durations = Object.fromEntries(
        (detail.items || []).map((item) => [item.id, item.contentDetails?.duration || '']),
      );
    }
    res.json({
      configured: true,
      results: (data.items || []).map((item) => ({
        youtube_id: item.id.videoId,
        title: item.snippet.title,
        channel: item.snippet.channelTitle,
        description: item.snippet.description,
        thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
        published_at: item.snippet.publishedAt,
        duration: durations[item.id.videoId] || '',
      })),
    });
  }),
);

/** Admin approval queue. */
router.get(
  '/admin/videos',
  requireAdminMode,
  asyncHandler(async (req, res) => {
    const status = str(req.query.status, 20);
    const videos = all(
      `SELECT v.*, s.name AS subject_name, c.title AS chapter_title, u.display_name AS added_by
       FROM videos v LEFT JOIN subjects s ON s.id = v.subject_id LEFT JOIN chapters c ON c.id = v.chapter_id
       LEFT JOIN users u ON u.id = v.created_by
       ${status ? 'WHERE v.status = ?' : ''} ORDER BY v.status = 'pending' DESC, v.id DESC LIMIT 100`,
      status ? [status] : [],
    );
    res.json({
      configured: Boolean(YOUTUBE_KEY()),
      videos,
      counts: {
        pending: get("SELECT COUNT(*) AS c FROM videos WHERE status = 'pending'").c,
        approved: get("SELECT COUNT(*) AS c FROM videos WHERE status = 'approved'").c,
        published: get("SELECT COUNT(*) AS c FROM videos WHERE status = 'approved' AND published = 1").c,
        rejected: get("SELECT COUNT(*) AS c FROM videos WHERE status = 'rejected'").c,
      },
    });
  }),
);

router.post(
  '/videos',
  requireStaff,
  asyncHandler(async (req, res) => {
    const youtubeId = parseYoutubeId(req.body.youtube_id || req.body.url);
    if (!youtubeId) throw new HttpError(400, 'Provide a valid YouTube video link or 11-character video ID.');
    const title = str(req.body.title, 160);
    if (!title) throw new HttpError(400, 'Video title is required.');
    const duplicate = get('SELECT id FROM videos WHERE youtube_id = ?', [youtubeId]);
    if (duplicate) throw new HttpError(409, 'This video is already in the library.');
    const isAdmin = req.user.role === 'super_admin' && req.session?.admin_verified;
    const { lastId } = run(
      `INSERT INTO videos (youtube_id, title, channel, thumbnail, description, subject_id, chapter_id, class_level, duration, status, published, created_by, approved_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        youtubeId,
        title,
        str(req.body.channel, 120),
        str(req.body.thumbnail, 400) || `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
        str(req.body.description, 1200),
        toInt(req.body.subject_id, null),
        toInt(req.body.chapter_id, null),
        toInt(req.body.class_level, null),
        str(req.body.duration, 20),
        isAdmin ? 'approved' : 'pending',
        isAdmin ? 1 : 0,
        req.user.id,
        isAdmin ? req.user.id : null,
      ],
    );
    audit(req.user, 'video.submitted', title);
    res.status(201).json({ video: get('SELECT * FROM videos WHERE id = ?', [lastId]) });
  }),
);

router.patch(
  '/admin/videos/:id',
  requireAdminMode,
  asyncHandler(async (req, res) => {
    const video = get('SELECT * FROM videos WHERE id = ?', [toInt(req.params.id)]);
    if (!video) throw new HttpError(404, 'Video not found.');
    const status = ['pending', 'approved', 'rejected'].includes(req.body.status) ? req.body.status : video.status;
    const published =
      req.body.published !== undefined ? (req.body.published ? 1 : 0) : status === 'approved' ? video.published : 0;
    run(
      `UPDATE videos SET title = ?, description = ?, subject_id = ?, chapter_id = ?, class_level = ?, status = ?, published = ?, approved_by = ?
       WHERE id = ?`,
      [
        str(req.body.title, 160) || video.title,
        req.body.description !== undefined ? str(req.body.description, 1200) : video.description,
        toInt(req.body.subject_id, video.subject_id),
        toInt(req.body.chapter_id, video.chapter_id),
        req.body.class_level === undefined ? video.class_level : toInt(req.body.class_level, null),
        status,
        published,
        status === 'approved' ? req.user.id : video.approved_by,
        video.id,
      ],
    );
    if (status === 'approved' && published && video.status !== 'approved') {
      notify({
        classLevel: video.class_level,
        title: 'New video lesson',
        body: video.title,
        kind: 'video',
        link: `/videos/${video.id}`,
      });
    }
    audit(req.user, `video.${status}`, video.title);
    res.json({ video: get('SELECT * FROM videos WHERE id = ?', [video.id]) });
  }),
);

router.delete(
  '/admin/videos/:id',
  requireAdminMode,
  asyncHandler(async (req, res) => {
    const video = get('SELECT * FROM videos WHERE id = ?', [toInt(req.params.id)]);
    if (!video) throw new HttpError(404, 'Video not found.');
    run('DELETE FROM videos WHERE id = ?', [video.id]);
    audit(req.user, 'video.deleted', video.title);
    res.json({ ok: true });
  }),
);

export default router;

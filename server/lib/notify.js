import { all, get, run } from '../db.js';

export function notify({ userId = null, classLevel = null, title, body = '', kind = 'info', link = null }) {
  run(
    'INSERT INTO notifications (user_id, class_level, title, body, kind, link) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, classLevel, title, body, kind, link],
  );
}

export function audit(actor, action, target = null, meta = '') {
  run('INSERT INTO audit_logs (actor_id, actor_role, action, target, meta) VALUES (?, ?, ?, ?, ?)', [
    actor?.id ?? null,
    actor?.role ?? 'system',
    action,
    target,
    typeof meta === 'string' ? meta : JSON.stringify(meta),
  ]);
}

export function award(userId, code, title, description = '') {
  const existing = get('SELECT id FROM achievements WHERE user_id = ? AND code = ?', [userId, code]);
  if (existing) return false;
  run('INSERT INTO achievements (user_id, code, title, description) VALUES (?, ?, ?, ?)', [
    userId,
    code,
    title,
    description,
  ]);
  notify({ userId, title: `Achievement unlocked: ${title}`, body: description, kind: 'achievement', link: '/achievements' });
  return true;
}

export function notificationsFor(user) {
  return all(
    `SELECT * FROM notifications
     WHERE (user_id = ? OR (user_id IS NULL AND class_level = ?))
     ORDER BY read ASC, created_at DESC, id DESC
     LIMIT 60`,
    [user.id, user.class_level ?? -1],
  );
}

export function unreadCount(user) {
  const row = get(
    `SELECT COUNT(*) AS c FROM notifications
     WHERE read = 0 AND (user_id = ? OR (user_id IS NULL AND class_level = ?))`,
    [user.id, user.class_level ?? -1],
  );
  return row?.c ?? 0;
}

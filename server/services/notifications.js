import db from '../db/connection.js';
import { v4 as uuid } from 'uuid';

// SSE clients
const sseClients = new Set();

export function addSSEClient(res) {
  sseClients.add(res);
  res.on('close', () => sseClients.delete(res));
}

function broadcast(notification) {
  const data = JSON.stringify(notification);
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

export function notify(type, title, message = '', data = {}, actionUrl = '') {
  const id = uuid();
  db.prepare(`
    INSERT INTO notifications (id, type, title, message, data, action_url)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, type, title, message, JSON.stringify(data), actionUrl);

  const notification = { id, type, title, message, data, action_url: actionUrl, read: 0, created_at: new Date().toISOString() };
  broadcast(notification);
  return notification;
}

export function getNotifications(limit = 50, unreadOnly = false) {
  let sql = 'SELECT * FROM notifications';
  if (unreadOnly) sql += ' WHERE read = 0';
  sql += ' ORDER BY created_at DESC LIMIT ?';
  return db.prepare(sql).all(limit).map(n => ({ ...n, data: JSON.parse(n.data || '{}') }));
}

export function markRead(id) {
  db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(id);
}

export function markAllRead() {
  db.prepare('UPDATE notifications SET read = 1 WHERE read = 0').run();
}

export function getUnreadCount() {
  return db.prepare('SELECT COUNT(*) as c FROM notifications WHERE read = 0').get().c;
}

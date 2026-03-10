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

// ─── Email via Resend (free 100/day) ───
async function sendEmail(title, message) {
  const apiKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.NOTIFY_EMAIL;
  if (!apiKey || !toEmail) return;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        from: 'Agency Command <notifications@resend.dev>',
        to: [toEmail],
        subject: title,
        html: `<div style="font-family:sans-serif;background:#0A0A0B;color:#E0E0E4;padding:24px;border-radius:8px;">
          <h2 style="color:#C8FF32;margin:0 0 12px;">${title}</h2>
          <p style="color:#8B8B93;line-height:1.6;">${message}</p>
          <hr style="border:1px solid #1E1E22;margin:16px 0;">
          <p style="font-size:12px;color:#555;">Agency Command — SnipeLink LLC</p>
        </div>`,
      }),
    });
    console.log(`[NOTIFY] Email sent: ${title}`);
  } catch (e) {
    console.error('[NOTIFY] Email failed:', e.message);
  }
}

// ─── Telegram Bot ───
async function sendTelegram(title, message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;

  try {
    const text = `*${title}*\n\n${message}`;
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
    console.log(`[NOTIFY] Telegram sent: ${title}`);
  } catch (e) {
    console.error('[NOTIFY] Telegram failed:', e.message);
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

  // Push to external channels (fire and forget)
  sendEmail(title, message);
  sendTelegram(title, message);

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

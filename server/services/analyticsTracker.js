import db from '../db/connection.js';
import { randomUUID } from 'crypto';

// ─── Schema ──────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS pnl_tracker (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    amount_usd REAL NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Track API spend ─────────────────────────────────────
export function trackSpend(service, amount, description = '') {
  try {
    db.prepare(`INSERT INTO pnl_tracker (id, type, source, amount_usd, description) VALUES (?, 'spend', ?, ?, ?)`)
      .run(randomUUID(), service, amount, description);
  } catch (e) { console.error('[PNL] trackSpend error:', e.message); }
}

// ─── Track revenue events ────────────────────────────────
export function trackRevenue(source, amount, description = '') {
  try {
    db.prepare(`INSERT INTO pnl_tracker (id, type, source, amount_usd, description) VALUES (?, 'revenue', ?, ?, ?)`)
      .run(randomUUID(), source, amount, description);
  } catch (e) { console.error('[PNL] trackRevenue error:', e.message); }
}

// ─── Daily P&L summary ──────────────────────────────────
export function getDailyPnL() {
  const today = db.prepare(`
    SELECT type, source, SUM(amount_usd) as total, COUNT(*) as count
    FROM pnl_tracker
    WHERE created_at > datetime('now', '-1 day')
    GROUP BY type, source
  `).all();

  const totalSpend = db.prepare(`
    SELECT COALESCE(SUM(amount_usd), 0) as total FROM pnl_tracker
    WHERE type = 'spend' AND created_at > datetime('now', '-1 day')
  `).get().total;

  const totalRevenue = db.prepare(`
    SELECT COALESCE(SUM(amount_usd), 0) as total FROM pnl_tracker
    WHERE type = 'revenue' AND created_at > datetime('now', '-1 day')
  `).get().total;

  return {
    period: 'daily',
    breakdown: today,
    totalSpend,
    totalRevenue,
    netPnL: totalRevenue - totalSpend,
  };
}

// ─── Weekly report ───────────────────────────────────────
export function getWeeklyReport() {
  const week = db.prepare(`
    SELECT type, source, SUM(amount_usd) as total, COUNT(*) as count
    FROM pnl_tracker
    WHERE created_at > datetime('now', '-7 days')
    GROUP BY type, source
  `).all();

  const totalSpend = db.prepare(`
    SELECT COALESCE(SUM(amount_usd), 0) as total FROM pnl_tracker
    WHERE type = 'spend' AND created_at > datetime('now', '-7 days')
  `).get().total;

  const totalRevenue = db.prepare(`
    SELECT COALESCE(SUM(amount_usd), 0) as total FROM pnl_tracker
    WHERE type = 'revenue' AND created_at > datetime('now', '-7 days')
  `).get().total;

  const dailyTrend = db.prepare(`
    SELECT date(created_at) as day, type, SUM(amount_usd) as total
    FROM pnl_tracker
    WHERE created_at > datetime('now', '-7 days')
    GROUP BY day, type
    ORDER BY day
  `).all();

  return {
    period: 'weekly',
    breakdown: week,
    totalSpend,
    totalRevenue,
    netPnL: totalRevenue - totalSpend,
    dailyTrend,
  };
}

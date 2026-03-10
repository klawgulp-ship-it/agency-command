import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import jobsRouter from './routes/jobs.js';
import clientsRouter from './routes/clients.js';
import invoicesRouter from './routes/invoices.js';
import feedsRouter from './routes/feeds.js';
import proposalsRouter from './routes/proposals.js';
import settingsRouter from './routes/settings.js';
import statsRouter from './routes/stats.js';
import { scrapeAllFeeds } from './services/feedScraper.js';
import { getOverdueInvoices, markReminderSent } from './services/payments.js';

// Run seed on first boot if DB is empty
import db from './db/connection.js';
const feedCount = db.prepare('SELECT COUNT(*) as c FROM feeds').get().c;
if (feedCount === 0) {
  console.log('Empty DB detected, running seed...');
  await import('./db/seed.js');
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── API Routes ──────────────────────────────────────────
app.use('/api/jobs', jobsRouter);
app.use('/api/clients', clientsRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/feeds', feedsRouter);
app.use('/api/proposals', proposalsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/stats', statsRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// ─── Serve frontend in production ────────────────────────
const distPath = join(__dirname, '../dist');
if (existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(join(distPath, 'index.html'));
    }
  });
}

// ─── Auto-scrape on boot ────────────────────────────────
(async () => {
  try {
    console.log('[BOOT] Auto-scraping all feeds...');
    const results = await scrapeAllFeeds();
    const total = results.reduce((s, r) => s + r.imported, 0);
    console.log(`[BOOT] Imported ${total} jobs from ${results.length} feeds`);
  } catch (e) { console.error('[BOOT] Feed scrape failed:', e.message); }
})();

// ─── Cron: Scrape feeds every 30 minutes ────────────────
cron.schedule('*/30 * * * *', async () => {
  console.log('[CRON] Scraping all feeds...');
  const results = await scrapeAllFeeds();
  console.log('[CRON] Feed scrape complete:', results);
});

// ─── Cron: Check overdue invoices daily at 9am ──────────
cron.schedule('0 9 * * *', () => {
  console.log('[CRON] Checking overdue invoices...');
  const overdue = getOverdueInvoices(7);
  for (const inv of overdue) {
    console.log(`[REMINDER] Invoice ${inv.id} for ${inv.client_name} — $${inv.amount} overdue`);
    // TODO: Wire up email/Telegram notification here
    markReminderSent(inv.id);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚡ Agency Command API running on port ${PORT}`);
});

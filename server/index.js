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
import agentRouter from './routes/agent.js';
import notificationsRouter from './routes/notifications.js';
import inboundRouter from './routes/inbound.js';
import webhooksRouter from './routes/webhooks.js';
import referralsRouter from './routes/referrals.js';
import portalRouter from './routes/portal.js';
import bountiesRouter from './routes/bounties.js';
import githubWebhookRouter from './routes/githubWebhook.js';
import { scrapeAllFeeds } from './services/feedScraper.js';
import { runAutoSolver, runBlitzSolver, checkSubmittedBounties, syncSubmittedBounties } from './services/bountySolver.js';
import { scrapeAllBounties } from './services/bountyScraper.js';
import { checkPRReviews } from './services/prResponder.js';
import { runAutoAgent } from './services/autoAgent.js';
import { runAutoBidder } from './services/freelanceBidder.js';
import { runSecurityScanner } from './services/securityScanner.js';
import { runMarketingAgent } from './services/marketingAgent.js';
import { runSocialAgent } from './services/socialAgent.js';
import { runGiveawayAgent } from './services/giveawayAgent.js';
import { runYouTubeAgent, getYouTubeOAuthUrl, exchangeYouTubeCode } from './services/youtubeAgent.js';
import { getOverdueInvoices, markReminderSent } from './services/payments.js';
import { setupToolRoutes } from './services/microSaasEngine.js';

// Run seed on first boot if DB is empty
import db from './db/connection.js';
// Clean dead feeds (Upwork RSS is gone, WeWorkRemotely requires payment)
db.prepare("DELETE FROM feeds WHERE url LIKE '%upwork.com%' OR url LIKE '%weworkremotely.com%'").run();

// One-time purge done — jobs now re-scraped with new scoring

const feedCount = db.prepare('SELECT COUNT(*) as c FROM feeds').get().c;
if (feedCount === 0) {
  console.log('No active feeds, running seed...');
  await import('./db/seed.js');
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());

// GitHub webhook needs raw body for HMAC signature verification — mount BEFORE json parser
app.use('/api/github/webhook', express.json({
  limit: '1mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use('/api/github/webhook', githubWebhookRouter);

app.use(express.json({ limit: '10mb' }));

// Google Search Console verification
app.get('/googlea433ffa9a9b091dc.html', (_req, res) => {
  res.type('html').send('google-site-verification: googlea433ffa9a9b091dc.html');
});

// ─── Paid Tool Endpoints (instant revenue) ───────────────
setupToolRoutes(app);

// ─── API Routes ──────────────────────────────────────────
app.use('/api/jobs', jobsRouter);
app.use('/api/clients', clientsRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/feeds', feedsRouter);
app.use('/api/proposals', proposalsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/stats', statsRouter);
app.use('/api/agent', agentRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/inbound', inboundRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/referrals', referralsRouter);
app.use('/api/portal', portalRouter);
app.use('/api/bounties', bountiesRouter);

// ─── YouTube OAuth Setup ─────────────────────────────────
app.get('/api/youtube/auth', async (req, res) => {
  try {
    const url = await getYouTubeOAuthUrl();
    res.json({ authUrl: url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/oauth2callback', async (req, res) => {
  try {
    const tokens = await exchangeYouTubeCode(req.query.code);
    res.json({
      message: 'YouTube authenticated! Set this on Railway:',
      refresh_token: tokens.refresh_token,
      command: `railway variables --set "YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}"`,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

// ─── Auto-agent on boot — scrape + generate proposals ───
(async () => {
  try {
    console.log('[BOOT] Running auto-agent...');
    const result = await runAutoAgent();
    result.log.forEach(l => console.log(l));

    console.log('[BOOT] Syncing submitted bounties from GitHub PRs...');
    const synced = await syncSubmittedBounties();
    if (synced > 0) console.log(`[BOOT] Restored ${synced} submitted bounties from open PRs`);

    console.log('[BOOT] Checking PR reviews for pending feedback...');
    try {
      const prResult = await checkPRReviews();
      if (prResult.responded > 0) console.log(`[BOOT] Responded to ${prResult.responded} PR reviews`);
    } catch (e) { console.error('[BOOT] PR review check failed:', e.message); }

    // Marketing deferred to cron — save API credits on boot
  } catch (e) { console.error('[BOOT] Auto-agent failed:', e.message); }
})();

// ═══ SURVIVAL MODE CRONS — conserve every API call ═══════

// ─── Cron: Auto-agent every 2 hours (was 30 min) ─────────
// ─── Staggered cron schedules — spread GitHub API calls across the hour ──
//  :05 — Bounty solver (highest revenue, uses cached repo data)
//  :10 — PR review responder (earns money by addressing reviewer feedback)
//  :20 — Scrape bounties every 2h (sequential sources, 2s delay between each)
//  :30 — Auto-agent (job scraping + proposals)
//  :35 — PR status check every 2h
//  :40 — Freelance bidder every 4h
//  :45 — PR review responder (2nd run)
//  :50 — Marketing (drives traffic)
//  :55 — Security scanner every 6h

cron.schedule('5,35 * * * *', async () => {
  console.log('[CRON] Running bounty solver (verified repos only)...');
  try {
    const result = await runAutoSolver();
    console.log(`[CRON] Solver done: ${result.solved}/${result.total} solved`);
  } catch (e) { console.error('[CRON] Solver failed:', e.message); }
});

cron.schedule('10,45 * * * *', async () => {
  console.log('[CRON] Checking PR reviews...');
  try {
    const result = await checkPRReviews();
    if (result.responded > 0) console.log(`[CRON] PR responder: ${result.responded} reviews addressed`);
  } catch (e) { console.error('[CRON] PR responder failed:', e.message); }
});

cron.schedule('20 */2 * * *', async () => {
  console.log('[CRON] Scraping bounties (sequential)...');
  try {
    const result = await scrapeAllBounties();
    console.log(`[CRON] Bounties: ${result.totalImported} new`);
  } catch (e) { console.error('[CRON] Bounty scrape failed:', e.message); }
});

cron.schedule('30 */2 * * *', async () => {
  console.log('[CRON] Running auto-agent...');
  try {
    const result = await runAutoAgent();
    console.log(`[CRON] Agent done: ${result.jobsScraped} scraped, ${result.proposalsGenerated} proposals`);
  } catch (e) { console.error('[CRON] Auto-agent failed:', e.message); }
});

cron.schedule('35 */2 * * *', async () => {
  console.log('[CRON] Checking submitted bounty PRs...');
  try { await checkSubmittedBounties(); } catch (e) { console.error('[CRON] PR check failed:', e.message); }
});

cron.schedule('40 */4 * * *', async () => {
  console.log('[CRON] Running freelance auto-bidder...');
  try {
    const result = await runAutoBidder();
    if (result.bids_submitted > 0) console.log(`[CRON] Bidder: ${result.bids_submitted} bids submitted`);
  } catch (e) { console.error('[CRON] Bidder failed:', e.message); }
});

cron.schedule('50 * * * *', async () => {
  console.log('[CRON] Running marketing agent...');
  try {
    const result = await runMarketingAgent();
    const actions = (result.issues?.length || 0) + (result.discussions?.length || 0) +
      (result.stars?.starred || 0) + (result.trending?.actions || 0) +
      (result.devto?.published || 0) + (result.reddit?.actions || 0);
    console.log(`[CRON] Marketing: ${actions} actions`);
  } catch (e) { console.error('[CRON] Marketing failed:', e.message); }
});

cron.schedule('55 */6 * * *', async () => {
  console.log('[CRON] Running security scanner...');
  try {
    const result = await runSecurityScanner();
    if (result.findings > 0) console.log(`[CRON] Security: ${result.findings} findings, ${result.reported} reported`);
  } catch (e) { console.error('[CRON] Security scanner failed:', e.message); }
});

// ─── Cron: Social agent every 90 min ─────────────────────
cron.schedule('15,45 */1 * * *', async () => {
  console.log('[CRON] Running social agent...');
  try {
    const result = await runSocialAgent();
    const total = (result.reddit?.comments || 0) + (result.discord?.posts || 0) +
      (result.telegram?.messages || 0) + (result.bluesky?.posts || 0);
    if (total > 0) console.log(`[CRON] Social: ${total} posts across platforms`);
  } catch (e) { console.error('[CRON] Social agent failed:', e.message); }
});

// ─── Cron: YouTube agent every 2 hours ──────────────────
cron.schedule('0 */2 * * *', async () => {
  console.log('[CRON] Running YouTube agent...');
  try {
    const result = await runYouTubeAgent();
    const actions = result.uploaded + result.comments + result.replies;
    if (actions > 0) console.log(`[CRON] YouTube: ${result.uploaded} uploaded, ${result.comments} comments, ${result.replies} replies`);
  } catch (e) { console.error('[CRON] YouTube agent failed:', e.message); }
});

// ─── Cron: Giveaway agent every 3 hours ─────────────────
cron.schedule('30 */3 * * *', async () => {
  console.log('[CRON] Running giveaway agent...');
  try {
    const result = await runGiveawayAgent();
    console.log(`[CRON] Giveaway: ${result.giveaway?.status || 'none'}, ${result.entries} entries, ${result.engaged} engagements`);
  } catch (e) { console.error('[CRON] Giveaway agent failed:', e.message); }
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

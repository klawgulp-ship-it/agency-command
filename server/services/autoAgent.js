import db from '../db/connection.js';
import { generateProposal } from './proposalGenerator.js';
import { scrapeAllFeeds } from './feedScraper.js';

// Auto-agent: scrapes feeds, finds top matches, generates proposals, queues them
export async function runAutoAgent() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const log = [];

  // Step 1: Scrape all feeds for fresh jobs
  log.push('[AGENT] Scraping all feeds...');
  const scrapeResults = await scrapeAllFeeds();
  const totalImported = scrapeResults.reduce((s, r) => s + r.imported, 0);
  log.push(`[AGENT] Imported ${totalImported} new jobs from ${scrapeResults.length} feeds`);

  // Step 2: Find top unprocessed jobs (score >= 70, not dismissed, no proposal yet)
  const topJobs = db.prepare(`
    SELECT j.* FROM jobs j
    LEFT JOIN clients c ON c.job_id = j.id
    WHERE j.dismissed = 0
      AND j.score >= 70
      AND c.id IS NULL
    ORDER BY j.score DESC, j.est_value DESC
    LIMIT 5
  `).all();

  log.push(`[AGENT] Found ${topJobs.length} top unprocessed jobs (score >= 70)`);

  if (!apiKey) {
    log.push('[AGENT] No ANTHROPIC_API_KEY set — skipping proposal generation');
    return { log, proposalsGenerated: 0, jobsScraped: totalImported };
  }

  // Step 3: Auto-generate proposals for top jobs
  let proposalsGenerated = 0;
  for (const job of topJobs) {
    try {
      const parsedJob = { ...job, skills: JSON.parse(job.skills || '[]') };
      log.push(`[AGENT] Generating proposal for: ${job.title} (score: ${job.score})`);

      const result = await generateProposal(parsedJob, apiKey);
      if (result.success && result.proposal) {
        // Auto-add to pipeline as "lead" with proposal ready
        const clientId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO clients (id, name, project, stage, budget, requirements, proposal, job_id, created_at, updated_at)
          VALUES (?, ?, ?, 'lead', ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(
          clientId,
          job.client || 'Unknown',
          job.title,
          job.est_value || 0,
          job.description || '',
          result.proposal,
          job.id
        );
        proposalsGenerated++;
        log.push(`[AGENT] ✓ Proposal ready for: ${job.title}`);
      } else {
        log.push(`[AGENT] ✗ Failed: ${result.error || 'Unknown error'}`);
      }
    } catch (e) {
      log.push(`[AGENT] ✗ Error: ${e.message}`);
    }
  }

  log.push(`[AGENT] Done! ${proposalsGenerated} proposals generated, ${totalImported} jobs scraped`);

  return { log, proposalsGenerated, jobsScraped: totalImported, topJobs: topJobs.length };
}

// Get agent status / stats
export function getAgentStats() {
  const totalJobs = db.prepare('SELECT COUNT(*) as c FROM jobs WHERE dismissed = 0').get().c;
  const highScoreJobs = db.prepare('SELECT COUNT(*) as c FROM jobs WHERE dismissed = 0 AND score >= 70').get().c;
  const totalClients = db.prepare('SELECT COUNT(*) as c FROM clients').get().c;
  const proposalsReady = db.prepare("SELECT COUNT(*) as c FROM clients WHERE proposal IS NOT NULL AND proposal != ''").get().c;
  const activeFeeds = db.prepare('SELECT COUNT(*) as c FROM feeds WHERE active = 1').get().c;

  return { totalJobs, highScoreJobs, totalClients, proposalsReady, activeFeeds };
}

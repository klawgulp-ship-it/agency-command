import db from '../db/connection.js';
import { generateProposal } from './proposalGenerator.js';
import { scrapeAllFeeds } from './feedScraper.js';
import { notify } from './notifications.js';
import { generatePaymentLink } from './payments.js';
import { v4 as uuid } from 'uuid';

// Auto-agent: scrapes feeds, finds top matches, generates proposals, queues them
export async function runAutoAgent() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const log = [];

  // Step 1: Scrape all feeds for fresh jobs
  log.push('[AGENT] Scraping all feeds...');
  const scrapeResults = await scrapeAllFeeds();
  const totalImported = scrapeResults.reduce((s, r) => s + r.imported, 0);
  log.push(`[AGENT] Imported ${totalImported} new jobs from ${scrapeResults.length} feeds`);

  if (totalImported > 0) {
    notify('jobs', `${totalImported} new jobs found`, `Scraped ${scrapeResults.length} feeds`, { count: totalImported });
  }

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

  // Notify for high-value jobs
  for (const job of topJobs) {
    if (job.score >= 85) {
      notify('hot_lead', `🔥 Hot lead: ${job.title}`, `Score: ${job.score} | Est: $${job.est_value}`, { jobId: job.id, score: job.score }, job.url);
    }
  }

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
        const clientId = uuid();
        db.prepare(`
          INSERT INTO clients (id, name, project, stage, budget, requirements, proposal, job_id, created_at, updated_at)
          VALUES (?, ?, ?, 'lead', ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(clientId, job.client || 'Unknown', job.title, job.est_value || 0, job.description || '', result.proposal, job.id);

        proposalsGenerated++;
        log.push(`[AGENT] ✓ Proposal ready for: ${job.title}`);

        notify('proposal_ready', `Proposal ready: ${job.title}`,
          `Budget: $${job.est_value} | Score: ${job.score}. Open Pipeline to review & send.`,
          { clientId, jobId: job.id, score: job.score, value: job.est_value }, job.url);
      } else {
        log.push(`[AGENT] ✗ Failed: ${result.error || 'Unknown error'}`);
      }
    } catch (e) {
      log.push(`[AGENT] ✗ Error: ${e.message}`);
    }
  }

  // Step 4: Auto-advance pipeline + auto-invoice
  autoAdvancePipeline(log);

  log.push(`[AGENT] Done! ${proposalsGenerated} proposals generated, ${totalImported} jobs scraped`);
  return { log, proposalsGenerated, jobsScraped: totalImported, topJobs: topJobs.length };
}

// Auto-advance clients through pipeline stages and generate invoices
function autoAdvancePipeline(log) {
  // Auto-generate deposit invoice for "accepted" clients that don't have one
  const acceptedNoInvoice = db.prepare(`
    SELECT c.* FROM clients c
    LEFT JOIN invoices i ON i.client_id = c.id AND i.type = 'deposit'
    WHERE c.stage = 'accepted' AND i.id IS NULL AND c.budget > 0
  `).all();

  for (const client of acceptedNoInvoice) {
    const depositAmount = Math.round(client.budget * 0.5);
    const invoiceId = uuid();
    const invoice = {
      id: invoiceId,
      client_id: client.id,
      client_name: client.name,
      project: client.project,
      type: 'deposit',
      amount: depositAmount,
      note: 'Auto-generated 50% deposit invoice',
    };
    invoice.payment_link = generatePaymentLink(invoice);

    db.prepare(`
      INSERT INTO invoices (id, client_id, client_name, project, type, amount, note, payment_link)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(invoiceId, invoice.client_id, invoice.client_name, invoice.project, invoice.type, invoice.amount, invoice.note, invoice.payment_link);

    // Move to deposit_paid stage
    db.prepare("UPDATE clients SET stage = 'deposit_paid', updated_at = datetime('now') WHERE id = ?").run(client.id);

    log.push(`[AGENT] ✓ Auto-invoice: $${depositAmount} deposit for ${client.name}`);
    notify('invoice', `Invoice sent: ${client.name}`, `$${depositAmount} deposit invoice auto-generated. Payment link ready.`,
      { clientId: client.id, invoiceId, amount: depositAmount }, invoice.payment_link);
  }

  // Auto-generate final invoice for "delivered" clients
  const deliveredNoFinal = db.prepare(`
    SELECT c.* FROM clients c
    LEFT JOIN invoices i ON i.client_id = c.id AND i.type = 'final'
    WHERE c.stage = 'delivered' AND i.id IS NULL AND c.budget > 0
  `).all();

  for (const client of deliveredNoFinal) {
    const finalAmount = Math.round(client.budget * 0.5);
    const invoiceId = uuid();
    const invoice = {
      id: invoiceId,
      client_id: client.id,
      client_name: client.name,
      project: client.project,
      type: 'final',
      amount: finalAmount,
      note: 'Auto-generated final payment invoice',
    };
    invoice.payment_link = generatePaymentLink(invoice);

    db.prepare(`
      INSERT INTO invoices (id, client_id, client_name, project, type, amount, note, payment_link)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(invoiceId, invoice.client_id, invoice.client_name, invoice.project, invoice.type, invoice.amount, invoice.note, invoice.payment_link);

    log.push(`[AGENT] ✓ Auto-invoice: $${finalAmount} final for ${client.name}`);
    notify('invoice', `Final invoice: ${client.name}`, `$${finalAmount} final payment invoice ready. Send to client.`,
      { clientId: client.id, invoiceId, amount: finalAmount }, invoice.payment_link);
  }

  // Auto-complete clients with both payments received
  const fullyPaid = db.prepare(`
    SELECT c.* FROM clients c
    WHERE c.stage = 'final_payment'
    AND c.deposit > 0 AND c.final_payment > 0
  `).all();

  for (const client of fullyPaid) {
    notify('completed', `Project complete: ${client.name}`, `$${client.deposit + client.final_payment} total collected. 💰`,
      { clientId: client.id, total: client.deposit + client.final_payment });
    log.push(`[AGENT] ✓ Project complete: ${client.name} ($${client.deposit + client.final_payment})`);
  }
}

// Get agent status / stats
export function getAgentStats() {
  const totalJobs = db.prepare('SELECT COUNT(*) as c FROM jobs WHERE dismissed = 0').get().c;
  const highScoreJobs = db.prepare('SELECT COUNT(*) as c FROM jobs WHERE dismissed = 0 AND score >= 70').get().c;
  const totalClients = db.prepare('SELECT COUNT(*) as c FROM clients').get().c;
  const proposalsReady = db.prepare("SELECT COUNT(*) as c FROM clients WHERE proposal IS NOT NULL AND proposal != ''").get().c;
  const activeFeeds = db.prepare('SELECT COUNT(*) as c FROM feeds WHERE active = 1').get().c;
  const totalRevenue = db.prepare("SELECT COALESCE(SUM(amount), 0) as t FROM invoices WHERE status = 'paid'").get().t;
  const pendingRevenue = db.prepare("SELECT COALESCE(SUM(amount), 0) as t FROM invoices WHERE status = 'pending'").get().t;
  const unreadNotifications = db.prepare('SELECT COUNT(*) as c FROM notifications WHERE read = 0').get().c;

  // Action items — things that need your click
  const needsAction = db.prepare(`
    SELECT c.*, j.url as job_url FROM clients c
    LEFT JOIN jobs j ON j.id = c.job_id
    WHERE c.stage = 'lead' AND c.proposal IS NOT NULL AND c.proposal != ''
    ORDER BY c.budget DESC
    LIMIT 10
  `).all();

  return { totalJobs, highScoreJobs, totalClients, proposalsReady, activeFeeds, totalRevenue, pendingRevenue, unreadNotifications, needsAction };
}

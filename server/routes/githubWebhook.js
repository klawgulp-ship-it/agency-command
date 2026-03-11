import { Router } from 'express';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import db from '../db/connection.js';
import { scoreBounty, estimateDifficulty, estimateHours } from '../services/bountyScorer.js';
import { completeBounty } from '../services/bountyScraper.js';
import { runAutoSolver } from '../services/bountySolver.js';
import { notify } from '../services/notifications.js';

// ─── Constants ──────────────────────────────────────────
const GITHUB_USERNAME = 'klawgulp-ship-it';
const WALLET_SOL = 'A9REHRDTD8DAqbiSxdiTeTA41CqdoJ4QFPzo4FCpQrtL';
const WALLET_ETH = '0x46b237D2561a520A5Ef3795911814fd5045Fe01e';
const GITHUB_API = 'https://api.github.com';

const BOUNTY_LABELS = new Set([
  'bounty', '💎 bounty', '💎 Bounty', 'cash bounty', 'paid',
  'bounty-s', 'bounty-m', 'bounty-l', 'bounty-xl',
  'reward', 'cash', 'help wanted',
]);

const SKILL_KEYWORDS = [
  'react', 'typescript', 'javascript', 'node', 'node.js', 'express', 'next.js',
  'vue', 'angular', 'python', 'django', 'rust', 'go', 'golang',
  'postgresql', 'mongodb', 'redis', 'sqlite', 'prisma',
  'aws', 'docker', 'kubernetes',
  'solana', 'web3', 'blockchain', 'ethereum',
  'graphql', 'rest api', 'tailwind', 'css',
  'ai', 'llm', 'openai', 'claude',
  'firebase', 'supabase',
];

// Blocked orgs — burned bridges, never touch again
const BLOCKED_ORGS = ['1712n/', 'CapSoftware/'];

const router = Router();

// ─── Signature Verification ─────────────────────────────
// NOTE: express.json() must be configured with a `verify` callback to capture
// the raw body for HMAC validation, e.g.:
//
//   app.use('/api/github/webhook', express.json({
//     verify: (req, _res, buf) => { req.rawBody = buf; }
//   }));
//
// OR mount express.raw({ type: 'application/json' }) specifically on this route
// and parse JSON manually. Without the raw body, signature verification will fail.

function verifyGitHubSignature(payload, signature, secret) {
  if (!secret || !signature) return false;
  try {
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ─── Helpers ────────────────────────────────────────────

function extractRewardFromLabels(labels) {
  for (const label of labels) {
    const name = (label.name || label || '').toString();
    const match = name.match(/\$[\d,]+/);
    if (match) return parseInt(match[0].replace(/[$,]/g, ''));
  }
  return 0;
}

function extractRewardFromText(text) {
  const patterns = [
    /(?:bounty|reward|prize|pays?|offering)\s*:?\s*\$?([\d,]+)/i,
    /\$([\d,]+)\s*(?:bounty|reward|prize)/i,
    /\$([\d,]+)/,
  ];
  for (const pat of patterns) {
    const match = (text || '').match(pat);
    if (match) {
      const val = parseInt(match[1].replace(/,/g, ''));
      if (val >= 10 && val <= 50000) return val;
    }
  }
  return 0;
}

function extractSkills(text) {
  const lower = (text || '').toLowerCase();
  const found = new Set();
  for (const k of SKILL_KEYWORDS) {
    if (lower.includes(k)) found.add(k);
  }
  return [...found].slice(0, 10);
}

function hasBountyLabel(labels) {
  return (labels || []).some(l => {
    const name = (l.name || l || '').toString().toLowerCase();
    return BOUNTY_LABELS.has(name) || name.includes('bounty') || name.includes('reward') || /\$\d+/.test(name);
  });
}

function isBlockedRepo(repo) {
  return BLOCKED_ORGS.some(b => repo.startsWith(b));
}

function isOurPR(pr) {
  return pr?.user?.login === GITHUB_USERNAME;
}

function getBountyByIssueUrl(issueUrl) {
  return db.prepare('SELECT * FROM bounties WHERE issue_url = ?').get(issueUrl);
}

function getBountyByPrUrl(prUrl) {
  return db.prepare('SELECT * FROM bounties WHERE pr_url = ?').get(prUrl);
}

const insertBounty = db.prepare(`
  INSERT OR IGNORE INTO bounties (id, title, source, platform, repo, repo_url, issue_url, reward, currency, labels, skills, description, difficulty, roi_score, est_hours, status, external_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
`);

// ─── POST /api/github/webhook ───────────────────────────

router.post('/', async (req, res) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const signature = req.headers['x-hub-signature-256'];
  const event = req.headers['x-github-event'];

  // Verify signature if secret is configured
  if (secret) {
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
    if (!verifyGitHubSignature(rawBody, signature, secret)) {
      console.warn('[WEBHOOK] Invalid GitHub signature — rejecting');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const payload = req.body;
  if (!payload || !event) {
    return res.status(400).json({ error: 'Missing event or payload' });
  }

  // Respond immediately — process async so GitHub doesn't timeout
  res.status(200).json({ received: true, event });

  try {
    switch (event) {
      case 'issues':
        await handleIssueEvent(payload);
        break;
      case 'pull_request_review':
        await handlePRReviewEvent(payload);
        break;
      case 'pull_request':
        await handlePREvent(payload);
        break;
      default:
        // Ignore unsupported events (ping, push, etc.)
        break;
    }
  } catch (err) {
    console.error(`[WEBHOOK] Error handling ${event}:`, err.message);
  }
});

// ─── Event Handlers ─────────────────────────────────────

async function handleIssueEvent(payload) {
  const { action, issue } = payload;
  if (!issue) return;

  // Only react to new issues or label additions
  if (action !== 'opened' && action !== 'labeled') return;

  const labels = (issue.labels || []).map(l => l.name || l);
  const body = (issue.body || '').slice(0, 3000);
  const fullText = `${issue.title} ${body} ${labels.join(' ')}`;
  const issueUrl = issue.html_url;

  // Check if this looks like a bounty
  const isBountyLabeled = hasBountyLabel(issue.labels || []);
  const hasDollarAmount = /\$\d+/.test(fullText);

  if (!isBountyLabeled && !hasDollarAmount) return;

  // Extract reward
  let reward = extractRewardFromLabels(issue.labels || []);
  if (!reward) reward = extractRewardFromText(body);
  if (!reward) {
    console.log(`[WEBHOOK] Issue looks bounty-like but no reward found: ${issueUrl}`);
    return;
  }

  // Skip token-only bounties
  if (/\b(RTC|FL0X|POINTS|XP|TOKEN)\b/i.test(issue.title) && !body.includes('$')) return;

  // Extract repo info
  const repoFullName = payload.repository?.full_name || '';
  const repoUrl = `https://github.com/${repoFullName}`;

  // Skip blocked orgs
  if (isBlockedRepo(repoFullName)) {
    console.log(`[WEBHOOK] Blocked repo, ignoring: ${repoFullName}`);
    return;
  }

  // Check for duplicate
  const existing = getBountyByIssueUrl(issueUrl);
  if (existing) {
    console.log(`[WEBHOOK] Bounty already tracked: ${issueUrl}`);
    return;
  }

  // Build and insert bounty
  const skills = extractSkills(fullText);
  const difficulty = estimateDifficulty(issue.title, body, labels);
  const estHours = estimateHours(difficulty);

  const bounty = {
    id: uuid(),
    title: issue.title,
    source: 'GitHub',
    platform: 'github',
    repo: repoFullName,
    repo_url: repoUrl,
    issue_url: issueUrl,
    reward,
    currency: 'USD',
    labels: JSON.stringify(labels),
    skills: JSON.stringify(skills),
    description: body.slice(0, 2000),
    difficulty,
    est_hours: estHours,
    external_id: `gh-${issue.id}`,
  };

  bounty.roi_score = scoreBounty(bounty);

  insertBounty.run(
    bounty.id, bounty.title, bounty.source, bounty.platform,
    bounty.repo, bounty.repo_url, bounty.issue_url, bounty.reward,
    bounty.currency, bounty.labels, bounty.skills, bounty.description,
    bounty.difficulty, bounty.roi_score, bounty.est_hours, bounty.external_id
  );

  console.log(`[WEBHOOK] Imported bounty via webhook: $${reward} — ${issue.title}`);

  await notify(
    'webhook_bounty',
    `New $${reward} bounty detected via webhook`,
    `${issue.title}\n${issueUrl}\nDifficulty: ${difficulty} | Est: ${estHours}h | ROI: ${bounty.roi_score}`,
    { bountyId: bounty.id }
  );

  // Trigger immediate solve attempt — first-mover advantage
  try {
    console.log(`[WEBHOOK] Triggering immediate solve for: ${bounty.id}`);
    await runAutoSolver();
  } catch (err) {
    console.error(`[WEBHOOK] Auto-solver failed for ${bounty.id}:`, err.message);
  }
}

async function handlePRReviewEvent(payload) {
  const { review, pull_request: pr } = payload;
  if (!review || !pr) return;
  if (!isOurPR(pr)) return;

  const prUrl = pr.html_url;
  const reviewer = review.user?.login || 'unknown';
  const state = review.state; // approved, changes_requested, commented

  if (state === 'approved') {
    console.log(`[WEBHOOK] PR approved by ${reviewer}: ${prUrl}`);
    await notify(
      'pr_approved',
      `PR approved by ${reviewer}`,
      `${pr.title}\n${prUrl}`,
      { prUrl }
    );
    return;
  }

  if (state === 'changes_requested' || state === 'commented') {
    console.log(`[WEBHOOK] PR review (${state}) from ${reviewer}: ${prUrl}`);

    // Queue the review for the PR responder
    const reviewBody = (review.body || '').slice(0, 4000);
    try {
      db.prepare(`
        INSERT INTO pr_reviews (id, pr_url, reviewer, state, body, created_at, handled)
        VALUES (?, ?, ?, ?, ?, datetime('now'), 0)
      `).run(uuid(), prUrl, reviewer, state, reviewBody);
    } catch (err) {
      // Table might not exist yet — log and continue
      console.warn(`[WEBHOOK] Could not queue PR review (table missing?):`, err.message);
    }

    await notify(
      'pr_review',
      `${state === 'changes_requested' ? 'Changes requested' : 'New comment'} on PR by ${reviewer}`,
      `${pr.title}\n${prUrl}\n\n${reviewBody.slice(0, 500)}`,
      { prUrl, reviewer, state }
    );
  }
}

async function handlePREvent(payload) {
  const { action, pull_request: pr } = payload;
  if (!pr) return;

  // Only handle merged PRs that are ours
  if (action !== 'closed' || !pr.merged || !isOurPR(pr)) return;

  const prUrl = pr.html_url;
  const repoFullName = payload.repository?.full_name || '';
  console.log(`[WEBHOOK] Our PR merged: ${prUrl}`);

  // Find the bounty linked to this PR
  let bounty = getBountyByPrUrl(prUrl);

  // If not found by PR URL, try to find by issue URL from the PR body
  if (!bounty && pr.body) {
    const issueMatch = pr.body.match(/(?:closes|fixes|resolves)\s+(?:https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+|#\d+)/gi);
    if (issueMatch) {
      for (const ref of issueMatch) {
        const urlMatch = ref.match(/(https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+)/);
        if (urlMatch) {
          bounty = getBountyByIssueUrl(urlMatch[1]);
          if (bounty) break;
        }
        const numMatch = ref.match(/#(\d+)/);
        if (numMatch) {
          const reconstructed = `https://github.com/${repoFullName}/issues/${numMatch[1]}`;
          bounty = getBountyByIssueUrl(reconstructed);
          if (bounty) break;
        }
      }
    }
  }

  if (bounty) {
    // Mark bounty as completed
    completeBounty(bounty.id);
    console.log(`[WEBHOOK] Bounty marked completed: ${bounty.id} ($${bounty.reward})`);
  }

  // Post payment claim comment on the PR
  await postPaymentClaimComment(pr, repoFullName, bounty);

  await notify(
    'pr_merged',
    `PR merged${bounty ? ` — $${bounty.reward} bounty completed` : ''}`,
    `${pr.title}\n${prUrl}${bounty ? `\nBounty: $${bounty.reward}` : ''}`,
    { prUrl, bountyId: bounty?.id }
  );
}

// ─── Payment Claim Comment ──────────────────────────────

async function postPaymentClaimComment(pr, repoFullName, bounty) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn('[WEBHOOK] No GITHUB_TOKEN — cannot post payment claim comment');
    return;
  }

  const rewardLine = bounty ? `**Bounty: $${bounty.reward}**\n\n` : '';

  const comment = [
    `Thanks for merging! 🎉\n`,
    rewardLine,
    `**Payment details:**\n`,
    `- **Solana (USDC/SOL):** \`${WALLET_SOL}\``,
    `- **Ethereum (USDC/ETH):** \`${WALLET_ETH}\``,
    `- **PayPal:** Available via [SnipeLink](https://snipelink.com/@agencycommand)\n`,
    `Let me know if you need any follow-up on this PR.`,
  ].join('\n');

  try {
    const res = await fetch(`${GITHUB_API}/repos/${repoFullName}/issues/${pr.number}/comments`, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `token ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: comment }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.error(`[WEBHOOK] Failed to post payment comment: ${res.status}`);
    } else {
      console.log(`[WEBHOOK] Payment claim comment posted on PR #${pr.number}`);
    }
  } catch (err) {
    console.error(`[WEBHOOK] Error posting payment comment:`, err.message);
  }
}

export default router;

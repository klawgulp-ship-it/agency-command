import db from '../db/connection.js';
import { notify } from './notifications.js';
import { v4 as uuid } from 'uuid';

// ─── Constants ──────────────────────────────────────────
const PORTFOLIO_URL = 'https://klawgulp-ship-it.github.io';
const SNIPELINK_URL = 'https://snipelink.com';
const GITHUB_USERNAME = 'klawgulp-ship-it';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_BIDS_PER_CYCLE = 5;
const MIN_BUDGET = 200;

const TARGET_SKILLS = [
  'react', 'typescript', 'node.js', 'nodejs', 'next.js', 'nextjs',
  'express', 'web3', 'solana', 'python', 'ai', 'full-stack',
  'fullstack', 'full stack', 'javascript', 'tailwind', 'api',
];

// ─── Schema ─────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS gigs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    url TEXT UNIQUE NOT NULL,
    budget INTEGER DEFAULT 0,
    currency TEXT DEFAULT 'USD',
    skills TEXT DEFAULT '[]',
    description TEXT DEFAULT '',
    score INTEGER DEFAULT 0,
    proposal TEXT DEFAULT '',
    status TEXT DEFAULT 'discovered',
    bid_submitted INTEGER DEFAULT 0,
    response TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Source: Freelancer.com ─────────────────────────────
async function scrapeFreelancer() {
  const gigs = [];
  const queries = ['react+typescript', 'node.js+api', 'next.js', 'web3+solana', 'python+ai', 'full+stack+javascript'];

  for (const query of queries) {
    try {
      const url = `https://www.freelancer.com/api/projects/0.1/projects/active/?compact=true&job_details=true&limit=20&query=${query}&min_budget=${MIN_BUDGET}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'AgencyCommand/1.0' },
      });

      if (!res.ok) {
        console.warn(`[BIDDER] Freelancer query "${query}" returned ${res.status}`);
        continue;
      }

      const data = await res.json();
      const projects = data?.result?.projects || [];

      for (const p of projects) {
        const budget = p.budget?.maximum || p.budget?.minimum || 0;
        if (budget < MIN_BUDGET) continue;

        const skills = (p.jobs || []).map(j => j.name?.toLowerCase()).filter(Boolean);
        gigs.push({
          id: `freelancer-${p.id}`,
          title: p.title || 'Untitled',
          source: 'freelancer',
          url: `https://www.freelancer.com/projects/${p.seo_url || p.id}`,
          budget: Math.round(budget),
          currency: p.currency?.code || 'USD',
          skills,
          description: (p.preview_description || p.description || '').slice(0, 2000),
        });
      }
    } catch (err) {
      console.error(`[BIDDER] Freelancer scrape error (${query}):`, err.message);
    }
  }

  return gigs;
}

// ─── Source: GitHub "hiring" issues ─────────────────────
async function scrapeGitHubHiring() {
  const gigs = [];
  const queries = ['hiring+react', 'contractor+typescript', 'freelance+node.js', 'bounty+web3'];

  for (const query of queries) {
    try {
      const url = `https://api.github.com/search/issues?q=${query}+label:hiring,contractor,freelance+state:open&sort=created&order=desc&per_page=20`;
      const headers = { 'User-Agent': 'AgencyCommand/1.0', Accept: 'application/vnd.github.v3+json' };
      if (process.env.GITHUB_TOKEN) headers.Authorization = `token ${process.env.GITHUB_TOKEN}`;

      const res = await fetch(url, { headers });
      if (!res.ok) {
        console.warn(`[BIDDER] GitHub search "${query}" returned ${res.status}`);
        continue;
      }

      const data = await res.json();
      const items = data?.items || [];

      for (const issue of items) {
        const body = (issue.body || '').toLowerCase();
        const title = (issue.title || '').toLowerCase();

        // Extract budget from text — look for dollar amounts
        const budgetMatch = (issue.body || '').match(/\$\s?([\d,]+)/);
        const budget = budgetMatch ? parseInt(budgetMatch[1].replace(/,/g, ''), 10) : 0;

        // Check skill relevance
        const combined = `${title} ${body}`;
        const matchedSkills = TARGET_SKILLS.filter(s => combined.includes(s));
        if (matchedSkills.length === 0) continue;

        gigs.push({
          id: `github-${issue.id}`,
          title: issue.title || 'Untitled',
          source: 'github',
          url: issue.html_url,
          budget,
          currency: 'USD',
          skills: matchedSkills,
          description: (issue.body || '').slice(0, 2000),
        });
      }
    } catch (err) {
      console.error(`[BIDDER] GitHub scrape error (${query}):`, err.message);
    }
  }

  return gigs;
}

// ─── Source: Reddit freelance boards ────────────────────
async function scrapeReddit() {
  const gigs = [];
  const subreddits = ['forhire', 'freelance_forhire'];

  for (const sub of subreddits) {
    try {
      const url = `https://old.reddit.com/r/${sub}/.json?limit=50`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'AgencyCommand/1.0 (bot)' },
      });

      if (!res.ok) {
        console.warn(`[BIDDER] Reddit r/${sub} returned ${res.status}`);
        continue;
      }

      const data = await res.json();
      const posts = data?.data?.children || [];

      for (const { data: post } of posts) {
        if (!post || post.is_self === false) continue;

        const title = (post.title || '').toLowerCase();
        const body = (post.selftext || '').toLowerCase();

        // Only "[Hiring]" posts
        if (!title.includes('[hiring]') && !title.includes('hiring')) continue;

        // Extract budget
        const budgetMatch = (post.selftext || post.title || '').match(/\$\s?([\d,]+)/);
        const budget = budgetMatch ? parseInt(budgetMatch[1].replace(/,/g, ''), 10) : 0;

        // Skill match
        const combined = `${title} ${body}`;
        const matchedSkills = TARGET_SKILLS.filter(s => combined.includes(s));
        if (matchedSkills.length === 0) continue;

        gigs.push({
          id: `reddit-${post.id}`,
          title: post.title || 'Untitled',
          source: 'reddit',
          url: `https://reddit.com${post.permalink}`,
          budget,
          currency: 'USD',
          skills: matchedSkills,
          description: (post.selftext || '').slice(0, 2000),
        });
      }
    } catch (err) {
      console.error(`[BIDDER] Reddit scrape error (${sub}):`, err.message);
    }
  }

  return gigs;
}

// ─── Source: Hacker News "Who is Hiring" ────────────────
async function scrapeHNHiring() {
  const gigs = [];
  try {
    // Find the latest "Ask HN: Who is hiring?" thread
    const searchUrl = 'https://hn.algolia.com/api/v1/search?query=%22who+is+hiring%22&tags=ask_hn&hitsPerPage=1';
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) return gigs;
    const searchData = await searchRes.json();
    const thread = searchData.hits?.[0];
    if (!thread) return gigs;

    // Get comments (job postings)
    const commentsUrl = `https://hn.algolia.com/api/v1/items/${thread.objectID}`;
    const commentsRes = await fetch(commentsUrl);
    if (!commentsRes.ok) return gigs;
    const commentsData = await commentsRes.json();

    for (const child of (commentsData.children || []).slice(0, 50)) {
      const text = (child.text || '').toLowerCase();
      if (!text.includes('remote') && !text.includes('contract') && !text.includes('freelance')) continue;

      const matchedSkills = TARGET_SKILLS.filter(s => text.includes(s));
      if (matchedSkills.length === 0) continue;

      const budgetMatch = (child.text || '').match(/\$\s?([\d,]+)/);
      const budget = budgetMatch ? parseInt(budgetMatch[1].replace(/,/g, ''), 10) : 0;

      gigs.push({
        id: `hn-${child.id}`,
        title: (child.text || '').replace(/<[^>]+>/g, '').slice(0, 120),
        source: 'hackernews',
        url: `https://news.ycombinator.com/item?id=${child.id}`,
        budget,
        currency: 'USD',
        skills: matchedSkills,
        description: (child.text || '').replace(/<[^>]+>/g, '').slice(0, 2000),
      });
    }
  } catch (err) {
    console.error('[BIDDER] HN scrape error:', err.message);
  }
  return gigs;
}

// ─── Scoring ────────────────────────────────────────────
function scoreGig(gig) {
  let score = 0;
  const coreSkills = ['react', 'typescript', 'node.js', 'nodejs', 'next.js', 'nextjs', 'express', 'web3', 'solana'];
  const matchedCore = (gig.skills || []).filter(s => coreSkills.includes(s));

  // Skill match bonus (0-40)
  score += Math.min(matchedCore.length * 10, 40);

  // Budget tier (0-30)
  if (gig.budget >= 3000) score += 30;
  else if (gig.budget >= 1000) score += 20;
  else if (gig.budget >= 500) score += 15;
  else if (gig.budget >= MIN_BUDGET) score += 5;

  // $/hour estimate — assume 1hr per $100 as baseline (0-20)
  const estHours = Math.max(gig.budget / 100, 1);
  const rate = gig.budget / estHours;
  if (rate >= 100) score += 20;
  else if (rate >= 75) score += 15;
  else if (rate >= 50) score += 10;

  // Source bonus (0-10)
  if (gig.source === 'freelancer') score += 10; // structured, can auto-bid
  else if (gig.source === 'hackernews') score += 8; // high quality leads
  else if (gig.source === 'github') score += 7;
  else score += 3;

  return Math.min(score, 100);
}

// ─── Proposal Generation via Claude ─────────────────────
async function generateBidProposal(gig) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[BIDDER] ANTHROPIC_API_KEY not set, skipping proposal generation');
    return null;
  }

  const model = gig.budget >= 500 ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20250414';
  const skills = Array.isArray(gig.skills) ? gig.skills : JSON.parse(gig.skills || '[]');
  const budgetLine = gig.budget > 0 ? `4. Pricing: $${gig.budget} — 50% deposit / 50% on delivery via SnipeLink (${SNIPELINK_URL})` : '4. Pricing: Happy to discuss budget — payments via SnipeLink (' + SNIPELINK_URL + ')';

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `Generate a compelling freelance proposal for this gig. Be concise, professional, and highlight fast delivery with AI-assisted development.

GIG TITLE: ${gig.title}
SOURCE: ${gig.source}
BUDGET: ${gig.budget > 0 ? '$' + gig.budget + ' ' + gig.currency : 'Not specified'}
DESCRIPTION: ${gig.description.slice(0, 1500)}
REQUIRED SKILLS: ${skills.join(', ')}

PROPOSAL FORMAT:
1. Opening hook (2 sentences addressing their specific need)
2. Why I'm the right fit (3-4 bullet points of relevant experience)
3. Proposed approach + timeline (brief and realistic)
${budgetLine}
5. Portfolio: ${PORTFOLIO_URL}
6. Call to action

MY STRENGTHS:
- Senior full-stack developer (TypeScript, React, Node.js, Next.js, Solana/Web3)
- AI-assisted development workflow = 5-10x faster delivery
- Production deployment experience (Railway, Vercel, AWS)
- Payment integration specialist
- Portfolio of shipped products: ${PORTFOLIO_URL}

Keep it under 300 words. Sound human, not templated. No fluff.`,
        }],
      }),
    });

    const data = await res.json();
    if (data.error) {
      console.error('[BIDDER] Claude API error:', data.error.message || JSON.stringify(data.error));
      return null;
    }

    return data.content?.map(c => c.text || '').join('\n').trim() || null;
  } catch (err) {
    console.error('[BIDDER] Proposal generation failed:', err.message);
    return null;
  }
}

// ─── Bid Submission ─────────────────────────────────────
async function submitFreelancerBid(gig, proposal) {
  const apiKey = process.env.FREELANCER_API_KEY;
  if (!apiKey) {
    console.log(`[BIDDER] FREELANCER_API_KEY not set — storing proposal for manual submission`);
    return { submitted: false, reason: 'no_api_key' };
  }

  // Extract numeric project ID from gig ID
  const projectId = gig.id.replace('freelancer-', '');

  try {
    const res = await fetch('https://www.freelancer.com/api/projects/0.1/bids/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'freelancer-oauth-v1': apiKey,
      },
      body: JSON.stringify({
        project_id: parseInt(projectId, 10),
        bidder_id: null, // auto from auth
        amount: gig.budget,
        period: 14, // days
        milestone_percentage: 50,
        description: proposal,
      }),
    });

    const data = await res.json();
    if (data.status === 'success' || res.ok) {
      return { submitted: true };
    }
    console.error('[BIDDER] Freelancer bid API error:', JSON.stringify(data));
    return { submitted: false, reason: data.message || 'api_error' };
  } catch (err) {
    console.error('[BIDDER] Freelancer bid submission failed:', err.message);
    return { submitted: false, reason: err.message };
  }
}

async function submitGitHubComment(gig, proposal) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log('[BIDDER] GITHUB_TOKEN not set — storing proposal for manual submission');
    return { submitted: false, reason: 'no_token' };
  }

  // Extract owner/repo and issue number from URL
  // e.g. https://github.com/owner/repo/issues/123
  const match = gig.url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (!match) {
    return { submitted: false, reason: 'invalid_url' };
  }

  const [, owner, repo, issueNumber] = match;

  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `token ${token}`,
        'User-Agent': 'AgencyCommand/1.0',
      },
      body: JSON.stringify({ body: proposal }),
    });

    if (res.ok) {
      return { submitted: true };
    }
    const data = await res.json();
    console.error('[BIDDER] GitHub comment error:', data.message);
    return { submitted: false, reason: data.message || 'api_error' };
  } catch (err) {
    console.error('[BIDDER] GitHub comment failed:', err.message);
    return { submitted: false, reason: err.message };
  }
}

// ─── Core: Generate and Submit Bid ──────────────────────
async function generateAndSubmitBid(gig) {
  console.log(`[BIDDER] Generating proposal for: ${gig.title} ($${gig.budget})`);

  const proposal = await generateBidProposal(gig);
  if (!proposal) {
    db.prepare('UPDATE gigs SET status = ?, updated_at = datetime(?) WHERE id = ?')
      .run('proposal_failed', new Date().toISOString(), gig.id);
    return { success: false, reason: 'proposal_generation_failed' };
  }

  // Store proposal
  db.prepare('UPDATE gigs SET proposal = ?, status = ?, updated_at = datetime(?) WHERE id = ?')
    .run(proposal, 'proposal_ready', new Date().toISOString(), gig.id);

  // Submit based on source
  let result = { submitted: false, reason: 'unsupported_source' };

  if (gig.source === 'freelancer') {
    result = await submitFreelancerBid(gig, proposal);
  } else if (gig.source === 'github') {
    result = await submitGitHubComment(gig, proposal);
  } else if (gig.source === 'reddit') {
    // Reddit requires OAuth for commenting — store for manual submission
    result = { submitted: false, reason: 'manual_only' };
  }

  const newStatus = result.submitted ? 'bid_sent' : 'proposal_ready';
  db.prepare('UPDATE gigs SET status = ?, bid_submitted = ?, response = ?, updated_at = datetime(?) WHERE id = ?')
    .run(newStatus, result.submitted ? 1 : 0, result.reason || '', new Date().toISOString(), gig.id);

  if (result.submitted) {
    notify('gig', `Bid submitted: ${gig.title}`, `$${gig.budget} on ${gig.source} — proposal auto-submitted`, { gig_id: gig.id }, gig.url);
  }

  return { success: true, submitted: result.submitted, proposal };
}

// ─── Discover Gigs ──────────────────────────────────────
export async function discoverGigs() {
  console.log('[BIDDER] Discovering freelance gigs...');

  const [freelancerGigs, githubGigs, redditGigs, hnGigs] = await Promise.allSettled([
    scrapeFreelancer(),
    scrapeGitHubHiring(),
    scrapeReddit(),
    scrapeHNHiring(),
  ]);

  const allGigs = [
    ...(freelancerGigs.status === 'fulfilled' ? freelancerGigs.value : []),
    ...(githubGigs.status === 'fulfilled' ? githubGigs.value : []),
    ...(redditGigs.status === 'fulfilled' ? redditGigs.value : []),
    ...(hnGigs.status === 'fulfilled' ? hnGigs.value : []),
  ];

  console.log(`[BIDDER] Found ${allGigs.length} raw gigs across all sources`);

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO gigs (id, title, source, url, budget, currency, skills, description, score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let newCount = 0;

  for (const gig of allGigs) {
    const score = scoreGig(gig);
    const result = insertStmt.run(
      gig.id,
      gig.title,
      gig.source,
      gig.url,
      gig.budget,
      gig.currency,
      JSON.stringify(gig.skills),
      gig.description,
      score,
    );
    if (result.changes > 0) newCount++;
  }

  console.log(`[BIDDER] ${newCount} new gigs stored (${allGigs.length - newCount} duplicates skipped)`);

  if (newCount > 0) {
    notify('gig', `${newCount} new freelance gigs discovered`, `Sources: Freelancer, GitHub, Reddit — run auto-bidder to submit proposals`);
  }

  return { total: allGigs.length, new: newCount };
}

// ─── Run Auto-Bidder ────────────────────────────────────
export async function runAutoBidder() {
  console.log('[BIDDER] Starting auto-bidder cycle...');

  // Step 1: Discover new gigs
  const discovery = await discoverGigs();

  // Step 2: Get top-scored gigs that haven't been bid on yet
  // Allow budget=0 for GitHub/Reddit (they rarely list prices) — filter by score instead
  const candidates = db.prepare(`
    SELECT * FROM gigs
    WHERE status = 'discovered'
      AND (budget >= ? OR source IN ('github', 'reddit', 'hackernews'))
      AND score >= 15
    ORDER BY score DESC, budget DESC
    LIMIT ?
  `).all(MIN_BUDGET, MAX_BIDS_PER_CYCLE);

  console.log(`[BIDDER] ${candidates.length} gigs eligible for bidding`);

  const results = { discovered: discovery, bids_attempted: 0, bids_submitted: 0, errors: [] };

  for (const gig of candidates) {
    try {
      const bidResult = await generateAndSubmitBid(gig);
      results.bids_attempted++;
      if (bidResult.submitted) results.bids_submitted++;
    } catch (err) {
      console.error(`[BIDDER] Error bidding on ${gig.id}:`, err.message);
      results.errors.push({ gig_id: gig.id, error: err.message });
      db.prepare('UPDATE gigs SET status = ?, response = ?, updated_at = datetime(?) WHERE id = ?')
        .run('error', err.message, new Date().toISOString(), gig.id);
    }
  }

  console.log(`[BIDDER] Cycle complete: ${results.bids_attempted} attempted, ${results.bids_submitted} submitted`);

  if (results.bids_attempted > 0) {
    notify(
      'gig',
      `Auto-bidder: ${results.bids_submitted}/${results.bids_attempted} bids submitted`,
      `Discovered ${discovery.new} new gigs. ${results.errors.length} errors.`,
      results,
    );
  }

  return results;
}

// ─── Utilities ──────────────────────────────────────────
export function getGigs({ status, source, limit = 50 } = {}) {
  let sql = 'SELECT * FROM gigs WHERE 1=1';
  const params = [];

  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (source) { sql += ' AND source = ?'; params.push(source); }

  sql += ' ORDER BY score DESC, created_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params).map(g => ({
    ...g,
    skills: JSON.parse(g.skills || '[]'),
  }));
}

export function getGigStats() {
  const total = db.prepare('SELECT COUNT(*) as c FROM gigs').get().c;
  const byStatus = db.prepare('SELECT status, COUNT(*) as c FROM gigs GROUP BY status').all();
  const bySource = db.prepare('SELECT source, COUNT(*) as c FROM gigs GROUP BY source').all();
  const totalBudget = db.prepare('SELECT SUM(budget) as total FROM gigs WHERE status IN (?, ?)').get('bid_sent', 'proposal_ready')?.total || 0;

  return { total, byStatus, bySource, totalBudget };
}

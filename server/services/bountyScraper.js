import { v4 as uuid } from 'uuid';
import db from '../db/connection.js';
import { scoreBounty, estimateDifficulty, estimateHours, isQuickSolve } from './bountyScorer.js';

const GITHUB_API = 'https://api.github.com';
const ALGORA_API = 'https://console.algora.io';

// Skills extraction reused from feedScraper logic
const SKILL_KEYWORDS = [
  'react', 'typescript', 'javascript', 'node', 'nodejs', 'node.js', 'express', 'next.js',
  'nextjs', 'vue', 'angular', 'python', 'django', 'rust', 'go', 'golang',
  'postgresql', 'mongodb', 'redis', 'sqlite', 'prisma',
  'aws', 'docker', 'kubernetes',
  'solana', 'web3', 'blockchain', 'ethereum',
  'graphql', 'rest api', 'tailwind', 'css',
  'ai', 'llm', 'openai', 'claude',
  'firebase', 'supabase',
];

function extractSkills(text) {
  const lower = (text || '').toLowerCase();
  const found = new Set();
  for (const k of SKILL_KEYWORDS) {
    if (lower.includes(k)) {
      const normalized = k.replace('nodejs', 'node.js').replace('nextjs', 'next.js');
      found.add(normalized);
    }
  }
  return [...found].slice(0, 10);
}

// Extract bounty amount from labels or text
function extractRewardFromLabels(labels) {
  for (const label of labels) {
    const name = (label.name || label || '').toString();
    // Match patterns: "$500", "bounty $1000", "$1,000", "💎 $250"
    const match = name.match(/\$[\d,]+/);
    if (match) return parseInt(match[0].replace(/[$,]/g, ''));
  }
  return 0;
}

function extractRewardFromText(text) {
  // Match bounty amount patterns in issue body
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

function isDuplicateBounty(issueUrl) {
  return !!db.prepare('SELECT id FROM bounties WHERE issue_url = ?').get(issueUrl);
}

// Blocked orgs — burned bridges
const BLOCKED_ORGS = ['1712n/', 'CapSoftware/'];
function isBlockedOrg(repo) {
  return BLOCKED_ORGS.some(b => repo.startsWith(b));
}

const insertBounty = db.prepare(`
  INSERT OR IGNORE INTO bounties (id, title, source, platform, repo, repo_url, issue_url, reward, currency, labels, skills, description, difficulty, roi_score, est_hours, status, external_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
`);

// ─── GitHub Search API ──────────────────────────────────
// Searches for open issues with bounty labels across GitHub
export async function scrapeGitHubBounties() {
  const token = process.env.GITHUB_TOKEN; // optional, increases rate limit
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'AgencyCommand/1.0',
  };
  if (token) headers['Authorization'] = `token ${token}`;

  // Focused queries — high yield, low API burn
  const queries = [
    'label:bounty state:open sort:created-desc',
    'label:"💎 Bounty" state:open',
    '"$" in:body label:bounty state:open language:typescript',
    '"$" in:body label:bounty state:open language:javascript',
    '"$" in:body label:bounty state:open language:python',
    '"bounty" "$" in:body state:open sort:created-desc',
    'label:bounty label:"good first issue" state:open',
    'label:bounty label:"easy" state:open',
    'label:"cash bounty" OR label:"paid" state:open "bounty"',
    'label:bounty-S OR label:bounty-M state:open',
  ];

  let totalImported = 0;

  for (const q of queries) {
    try {
      const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=30`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });

      if (!res.ok) {
        if (res.status === 403) {
          console.log('[BOUNTY] GitHub rate limited, waiting...');
          break; // Stop hitting GitHub if rate limited
        }
        continue;
      }

      const data = await res.json();
      const items = data.items || [];

      for (const issue of items) {
        const issueUrl = issue.html_url;
        if (isDuplicateBounty(issueUrl)) continue;

        const labels = (issue.labels || []).map(l => l.name || l);
        const repoUrl = issue.repository_url?.replace('https://api.github.com/repos/', 'https://github.com/') || '';
        const repoName = repoUrl.split('github.com/')[1] || '';

        // Skip blocked orgs
        if (isBlockedOrg(repoName)) continue;

        const body = (issue.body || '').slice(0, 3000);
        const fullText = `${issue.title} ${body} ${labels.join(' ')}`;

        let reward = extractRewardFromLabels(issue.labels || []);
        if (!reward) reward = extractRewardFromText(body);
        if (!reward) continue; // Skip bounties with no discernible reward

        // Skip token-only bounties (RTC, FL0X, etc.) — we want USD
        const tokenPattern = /\b(RTC|FL0X|POINTS|XP|TOKEN)\b/i;
        if (tokenPattern.test(issue.title) && !body.includes('$')) continue;

        // Skip bounties explicitly not accepting submissions
        if (body.toLowerCase().includes('not accepting bounties')) continue;

        const skills = extractSkills(fullText);
        const difficulty = estimateDifficulty(issue.title, body, labels);
        const estHours = estimateHours(difficulty);

        const bounty = {
          id: uuid(),
          title: issue.title,
          source: 'GitHub',
          platform: 'github',
          repo: repoName,
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
        totalImported++;
      }

      // Respect GitHub rate limits — small delay between queries
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.error(`[BOUNTY] GitHub search failed for "${q}":`, err.message);
    }
  }

  return { source: 'GitHub', imported: totalImported };
}

// ─── Algora via GitHub ──────────────────────────────────
// Algora bounties are tracked via GitHub issues — search for their labels + known repos
export async function scrapeAlgoraBounties() {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'AgencyCommand/1.0',
  };
  if (token) headers['Authorization'] = `token ${token}`;

  // Known Algora bounty repos + label searches
  const queries = [
    'label:"💎 bounty" state:open',
    'label:"algora" state:open "bounty"',
    '"algora.io" in:body label:bounty state:open',
    'label:"💰 bounty" state:open',
    'label:"bounty 💎" state:open',
    '"algora" "$" in:body state:open',
    // Proven bounty-paying repos (verified merges + payouts)
    'repo:hummingbot/hummingbot label:bounty state:open',
    'repo:zio/zio-blocks "bounty" state:open',
    'repo:zio/zio "bounty" state:open',
    'repo:zio/zio-schema "bounty" state:open',
    'repo:golemcloud/golem "bounty" state:open',
    'repo:archestra-ai/archestra label:bounty state:open',
    'repo:PrimeIntellect-ai/community-environments label:bounty state:open',
    'repo:superplanehq/superplane label:bounty state:open',
    // Broader Algora net
    '"algora.io" "bounty" in:comments state:open "$"',
  ];

  let totalImported = 0;

  for (const q of queries) {
    try {
      const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=30`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;

      const data = await res.json();
      for (const issue of (data.items || [])) {
        const issueUrl = issue.html_url;
        if (isDuplicateBounty(issueUrl)) continue;

        const labels = (issue.labels || []).map(l => l.name || l);
        const repoUrl = issue.repository_url?.replace('https://api.github.com/repos/', 'https://github.com/') || '';
        const repoName = repoUrl.split('github.com/')[1] || '';
        const body = (issue.body || '').slice(0, 3000);
        const fullText = `${issue.title} ${body} ${labels.join(' ')}`;

        let reward = extractRewardFromLabels(issue.labels || []);
        if (!reward) reward = extractRewardFromText(body);
        if (!reward) continue;

        const skills = extractSkills(fullText);
        const difficulty = estimateDifficulty(issue.title, body, labels);
        const estHours = estimateHours(difficulty);

        const bounty = {
          id: uuid(),
          title: issue.title,
          source: 'Algora',
          platform: 'algora',
          repo: repoName,
          repo_url: repoUrl,
          issue_url: issueUrl,
          reward,
          currency: 'USD',
          labels: JSON.stringify(labels),
          skills: JSON.stringify(skills),
          description: body.slice(0, 2000),
          difficulty,
          est_hours: estHours,
          external_id: `algora-gh-${issue.id}`,
        };

        bounty.roi_score = scoreBounty(bounty);

        insertBounty.run(
          bounty.id, bounty.title, bounty.source, bounty.platform,
          bounty.repo, bounty.repo_url, bounty.issue_url, bounty.reward,
          bounty.currency, bounty.labels, bounty.skills, bounty.description,
          bounty.difficulty, bounty.roi_score, bounty.est_hours, bounty.external_id
        );
        totalImported++;
      }

      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.error(`[BOUNTY] Algora-GitHub search failed:`, err.message);
    }
  }

  return { source: 'Algora', imported: totalImported };
}

// ─── IssueHunt Scraper ──────────────────────────────────
// IssueHunt lists funded GitHub issues
export async function scrapeIssueHuntBounties() {
  let totalImported = 0;

  try {
    const res = await fetch('https://issuehunt.io/api/v1/issues?sort=newest&state=open&per_page=50', {
      headers: { 'User-Agent': 'AgencyCommand/1.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.log(`[BOUNTY] IssueHunt API returned ${res.status}`);
      return { source: 'IssueHunt', imported: 0 };
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('json')) {
      console.log(`[BOUNTY] IssueHunt returned HTML, API may have changed`);
      return { source: 'IssueHunt', imported: 0 };
    }

    const data = await res.json();
    const issues = data.items || data.issues || data.data || [];

    for (const issue of issues) {
      const issueUrl = issue.url || issue.html_url || issue.issue_url || '';
      if (!issueUrl || isDuplicateBounty(issueUrl)) continue;

      const reward = issue.total_funded || issue.funded_amount || issue.bounty_amount || 0;
      if (reward < 10) continue;

      const repoUrl = issue.repository?.url || issue.repo_url || '';
      const repoName = issue.repository?.full_name || repoUrl.split('github.com/')[1] || '';
      const body = (issue.body || issue.description || '').slice(0, 3000);
      const title = issue.title || '';
      const labels = (issue.labels || []).map(l => l.name || l);
      const fullText = `${title} ${body} ${labels.join(' ')}`;

      const skills = extractSkills(fullText);
      const difficulty = estimateDifficulty(title, body, labels);
      const estHours = estimateHours(difficulty);

      const bounty = {
        id: uuid(), title, source: 'IssueHunt', platform: 'issuehunt',
        repo: repoName, repo_url: repoUrl, issue_url: issueUrl,
        reward, currency: 'USD',
        labels: JSON.stringify(labels), skills: JSON.stringify(skills),
        description: body.slice(0, 2000), difficulty, est_hours: estHours,
        external_id: `ih-${issue.id || issueUrl}`,
      };
      bounty.roi_score = scoreBounty(bounty);

      insertBounty.run(
        bounty.id, bounty.title, bounty.source, bounty.platform,
        bounty.repo, bounty.repo_url, bounty.issue_url, bounty.reward,
        bounty.currency, bounty.labels, bounty.skills, bounty.description,
        bounty.difficulty, bounty.roi_score, bounty.est_hours, bounty.external_id
      );
      totalImported++;
    }
  } catch (err) {
    console.error('[BOUNTY] IssueHunt scrape failed:', err.message);
  }

  return { source: 'IssueHunt', imported: totalImported };
}

// ─── Boss.dev / Opire — GitHub label-based search ───────
// These platforms use GitHub labels — we scrape via GitHub search API
export async function scrapeBossDevBounties() {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'AgencyCommand/1.0',
  };
  if (token) headers['Authorization'] = `token ${token}`;

  // Boss.dev and Opire use specific labels on GitHub issues
  const queries = [
    'label:"boss" "$" in:body state:open',
    'label:"opire" state:open',
    'label:"opire bounty" state:open',
    '"boss.dev" in:body "$" state:open',
    '"opire.dev" in:body state:open',
    'label:"funded" "$" in:body state:open',
    'label:"bounty" label:"good first issue" state:open "$" in:body',
  ];

  let totalImported = 0;

  for (const q of queries) {
    try {
      const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=30`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });

      if (!res.ok) {
        if (res.status === 403) break; // rate limited
        continue;
      }

      const data = await res.json();
      for (const issue of (data.items || [])) {
        const issueUrl = issue.html_url;
        if (isDuplicateBounty(issueUrl)) continue;

        const labels = (issue.labels || []).map(l => l.name || l);
        const repoUrl = issue.repository_url?.replace('https://api.github.com/repos/', 'https://github.com/') || '';
        const repoName = repoUrl.split('github.com/')[1] || '';
        const body = (issue.body || '').slice(0, 3000);
        const fullText = `${issue.title} ${body} ${labels.join(' ')}`;

        let reward = extractRewardFromLabels(issue.labels || []);
        if (!reward) reward = extractRewardFromText(body);
        if (!reward) continue;

        const skills = extractSkills(fullText);
        const difficulty = estimateDifficulty(issue.title, body, labels);
        const estHours = estimateHours(difficulty);

        const source = labels.some(l => l.toLowerCase().includes('opire')) ? 'Opire' : 'Boss.dev';
        const bounty = {
          id: uuid(), title: issue.title, source, platform: source.toLowerCase().replace('.', ''),
          repo: repoName, repo_url: repoUrl, issue_url: issueUrl,
          reward, currency: 'USD',
          labels: JSON.stringify(labels), skills: JSON.stringify(skills),
          description: body.slice(0, 2000), difficulty, est_hours: estHours,
          external_id: `bd-${issue.id}`,
        };
        bounty.roi_score = scoreBounty(bounty);

        insertBounty.run(
          bounty.id, bounty.title, bounty.source, bounty.platform,
          bounty.repo, bounty.repo_url, bounty.issue_url, bounty.reward,
          bounty.currency, bounty.labels, bounty.skills, bounty.description,
          bounty.difficulty, bounty.roi_score, bounty.est_hours, bounty.external_id
        );
        totalImported++;
      }

      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.error(`[BOUNTY] Boss/Opire search failed:`, err.message);
    }
  }

  return { source: 'Boss.dev/Opire', imported: totalImported };
}

// ─── Gitcoin Bounties (via GitHub) ──────────────────────
// Gitcoin bounties are tracked on GitHub issues with gitcoin labels
export async function scrapeGitcoinBounties() {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'AgencyCommand/1.0',
  };
  if (token) headers['Authorization'] = `token ${token}`;

  const queries = [
    'label:"gitcoin" "bounty" state:open',
    '"gitcoin.co" in:body state:open "$"',
    'label:"gitcoin" "$" in:body state:open sort:created-desc',
    '"gitcoin" "bounty" "$" in:body state:open',
  ];

  let totalImported = 0;

  for (const q of queries) {
    try {
      const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=30`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });

      if (!res.ok) {
        if (res.status === 403) {
          console.log('[BOUNTY] Gitcoin: GitHub rate limited');
          break;
        }
        continue;
      }

      const data = await res.json();
      for (const issue of (data.items || [])) {
        const issueUrl = issue.html_url;
        if (isDuplicateBounty(issueUrl)) continue;

        const labels = (issue.labels || []).map(l => l.name || l);
        const repoUrl = issue.repository_url?.replace('https://api.github.com/repos/', 'https://github.com/') || '';
        const repoName = repoUrl.split('github.com/')[1] || '';

        if (isBlockedOrg(repoName)) continue;

        const body = (issue.body || '').slice(0, 3000);
        const fullText = `${issue.title} ${body} ${labels.join(' ')}`;

        let reward = extractRewardFromLabels(issue.labels || []);
        if (!reward) reward = extractRewardFromText(body);
        if (!reward) continue;

        const tokenPattern = /\b(RTC|FL0X|POINTS|XP|TOKEN)\b/i;
        if (tokenPattern.test(issue.title) && !body.includes('$')) continue;
        if (body.toLowerCase().includes('not accepting bounties')) continue;

        const skills = extractSkills(fullText);
        const difficulty = estimateDifficulty(issue.title, body, labels);
        const estHours = estimateHours(difficulty);

        const bounty = {
          id: uuid(), title: issue.title, source: 'Gitcoin', platform: 'gitcoin',
          repo: repoName, repo_url: repoUrl, issue_url: issueUrl,
          reward, currency: 'USD',
          labels: JSON.stringify(labels), skills: JSON.stringify(skills),
          description: body.slice(0, 2000), difficulty, est_hours: estHours,
          external_id: `gitcoin-${issue.id}`,
        };
        bounty.roi_score = scoreBounty(bounty);

        insertBounty.run(
          bounty.id, bounty.title, bounty.source, bounty.platform,
          bounty.repo, bounty.repo_url, bounty.issue_url, bounty.reward,
          bounty.currency, bounty.labels, bounty.skills, bounty.description,
          bounty.difficulty, bounty.roi_score, bounty.est_hours, bounty.external_id
        );
        totalImported++;
      }

      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.error(`[BOUNTY] Gitcoin search failed:`, err.message);
    }
  }

  return { source: 'Gitcoin', imported: totalImported };
}

// ─── OSS Bounties — high-value repos with bounty programs ─
// Targets specific open-source repos known to pay real USD bounties
export async function scrapeOSSBounties() {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'AgencyCommand/1.0',
  };
  if (token) headers['Authorization'] = `token ${token}`;

  const queries = [
    'repo:juspay/hyperswitch label:bounty state:open',
    'repo:cal-com/cal.com label:bounty state:open',
    'repo:twentyhq/twenty label:bounty state:open',
    'repo:documenso/documenso label:bounty state:open',
    'repo:formbricks/formbricks label:bounty state:open',
    'repo:openbb-finance/OpenBB label:bounty state:open',
    'repo:maybe-finance/maybe label:bounty state:open',
    'repo:infisical/infisical label:bounty state:open',
    '"bounty" "$" in:body state:open language:typescript sort:created-desc',
    '"bounty" "$" in:body state:open language:rust sort:created-desc',
  ];

  let totalImported = 0;

  for (const q of queries) {
    try {
      const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=30`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });

      if (!res.ok) {
        if (res.status === 403) {
          console.log('[BOUNTY] OSS: GitHub rate limited');
          break;
        }
        continue;
      }

      const data = await res.json();
      for (const issue of (data.items || [])) {
        const issueUrl = issue.html_url;
        if (isDuplicateBounty(issueUrl)) continue;

        const labels = (issue.labels || []).map(l => l.name || l);
        const repoUrl = issue.repository_url?.replace('https://api.github.com/repos/', 'https://github.com/') || '';
        const repoName = repoUrl.split('github.com/')[1] || '';

        if (isBlockedOrg(repoName)) continue;

        const body = (issue.body || '').slice(0, 3000);
        const fullText = `${issue.title} ${body} ${labels.join(' ')}`;

        let reward = extractRewardFromLabels(issue.labels || []);
        if (!reward) reward = extractRewardFromText(body);
        if (!reward) continue;

        const tokenPattern = /\b(RTC|FL0X|POINTS|XP|TOKEN)\b/i;
        if (tokenPattern.test(issue.title) && !body.includes('$')) continue;
        if (body.toLowerCase().includes('not accepting bounties')) continue;

        const skills = extractSkills(fullText);
        const difficulty = estimateDifficulty(issue.title, body, labels);
        const estHours = estimateHours(difficulty);

        const bounty = {
          id: uuid(), title: issue.title, source: 'OSS-Bounty', platform: 'github',
          repo: repoName, repo_url: repoUrl, issue_url: issueUrl,
          reward, currency: 'USD',
          labels: JSON.stringify(labels), skills: JSON.stringify(skills),
          description: body.slice(0, 2000), difficulty, est_hours: estHours,
          external_id: `oss-${issue.id}`,
        };
        bounty.roi_score = scoreBounty(bounty);

        insertBounty.run(
          bounty.id, bounty.title, bounty.source, bounty.platform,
          bounty.repo, bounty.repo_url, bounty.issue_url, bounty.reward,
          bounty.currency, bounty.labels, bounty.skills, bounty.description,
          bounty.difficulty, bounty.roi_score, bounty.est_hours, bounty.external_id
        );
        totalImported++;
      }

      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.error(`[BOUNTY] OSS bounty search failed:`, err.message);
    }
  }

  return { source: 'OSS-Bounty', imported: totalImported };
}

// ─── Fresh Bounties — last 24h, first-mover advantage ───
// Time-sensitive search for bounties created in the last day
export async function scrapeFreshBounties() {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'AgencyCommand/1.0',
  };
  if (token) headers['Authorization'] = `token ${token}`;

  // Yesterday's date in YYYY-MM-DD format for GitHub search
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  const queries = [
    `label:bounty state:open created:>${yesterday} "$"`,
    `"bounty" "$" state:open sort:created-desc created:>${yesterday}`,
    `label:bounty state:open created:>${yesterday} sort:created-desc`,
    `label:"💎 bounty" state:open created:>${yesterday}`,
  ];

  let totalImported = 0;

  for (const q of queries) {
    try {
      const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=30`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });

      if (!res.ok) {
        if (res.status === 403) {
          console.log('[BOUNTY] Fresh: GitHub rate limited');
          break;
        }
        continue;
      }

      const data = await res.json();
      for (const issue of (data.items || [])) {
        const issueUrl = issue.html_url;
        if (isDuplicateBounty(issueUrl)) continue;

        const labels = (issue.labels || []).map(l => l.name || l);
        const repoUrl = issue.repository_url?.replace('https://api.github.com/repos/', 'https://github.com/') || '';
        const repoName = repoUrl.split('github.com/')[1] || '';

        if (isBlockedOrg(repoName)) continue;

        const body = (issue.body || '').slice(0, 3000);
        const fullText = `${issue.title} ${body} ${labels.join(' ')}`;

        let reward = extractRewardFromLabels(issue.labels || []);
        if (!reward) reward = extractRewardFromText(body);
        if (!reward) continue;

        const tokenPattern = /\b(RTC|FL0X|POINTS|XP|TOKEN)\b/i;
        if (tokenPattern.test(issue.title) && !body.includes('$')) continue;
        if (body.toLowerCase().includes('not accepting bounties')) continue;

        const skills = extractSkills(fullText);
        const difficulty = estimateDifficulty(issue.title, body, labels);
        const estHours = estimateHours(difficulty);

        const bounty = {
          id: uuid(), title: issue.title, source: 'Fresh', platform: 'github',
          repo: repoName, repo_url: repoUrl, issue_url: issueUrl,
          reward, currency: 'USD',
          labels: JSON.stringify(labels), skills: JSON.stringify(skills),
          description: body.slice(0, 2000), difficulty, est_hours: estHours,
          external_id: `fresh-${issue.id}`,
        };
        bounty.roi_score = scoreBounty(bounty);

        insertBounty.run(
          bounty.id, bounty.title, bounty.source, bounty.platform,
          bounty.repo, bounty.repo_url, bounty.issue_url, bounty.reward,
          bounty.currency, bounty.labels, bounty.skills, bounty.description,
          bounty.difficulty, bounty.roi_score, bounty.est_hours, bounty.external_id
        );
        totalImported++;
      }

      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.error(`[BOUNTY] Fresh bounty search failed:`, err.message);
    }
  }

  return { source: 'Fresh', imported: totalImported };
}

// ─── Auto-merge repo hunter ─────────────────────────────
// Repos with auto-merge bots = instant money if CI passes
export async function scrapeAutoMergeRepos() {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'AgencyCommand/1.0',
  };
  if (token) headers['Authorization'] = `token ${token}`;

  // Search for bounty issues in repos that have mergify or auto-merge configs
  const queries = [
    'label:bounty state:open "auto-merge" in:readme',
    'label:bounty state:open filename:.mergify.yml',
    'label:bounty state:open "mergify" in:comments',
    'label:bounty "$" state:open label:auto-merge',
    // Repos known to have auto-merge + bounties
    'repo:ghostfolio/ghostfolio label:bounty state:open',
    'repo:trigger-dev/trigger.dev label:bounty state:open',
    'repo:refinedev/refine label:bounty state:open',
    'repo:medusajs/medusa label:bounty state:open',
    'repo:nhost/nhost label:bounty state:open',
    'repo:supabase/supabase label:bounty state:open',
  ];

  let totalImported = 0;

  for (const q of queries) {
    try {
      const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=30`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });

      if (!res.ok) {
        if (res.status === 403) {
          console.log('[BOUNTY] GitHub rate limited on auto-merge search');
          break;
        }
        continue;
      }

      const data = await res.json();
      for (const issue of (data.items || [])) {
        const issueUrl = issue.html_url;
        if (isDuplicateBounty(issueUrl)) continue;

        const labels = (issue.labels || []).map(l => l.name || l);
        const repoUrl = issue.repository_url?.replace('https://api.github.com/repos/', 'https://github.com/') || '';
        const repoName = repoUrl.split('github.com/')[1] || '';

        if (isBlockedOrg(repoName)) continue;

        const body = (issue.body || '').slice(0, 3000);
        let reward = extractRewardFromLabels(issue.labels || []);
        if (!reward) reward = extractRewardFromText(body);
        if (!reward) continue;

        // Skip token bounties
        const tokenPattern = /\b(RTC|FL0X|POINTS|XP|TOKEN)\b/i;
        if (tokenPattern.test(issue.title) && !body.includes('$')) continue;
        if (body.toLowerCase().includes('not accepting bounties')) continue;

        const fullText = `${issue.title} ${body} ${labels.join(' ')}`;
        const skills = extractSkills(fullText);
        const difficulty = estimateDifficulty(issue.title, body, labels);
        const estHours = estimateHours(difficulty);

        const bounty = {
          id: uuid(),
          title: issue.title,
          source: 'AutoMerge',
          platform: 'github',
          repo: repoName,
          repo_url: repoUrl,
          issue_url: issueUrl,
          reward,
          currency: 'USD',
          labels: JSON.stringify(labels),
          skills: JSON.stringify(skills),
          description: body.slice(0, 2000),
          difficulty,
          est_hours: estHours,
          external_id: `am-${issue.id}`,
        };

        bounty.roi_score = scoreBounty(bounty) + 15; // Bonus score for auto-merge repos

        insertBounty.run(
          bounty.id, bounty.title, bounty.source, bounty.platform,
          bounty.repo, bounty.repo_url, bounty.issue_url, bounty.reward,
          bounty.currency, bounty.labels, bounty.skills, bounty.description,
          bounty.difficulty, bounty.roi_score, bounty.est_hours, bounty.external_id
        );
        totalImported++;
      }

      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.error(`[BOUNTY] Auto-merge search failed:`, err.message);
    }
  }

  return { source: 'AutoMerge', imported: totalImported };
}

// ─── Main: Scrape all bounty sources ────────────────────
export async function scrapeAllBounties() {
  console.log('[BOUNTY] Scraping all bounty sources...');
  const results = [];

  const settled = await Promise.allSettled([
    scrapeGitHubBounties(),
    scrapeAlgoraBounties(),
    scrapeIssueHuntBounties(),
    scrapeBossDevBounties(),
    scrapeGitcoinBounties(),
    scrapeOSSBounties(),
    scrapeFreshBounties(),
    scrapeAutoMergeRepos(),
  ]);

  const sourceNames = ['GitHub', 'Algora', 'IssueHunt', 'Boss.dev/Opire', 'Gitcoin', 'OSS-Bounty', 'Fresh', 'AutoMerge'];
  for (let i = 0; i < settled.length; i++) {
    if (settled[i].status === 'fulfilled') results.push(settled[i].value);
    else console.error(`[BOUNTY] ${sourceNames[i]} failed:`, settled[i].reason?.message);
  }

  const totalImported = results.reduce((s, r) => s + r.imported, 0);
  console.log(`[BOUNTY] Done: ${totalImported} new bounties from ${results.length} sources`);

  // Background: check repo freshness for unchecked bounties and re-score
  try { await checkRepoFreshness(); } catch (e) {
    console.error('[BOUNTY] Freshness check failed:', e.message);
  }

  return { results, totalImported };
}

// ─── Repo freshness checker ─────────────────────────────
// Checks if bounty repos are alive or zombie, caches result, re-scores
async function checkRepoFreshness() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return;
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'Authorization': `token ${token}`,
    'User-Agent': 'AgencyCommand/1.0',
  };

  // Get unique repos that haven't been checked yet
  const unchecked = db.prepare(`
    SELECT DISTINCT repo FROM bounties
    WHERE status = 'open' AND repo != ''
    AND repo NOT IN (
      SELECT REPLACE(key, 'repo_activity:', '') FROM settings WHERE key LIKE 'repo_activity:%'
    )
    LIMIT 10
  `).all();

  for (const { repo } of unchecked) {
    try {
      const res = await fetch(`${GITHUB_API}/repos/${repo}`, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const data = await res.json();

      const pushedAt = new Date(data.pushed_at || 0);
      const daysSincePush = Math.round((Date.now() - pushedAt.getTime()) / (1000 * 60 * 60 * 24));

      const activity = {
        daysSincePush,
        stars: data.stargazers_count || 0,
        archived: data.archived || false,
        pushedAt: data.pushed_at,
      };

      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
        `repo_activity:${repo}`, JSON.stringify(activity)
      );

      // Re-score all open bounties for this repo
      if (daysSincePush > 365 || data.archived) {
        const { scoreBounty } = await import('./bountyScorer.js');
        const bounties = db.prepare("SELECT * FROM bounties WHERE repo = ? AND status = 'open'").all(repo);
        for (const b of bounties) {
          const newScore = scoreBounty({ ...b, labels: JSON.parse(b.labels || '[]'), skills: JSON.parse(b.skills || '[]') });
          db.prepare("UPDATE bounties SET roi_score = ? WHERE id = ?").run(newScore, b.id);
        }
        console.log(`[BOUNTY] Re-scored ${bounties.length} bounties for stale repo ${repo} (${daysSincePush}d inactive)`);
      }

      await new Promise(r => setTimeout(r, 500));
    } catch (e) { /* non-fatal */ }
  }
}

// ─── Queries ────────────────────────────────────────────
export function getTopBounties(limit = 20) {
  return db.prepare(`
    SELECT * FROM bounties
    WHERE status = 'open' AND claimed = 0
    ORDER BY roi_score DESC, reward DESC
    LIMIT ?
  `).all(limit).map(b => ({
    ...b,
    labels: JSON.parse(b.labels || '[]'),
    skills: JSON.parse(b.skills || '[]'),
  }));
}

export function getQuickWins(limit = 10) {
  return db.prepare(`
    SELECT * FROM bounties
    WHERE status = 'open' AND claimed = 0 AND difficulty = 'easy'
    ORDER BY reward DESC, roi_score DESC
    LIMIT ?
  `).all(limit).map(b => ({
    ...b,
    labels: JSON.parse(b.labels || '[]'),
    skills: JSON.parse(b.skills || '[]'),
  }));
}

export function getBountyStats() {
  const total = db.prepare("SELECT COUNT(*) as c FROM bounties WHERE status = 'open'").get().c;
  const totalReward = db.prepare("SELECT COALESCE(SUM(reward), 0) as t FROM bounties WHERE status = 'open'").get().t;
  const claimed = db.prepare('SELECT COUNT(*) as c FROM bounties WHERE claimed = 1').get().c;
  const completed = db.prepare('SELECT COUNT(*) as c FROM bounties WHERE completed = 1').get().c;
  const earned = db.prepare('SELECT COALESCE(SUM(reward), 0) as t FROM bounties WHERE payout_received = 1').get().t;
  const avgRoi = db.prepare("SELECT COALESCE(AVG(roi_score), 0) as a FROM bounties WHERE status = 'open'").get().a;
  const quickWins = db.prepare("SELECT COUNT(*) as c FROM bounties WHERE status = 'open' AND difficulty = 'easy'").get().c;
  const highValue = db.prepare("SELECT COUNT(*) as c FROM bounties WHERE status = 'open' AND reward >= 500").get().c;

  return { total, totalReward, claimed, completed, earned, avgRoi: Math.round(avgRoi), quickWins, highValue };
}

export function claimBounty(id) {
  db.prepare("UPDATE bounties SET claimed = 1, status = 'claimed', updated_at = datetime('now') WHERE id = ?").run(id);
}

export function submitBounty(id) {
  db.prepare("UPDATE bounties SET submitted = 1, status = 'submitted', updated_at = datetime('now') WHERE id = ?").run(id);
}

export function completeBounty(id) {
  db.prepare("UPDATE bounties SET completed = 1, status = 'completed', updated_at = datetime('now') WHERE id = ?").run(id);
}

export function markPaid(id) {
  db.prepare("UPDATE bounties SET payout_received = 1, status = 'paid', updated_at = datetime('now') WHERE id = ?").run(id);
}

export function dismissBounty(id) {
  db.prepare("UPDATE bounties SET status = 'dismissed', updated_at = datetime('now') WHERE id = ?").run(id);
}

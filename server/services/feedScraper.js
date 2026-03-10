import Parser from 'rss-parser';
import { v4 as uuid } from 'uuid';
import db from '../db/connection.js';
import { scoreJob, estimateValue, estimateTime } from './scorer.js';

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
});

// Extract skills from text by matching against known skill keywords
const SKILL_KEYWORDS = [
  'react', 'typescript', 'javascript', 'node', 'nodejs', 'node.js', 'express', 'next.js',
  'nextjs', 'vue', 'angular', 'python', 'django', 'flask', 'ruby', 'rails',
  'php', 'laravel', 'java', 'swift', 'kotlin', 'rust', 'go', 'golang',
  'postgresql', 'postgres', 'mysql', 'mongodb', 'redis', 'sqlite',
  'aws', 'gcp', 'azure', 'docker', 'kubernetes', 'k8s',
  'stripe', 'payment', 'solana', 'web3', 'blockchain', 'crypto', 'ethereum',
  'graphql', 'rest api', 'websocket', 'tailwind', 'css', 'html',
  'landing page', 'dashboard', 'e-commerce', 'ecommerce', 'saas',
  'mobile', 'react native', 'flutter', 'ios', 'android',
  'ai', 'machine learning', 'openai', 'llm', 'chatbot', 'gpt', 'claude',
  'firebase', 'supabase', 'vercel', 'railway', 'heroku', 'netlify',
  'auth', 'authentication', 'oauth', 'jwt',
  'figma', 'ui', 'ux', 'frontend', 'backend', 'full-stack', 'fullstack',
  'devops', 'ci/cd', 'terraform', 'linux', 'nginx',
];

function extractSkills(text) {
  const lower = (text || '').toLowerCase();
  const found = new Set();
  for (const k of SKILL_KEYWORDS) {
    if (lower.includes(k)) {
      // Normalize similar skills
      const normalized = k.replace('nodejs', 'node.js').replace('nextjs', 'next.js')
        .replace('postgres', 'postgresql').replace('k8s', 'kubernetes');
      found.add(normalized.charAt(0).toUpperCase() + normalized.slice(1));
    }
  }
  return [...found].slice(0, 10);
}

function extractBudget(text) {
  const t = text || '';
  // Match salary ranges like $120k-$180k, $120,000-$180,000
  const kMatch = t.match(/\$[\d]+k\s*[-–to]+\s*\$?[\d]+k/i);
  if (kMatch) return kMatch[0];
  const rangeMatch = t.match(/\$[\d,]+\s*[-–to]+\s*\$?[\d,]+/);
  if (rangeMatch) return rangeMatch[0];
  const single = t.match(/\$[\d,]+k?/i);
  return single ? single[0] : '';
}

function timeAgo(dateStr) {
  if (!dateStr) return 'unknown';
  const diff = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 0) return 'just now';
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

// Strip HTML tags for cleaner descriptions
function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

// Clean up job title — remove "New comment by X in ..." patterns
function cleanTitle(title, content) {
  let t = (title || '').trim();
  // HN "Who is Hiring" pattern — extract company from content instead
  if (t.includes('New comment by') && t.includes('Who is hiring')) {
    const firstLine = stripHtml(content || '').split(/[.\n|]/).filter(s => s.trim())[0] || '';
    if (firstLine.length > 5 && firstLine.length < 120) return firstLine.trim();
    return t;
  }
  // RemoteOK cleanup
  t = t.replace(/^\s*\n\s*/g, '').replace(/\t+/g, ' ').trim();
  return t || 'Untitled Job';
}

// Deduplicate — check if a similar job already exists
function isDuplicate(title, url) {
  if (url) {
    const existing = db.prepare('SELECT id FROM jobs WHERE url = ?').get(url);
    if (existing) return true;
  }
  // Also check by similar title (exact match)
  if (title) {
    const existing = db.prepare('SELECT id FROM jobs WHERE title = ?').get(title);
    if (existing) return true;
  }
  return false;
}

export async function scrapeFeed(feedUrl, source = 'Custom') {
  try {
    const feed = await parser.parseURL(feedUrl);
    const insertJob = db.prepare(`
      INSERT OR IGNORE INTO jobs (id, title, source, client, budget, description, url, skills, score, est_value, est_time, posted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let imported = 0;
    // Process up to 50 items per feed (was 20)
    for (const item of feed.items.slice(0, 50)) {
      const rawContent = item.contentSnippet || item.content || item.summary || '';
      const fullText = `${item.title || ''} ${rawContent}`;
      const description = stripHtml(rawContent).slice(0, 2000);
      const title = cleanTitle(item.title, rawContent);

      // Skip if duplicate
      if (isDuplicate(title, item.link)) continue;

      const skills = extractSkills(fullText);
      const budget = extractBudget(fullText);
      const estValue = estimateValue(budget);

      const job = {
        id: uuid(),
        title,
        source,
        client: item.creator || item.author || item['dc:creator'] || '',
        budget,
        description,
        url: item.link || '',
        skills: JSON.stringify(skills),
        est_value: estValue || 1000,
        est_time: estimateTime(estValue || 1000),
        posted_at: timeAgo(item.pubDate || item.isoDate),
      };

      job.score = scoreJob(job);

      // Import all jobs with any relevance
      if (job.score >= 15) {
        insertJob.run(job.id, job.title, job.source, job.client, job.budget, job.description, job.url, job.skills, job.score, job.est_value, job.est_time, job.posted_at);
        imported++;
      }
    }

    // Update feed last_fetched
    db.prepare("UPDATE feeds SET last_fetched = datetime('now') WHERE url = ?").run(feedUrl);

    return { success: true, imported, total: feed.items.length };
  } catch (err) {
    console.error(`Feed scrape failed for ${feedUrl}:`, err.message);
    return { success: false, error: err.message, imported: 0 };
  }
}

export async function scrapeAllFeeds() {
  const feeds = db.prepare("SELECT * FROM feeds WHERE active = 1").all();
  const results = [];
  for (const feed of feeds) {
    const result = await scrapeFeed(feed.url, feed.source);
    results.push({ ...result, feedUrl: feed.url });
  }
  return results;
}

import Parser from 'rss-parser';
import { v4 as uuid } from 'uuid';
import db from '../db/connection.js';
import { scoreJob, estimateValue, estimateTime } from './scorer.js';

const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'AgencyCommand/1.0' },
});

// Extract skills from text by matching against known skill keywords
const SKILL_KEYWORDS = [
  'react', 'typescript', 'javascript', 'node', 'nodejs', 'express', 'next.js',
  'nextjs', 'vue', 'angular', 'python', 'django', 'flask', 'ruby', 'rails',
  'php', 'laravel', 'java', 'swift', 'kotlin', 'rust', 'go', 'golang',
  'postgresql', 'postgres', 'mysql', 'mongodb', 'redis', 'sqlite',
  'aws', 'gcp', 'azure', 'docker', 'kubernetes',
  'stripe', 'payment', 'solana', 'web3', 'blockchain', 'crypto',
  'graphql', 'rest api', 'websocket', 'tailwind', 'css', 'html',
  'landing page', 'dashboard', 'e-commerce', 'ecommerce', 'saas',
  'mobile', 'react native', 'flutter', 'ios', 'android',
  'ai', 'machine learning', 'openai', 'llm', 'chatbot',
  'firebase', 'supabase', 'vercel', 'railway', 'heroku',
  'auth', 'authentication', 'oauth', 'jwt',
];

function extractSkills(text) {
  const lower = (text || '').toLowerCase();
  return SKILL_KEYWORDS
    .filter(k => lower.includes(k))
    .map(k => k.charAt(0).toUpperCase() + k.slice(1))
    .slice(0, 8);
}

function extractBudget(text) {
  const match = (text || '').match(/\$[\d,]+\s*[-–]\s*\$?[\d,]+/);
  if (match) return match[0];
  const single = (text || '').match(/\$[\d,]+/);
  return single ? single[0] : '';
}

function timeAgo(dateStr) {
  if (!dateStr) return 'unknown';
  const diff = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export async function scrapeFeed(feedUrl, source = 'Custom') {
  try {
    const feed = await parser.parseURL(feedUrl);
    const insertJob = db.prepare(`
      INSERT OR IGNORE INTO jobs (id, title, source, client, budget, description, url, skills, score, est_value, est_time, posted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let imported = 0;
    for (const item of feed.items.slice(0, 20)) {
      const fullText = `${item.title || ''} ${item.contentSnippet || item.content || ''}`;
      const skills = extractSkills(fullText);
      const budget = extractBudget(fullText);
      const estValue = estimateValue(budget);

      const job = {
        id: uuid(),
        title: item.title || 'Untitled Job',
        source,
        client: item.creator || item.author || '',
        budget,
        description: (item.contentSnippet || item.content || '').slice(0, 1000),
        url: item.link || '',
        skills: JSON.stringify(skills),
        est_value: estValue || 1000,
        est_time: estimateTime(estValue || 1000),
        posted_at: timeAgo(item.pubDate || item.isoDate),
      };

      job.score = scoreJob(job);

      // Import all scored jobs (filter in UI instead)
      if (job.score >= 20) {
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

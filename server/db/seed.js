import db from './connection.js';
import { v4 as uuid } from 'uuid';

console.log('Seeding database...');

// Pre-load RSS feeds — free job boards, no account/payment needed
const insertFeed = db.prepare('INSERT OR IGNORE INTO feeds (id, url, source, active) VALUES (?, ?, ?, 1)');
const feeds = [
  // RemoteOK — 99+ remote dev jobs, direct apply links, free
  { url: 'https://remoteok.com/remote-dev-jobs.rss', source: 'RemoteOK' },
  // Hacker News "Who is Hiring" — high quality, direct links
  { url: 'https://hnrss.org/whoishiring/jobs', source: 'HN Jobs' },
  // Dribbble — design + frontend + UI/UX jobs, direct links
  { url: 'https://dribbble.com/jobs.rss', source: 'Dribbble' },
];
for (const f of feeds) {
  insertFeed.run(uuid(), f.url, f.source);
}

// Default settings
const upsertSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
upsertSetting.run('snipelink_base', 'https://snipelink.io/pay/');
upsertSetting.run('my_skills', JSON.stringify([
  "TypeScript","React","Node.js","Express","Next.js","Web Apps",
  "Dashboards","Payment Integration","Stripe","Solana/Web3",
  "PostgreSQL","SQLite","Railway","REST API","AI Integration",
  "Landing Pages","E-commerce","Auth Systems"
]));

console.log(`Seeded ${feeds.length} feeds + default settings. Real jobs load on boot.`);
// Only exit when run directly (not imported)
if (process.argv[1]?.endsWith('seed.js')) process.exit(0);

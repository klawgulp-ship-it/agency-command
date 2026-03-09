import db from './connection.js';
import { v4 as uuid } from 'uuid';

console.log('Seeding database...');

const jobs = [
  { title: "React Dashboard for SaaS Analytics Platform", source: "Upwork", budget: "$3,000-5,000", client: "TechMetrics Inc.", skills: ["React","TypeScript","Node.js","Dashboards"], score: 95, est_value: 4000, est_time: "5-7 days", description: "Need experienced React developer to build an analytics dashboard with real-time charts, user management, and data export features. Must have experience with TypeScript and modern React patterns.", posted_at: "2h ago" },
  { title: "Stripe Payment Integration for Marketplace", source: "Upwork", budget: "$1,500-2,500", client: "MarketHub", skills: ["Stripe","Node.js","Payment Integration","Express"], score: 92, est_value: 2000, est_time: "3-4 days", description: "Looking for a payment specialist to integrate Stripe Connect into our multi-vendor marketplace. Needs escrow, split payments, and webhook handling.", posted_at: "4h ago" },
  { title: "Full-Stack Web App - Inventory Management", source: "LinkedIn", budget: "$4,000-7,000", client: "RetailOps LLC", skills: ["React","TypeScript","Express","PostgreSQL","Web Apps"], score: 90, est_value: 5500, est_time: "7-10 days", description: "Building an inventory management system for a mid-size retailer. Need CRUD operations, barcode scanning, reporting, and role-based access.", posted_at: "6h ago" },
  { title: "Landing Page with A/B Testing", source: "Fiverr", budget: "$600-1,000", client: "AIStartup.io", skills: ["React","Landing Pages","TypeScript"], score: 85, est_value: 800, est_time: "1-2 days", description: "Need a high-converting landing page for our AI product launch. Must include A/B testing setup, analytics integration, and mobile optimization.", posted_at: "1d ago" },
  { title: "Solana NFT Marketplace Frontend", source: "Upwork", budget: "$5,000-8,000", client: "SolSpace", skills: ["React","TypeScript","Solana/Web3","Web Apps"], score: 88, est_value: 6500, est_time: "8-12 days", description: "Need a frontend developer experienced with Solana to build an NFT marketplace UI. Wallet connection, listing/bidding, and collection pages.", posted_at: "3h ago" },
];

const insertJob = db.prepare(`
  INSERT OR IGNORE INTO jobs (id, title, source, budget, client, skills, score, est_value, est_time, description, posted_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const j of jobs) {
  insertJob.run(uuid(), j.title, j.source, j.budget, j.client, JSON.stringify(j.skills), j.score, j.est_value, j.est_time, j.description, j.posted_at);
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

console.log(`Seeded ${jobs.length} jobs + default settings.`);
process.exit(0);

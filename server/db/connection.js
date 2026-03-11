import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Use Railway persistent volume at /data if available, else local ./data
const dbDir = existsSync('/data') ? '/data' : join(__dirname, '../../data');
if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

const db = new Database(join(dbDir, 'agency.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ──────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS feeds (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'custom',
    active INTEGER DEFAULT 1,
    last_fetched TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    client TEXT DEFAULT '',
    budget TEXT DEFAULT '',
    description TEXT DEFAULT '',
    url TEXT DEFAULT '',
    skills TEXT DEFAULT '[]',
    score INTEGER DEFAULT 0,
    est_value INTEGER DEFAULT 0,
    est_time TEXT DEFAULT '',
    posted_at TEXT DEFAULT '',
    dismissed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    project TEXT DEFAULT '',
    stage TEXT DEFAULT 'lead',
    budget INTEGER DEFAULT 0,
    deposit INTEGER DEFAULT 0,
    final_payment INTEGER DEFAULT 0,
    requirements TEXT DEFAULT '',
    proposal TEXT DEFAULT '',
    template TEXT,
    notes TEXT DEFAULT '',
    job_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    project TEXT DEFAULT '',
    type TEXT DEFAULT 'deposit',
    amount INTEGER DEFAULT 0,
    note TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    payment_link TEXT DEFAULT '',
    paid_at TEXT,
    reminder_sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT DEFAULT '',
    data TEXT DEFAULT '{}',
    read INTEGER DEFAULT 0,
    action_url TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Bounties table — micro-bounties aggregator
db.exec(`
  CREATE TABLE IF NOT EXISTS bounties (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'github',
    repo TEXT DEFAULT '',
    repo_url TEXT DEFAULT '',
    issue_url TEXT NOT NULL,
    reward INTEGER DEFAULT 0,
    currency TEXT DEFAULT 'USD',
    labels TEXT DEFAULT '[]',
    skills TEXT DEFAULT '[]',
    description TEXT DEFAULT '',
    difficulty TEXT DEFAULT 'medium',
    roi_score INTEGER DEFAULT 0,
    est_hours REAL DEFAULT 0,
    status TEXT DEFAULT 'open',
    claimed INTEGER DEFAULT 0,
    submitted INTEGER DEFAULT 0,
    completed INTEGER DEFAULT 0,
    payout_received INTEGER DEFAULT 0,
    notes TEXT DEFAULT '',
    external_id TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Safe migrations
try { db.exec("ALTER TABLE invoices ADD COLUMN payment_ref TEXT DEFAULT ''"); } catch (e) { /* already exists */ }
try { db.exec("ALTER TABLE clients ADD COLUMN referrer_code TEXT DEFAULT ''"); } catch (e) { /* already exists */ }
try { db.exec("ALTER TABLE clients ADD COLUMN portal_token TEXT DEFAULT ''"); } catch (e) { /* already exists */ }

// Referrals table
db.exec(`
  CREATE TABLE IF NOT EXISTS referrers (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    payout_method TEXT DEFAULT '',
    commission_rate REAL DEFAULT 0.10,
    total_clicks INTEGER DEFAULT 0,
    total_referrals INTEGER DEFAULT 0,
    total_earned REAL DEFAULT 0,
    total_paid REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS referral_events (
    id TEXT PRIMARY KEY,
    referrer_id TEXT NOT NULL,
    type TEXT NOT NULL,
    client_id TEXT,
    amount REAL DEFAULT 0,
    commission REAL DEFAULT 0,
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (referrer_id) REFERENCES referrers(id)
  );
`);

// PR reviews queue — for webhook-driven review responses
db.exec(`
  CREATE TABLE IF NOT EXISTS pr_reviews (
    id TEXT PRIMARY KEY,
    pr_url TEXT NOT NULL,
    reviewer TEXT DEFAULT '',
    state TEXT DEFAULT '',
    body TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    handled INTEGER DEFAULT 0
  );
`);

export default db;

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbDir = join(__dirname, '../../data');
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

export default db;

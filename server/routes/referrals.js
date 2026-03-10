import { Router } from 'express';
import db from '../db/connection.js';
import { v4 as uuid } from 'uuid';
import crypto from 'crypto';

const router = Router();

// Generate short referral code from name
function generateCode(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  const suffix = crypto.randomBytes(2).toString('hex');
  return base + suffix;
}

// POST /api/referrals/signup — public, anyone can become a referrer
router.post('/signup', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { name, email, payout_method } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });

  // Check if already registered
  const existing = db.prepare('SELECT * FROM referrers WHERE email = ?').get(email);
  if (existing) {
    return res.json({ success: true, code: existing.code, message: 'You already have a referral code!' });
  }

  const id = uuid();
  const code = generateCode(name);

  db.prepare(`
    INSERT INTO referrers (id, code, name, email, payout_method)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, code, name, email, payout_method || '');

  res.json({
    success: true,
    code,
    referral_link: `https://klawgulp-ship-it.github.io/?ref=${code}`,
    message: `Welcome ${name}! Share your link to earn 10% on every project.`,
  });
});

// CORS preflight for signup
router.options('/signup', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// POST /api/referrals/track — track a click (called from portfolio site)
router.post('/track', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });

  const referrer = db.prepare('SELECT * FROM referrers WHERE code = ?').get(code);
  if (!referrer) return res.status(404).json({ error: 'invalid referral code' });

  db.prepare('UPDATE referrers SET total_clicks = total_clicks + 1 WHERE id = ?').run(referrer.id);
  res.json({ success: true });
});

// CORS preflight for track
router.options('/track', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// GET /api/referrals/dashboard/:code — public referrer dashboard
router.get('/dashboard/:code', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const referrer = db.prepare('SELECT * FROM referrers WHERE code = ?').get(req.params.code);
  if (!referrer) return res.status(404).json({ error: 'invalid code' });

  const events = db.prepare(
    'SELECT * FROM referral_events WHERE referrer_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(referrer.id);

  res.json({
    name: referrer.name,
    code: referrer.code,
    commission_rate: referrer.commission_rate,
    total_clicks: referrer.total_clicks,
    total_referrals: referrer.total_referrals,
    total_earned: referrer.total_earned,
    total_paid: referrer.total_paid,
    balance: Math.round((referrer.total_earned - referrer.total_paid) * 100) / 100,
    events,
  });
});

// CORS preflight for dashboard
router.options('/dashboard/:code', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// GET /api/referrals — admin: list all referrers
router.get('/', (req, res) => {
  const referrers = db.prepare('SELECT * FROM referrers ORDER BY total_earned DESC').all();
  res.json(referrers);
});

// POST /api/referrals/:id/payout — admin: record a payout
router.post('/:id/payout', (req, res) => {
  const { amount } = req.body;
  const referrer = db.prepare('SELECT * FROM referrers WHERE id = ?').get(req.params.id);
  if (!referrer) return res.status(404).json({ error: 'not found' });

  db.prepare('UPDATE referrers SET total_paid = total_paid + ? WHERE id = ?').run(amount, referrer.id);
  db.prepare(`
    INSERT INTO referral_events (id, referrer_id, type, amount, note)
    VALUES (?, ?, 'payout', ?, 'Manual payout')
  `).run(uuid(), referrer.id, amount);

  res.json({ success: true, new_balance: Math.round((referrer.total_earned - referrer.total_paid - amount) * 100) / 100 });
});

export default router;

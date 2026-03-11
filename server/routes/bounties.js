import { Router } from 'express';
import db from '../db/connection.js';
import {
  scrapeAllBounties, getTopBounties, getQuickWins, getBountyStats,
  claimBounty, submitBounty, completeBounty, markPaid, dismissBounty,
} from '../services/bountyScraper.js';
import { runAutoSolver, runBlitzSolver } from '../services/bountySolver.js';

const router = Router();

// GET /api/bounties — list bounties with filters
router.get('/', (req, res) => {
  const { status = 'open', sort = 'roi_score', limit = 50, difficulty, min_reward } = req.query;

  let sql = 'SELECT * FROM bounties WHERE 1=1';
  const params = [];

  if (status !== 'all') {
    sql += ' AND status = ?';
    params.push(status);
  }

  if (difficulty) {
    sql += ' AND difficulty = ?';
    params.push(difficulty);
  }

  if (min_reward) {
    sql += ' AND reward >= ?';
    params.push(parseInt(min_reward));
  }

  const sortMap = {
    roi_score: 'roi_score DESC, reward DESC',
    reward: 'reward DESC',
    newest: 'created_at DESC',
    easiest: "CASE difficulty WHEN 'easy' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, reward DESC",
  };
  sql += ` ORDER BY ${sortMap[sort] || sortMap.roi_score} LIMIT ?`;
  params.push(parseInt(limit));

  const bounties = db.prepare(sql).all(...params).map(b => ({
    ...b,
    labels: JSON.parse(b.labels || '[]'),
    skills: JSON.parse(b.skills || '[]'),
  }));

  res.json(bounties);
});

// GET /api/bounties/stats — dashboard stats
router.get('/stats', (req, res) => {
  res.json(getBountyStats());
});

// GET /api/bounties/top — highest ROI bounties
router.get('/top', (req, res) => {
  res.json(getTopBounties(parseInt(req.query.limit) || 20));
});

// GET /api/bounties/quick-wins — easy bounties with best payouts
router.get('/quick-wins', (req, res) => {
  res.json(getQuickWins(parseInt(req.query.limit) || 10));
});

// POST /api/bounties/refresh — trigger scrape
router.post('/refresh', async (req, res) => {
  try {
    const result = await scrapeAllBounties();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bounties/:id/claim — mark as claimed (you're working on it)
router.post('/:id/claim', (req, res) => {
  claimBounty(req.params.id);
  res.json({ success: true });
});

// POST /api/bounties/:id/submit — mark PR submitted
router.post('/:id/submit', (req, res) => {
  submitBounty(req.params.id);
  res.json({ success: true });
});

// POST /api/bounties/:id/complete — mark completed
router.post('/:id/complete', (req, res) => {
  completeBounty(req.params.id);
  res.json({ success: true });
});

// POST /api/bounties/:id/paid — mark payout received
router.post('/:id/paid', (req, res) => {
  markPaid(req.params.id);
  res.json({ success: true });
});

// POST /api/bounties/:id/dismiss — hide bounty
router.post('/:id/dismiss', (req, res) => {
  dismissBounty(req.params.id);
  res.json({ success: true });
});

// POST /api/bounties/solve — trigger auto-solver
router.post('/solve', async (req, res) => {
  try {
    const result = await runAutoSolver();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bounties/blitz — rapid-fire easy bounties
router.post('/blitz', async (req, res) => {
  try {
    const result = await runBlitzSolver();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/bounties/:id — update notes
router.patch('/:id', (req, res) => {
  const { notes } = req.body;
  if (notes !== undefined) {
    db.prepare("UPDATE bounties SET notes = ?, updated_at = datetime('now') WHERE id = ?").run(notes, req.params.id);
  }
  res.json({ success: true });
});

export default router;

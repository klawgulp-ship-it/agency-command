import { Router } from 'express';
import db from '../db/connection.js';
import { scoreJob } from '../services/scorer.js';
import { scrapeAllFeeds, scrapeFeed } from '../services/feedScraper.js';
import { v4 as uuid } from 'uuid';

const router = Router();

// GET /api/jobs — list all jobs, sorted by score
router.get('/', (req, res) => {
  const { source, minScore, limit, dismissed } = req.query;
  let sql = 'SELECT * FROM jobs WHERE 1=1';
  const params = [];

  if (dismissed !== 'true') {
    sql += ' AND dismissed = 0';
  }
  if (source && source !== 'all') {
    sql += ' AND LOWER(source) = ?';
    params.push(source.toLowerCase());
  }
  if (minScore) {
    sql += ' AND score >= ?';
    params.push(parseInt(minScore));
  }

  sql += ' ORDER BY score DESC, created_at DESC';

  if (limit) {
    sql += ' LIMIT ?';
    params.push(parseInt(limit));
  }

  const jobs = db.prepare(sql).all(...params);
  // Parse skills JSON
  const parsed = jobs.map(j => ({ ...j, skills: JSON.parse(j.skills || '[]') }));
  res.json(parsed);
});

// POST /api/jobs — add a job manually
router.post('/', (req, res) => {
  const { title, source, client, budget, description, url, skills, est_value, est_time } = req.body;
  const job = { title, source: source || 'Manual', client, budget, description, url, skills: JSON.stringify(skills || []), est_value: est_value || 0, est_time: est_time || '', posted_at: 'just now' };
  job.score = scoreJob(job);
  const id = uuid();
  db.prepare(`
    INSERT INTO jobs (id, title, source, client, budget, description, url, skills, score, est_value, est_time, posted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, job.title, job.source, job.client, job.budget, job.description, job.url, job.skills, job.score, job.est_value, job.est_time, job.posted_at);
  res.json({ id, ...job, skills: skills || [] });
});

// POST /api/jobs/:id/dismiss
router.post('/:id/dismiss', (req, res) => {
  db.prepare('UPDATE jobs SET dismissed = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// POST /api/jobs/refresh — scrape all active feeds
router.post('/refresh', async (req, res) => {
  const results = await scrapeAllFeeds();
  res.json({ results });
});

// POST /api/jobs/scrape — scrape a single URL
router.post('/scrape', async (req, res) => {
  const { url, source } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  const result = await scrapeFeed(url, source || 'Custom');
  res.json(result);
});

// POST /api/jobs/:id/rescore
router.post('/:id/rescore', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const newScore = scoreJob(job);
  db.prepare('UPDATE jobs SET score = ? WHERE id = ?').run(newScore, req.params.id);
  res.json({ id: req.params.id, score: newScore });
});

export default router;

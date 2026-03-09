import { Router } from 'express';
import db from '../db/connection.js';
import { v4 as uuid } from 'uuid';

const router = Router();

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM feeds ORDER BY created_at DESC').all());
});

router.post('/', (req, res) => {
  const { url, source } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const id = uuid();
  db.prepare('INSERT INTO feeds (id, url, source) VALUES (?, ?, ?)').run(id, url, source || 'Custom');
  res.json({ id, url, source: source || 'Custom' });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM feeds WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

export default router;

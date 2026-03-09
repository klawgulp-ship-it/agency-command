import { Router } from 'express';
import db from '../db/connection.js';
import { v4 as uuid } from 'uuid';

const router = Router();

router.get('/', (req, res) => {
  const { stage } = req.query;
  let sql = 'SELECT * FROM clients';
  const params = [];
  if (stage) {
    sql += ' WHERE stage = ?';
    params.push(stage);
  }
  sql += ' ORDER BY updated_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(client);
});

router.post('/', (req, res) => {
  const { name, project, stage, budget, requirements, proposal, template, notes, job_id } = req.body;
  const id = uuid();
  db.prepare(`
    INSERT INTO clients (id, name, project, stage, budget, requirements, proposal, template, notes, job_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, project || '', stage || 'lead', budget || 0, requirements || '', proposal || '', template || null, notes || '', job_id || null);
  res.json({ id, name, project, stage: stage || 'lead', budget: budget || 0 });
});

router.patch('/:id', (req, res) => {
  const allowed = ['name', 'project', 'stage', 'budget', 'deposit', 'final_payment', 'requirements', 'proposal', 'template', 'notes'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(req.body[key]);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  sets.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  const updated = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

export default router;

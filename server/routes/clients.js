import { Router } from 'express';
import db from '../db/connection.js';
import { v4 as uuid } from 'uuid';
import { generatePortalToken } from './portal.js';
import { generatePaymentLink } from '../services/payments.js';
import { notify } from '../services/notifications.js';

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

// POST /:id/portal — generate portal token for existing client
router.post('/:id/portal', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const token = client.portal_token || generatePortalToken(client.id);
  const portalUrl = `${req.protocol}://${req.get('host')}/api/portal/page/${token}`;
  res.json({ token, portal_url: portalUrl });
});

// POST /:id/invoice — generate invoice for a client
router.post('/:id/invoice', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { type, amount, note } = req.body;
  if (!amount) return res.status(400).json({ error: 'amount required' });

  const invoiceId = uuid();
  const invoiceType = type || 'deposit';
  const invoiceNote = note || `${invoiceType.charAt(0).toUpperCase() + invoiceType.slice(1)} for ${client.project || 'project'}`;

  const invoice = {
    id: invoiceId,
    client_id: client.id,
    client_name: client.name,
    project: client.project || 'Project',
    type: invoiceType,
    amount: parseInt(amount),
    note: invoiceNote,
  };
  invoice.payment_link = generatePaymentLink(invoice);

  db.prepare(`
    INSERT INTO invoices (id, client_id, client_name, project, type, amount, note, payment_link)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(invoiceId, client.id, client.name, invoice.project, invoiceType, invoice.amount, invoiceNote, invoice.payment_link);

  notify(
    'invoice_created',
    `Invoice created: ${client.name}`,
    `$${invoice.amount} ${invoiceType} invoice for ${client.project}`,
    { clientId: client.id, invoiceId, amount: invoice.amount },
    ''
  );

  res.json(invoice);
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

export default router;

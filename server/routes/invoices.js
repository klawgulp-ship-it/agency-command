import { Router } from 'express';
import db from '../db/connection.js';
import { v4 as uuid } from 'uuid';
import { generatePaymentLink, getOverdueInvoices } from '../services/payments.js';

const router = Router();

router.get('/', (req, res) => {
  const { status, client_id } = req.query;
  let sql = 'SELECT * FROM invoices WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (client_id) { sql += ' AND client_id = ?'; params.push(client_id); }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.post('/', (req, res) => {
  const { client_id, client_name, project, type, amount, note } = req.body;
  if (!client_id || !amount) return res.status(400).json({ error: 'client_id and amount required' });
  const id = uuid();
  const invoice = { id, client_id, client_name: client_name || '', project: project || '', type: type || 'deposit', amount: parseInt(amount), note: note || '' };
  invoice.payment_link = generatePaymentLink(invoice);
  db.prepare(`
    INSERT INTO invoices (id, client_id, client_name, project, type, amount, note, payment_link)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, invoice.client_id, invoice.client_name, invoice.project, invoice.type, invoice.amount, invoice.note, invoice.payment_link);
  res.json(invoice);
});

router.patch('/:id/pay', (req, res) => {
  db.prepare("UPDATE invoices SET status = 'paid', paid_at = datetime('now') WHERE id = ?").run(req.params.id);
  // Also update client deposit/final_payment
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (inv) {
    const field = inv.type === 'deposit' ? 'deposit' : 'final_payment';
    db.prepare(`UPDATE clients SET ${field} = ${field} + ?, updated_at = datetime('now') WHERE id = ?`).run(inv.amount, inv.client_id);
  }
  res.json({ success: true });
});

router.get('/overdue', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  res.json(getOverdueInvoices(days));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM invoices WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

export default router;

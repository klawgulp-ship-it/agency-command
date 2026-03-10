import { Router } from 'express';
import crypto from 'crypto';
import db from '../db/connection.js';
import { notify } from '../services/notifications.js';

const router = Router();

// POST /api/webhooks/snipelink — SnipeLink payment webhook
// Verifies signature, marks invoice paid, updates client balance, notifies
router.post('/snipelink', (req, res) => {
  const secret = process.env.SNIPELINK_WEBHOOK_SECRET;

  // Verify signature if secret is configured
  if (secret) {
    const signature = req.headers['x-snipelink-signature'];
    const expected = 'sha256=' + crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (signature !== expected) {
      console.error('[WEBHOOK] SnipeLink signature mismatch');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const event = req.body;
  if (event.event !== 'payment.completed') {
    return res.json({ received: true, skipped: true });
  }

  const { payment_id, customer_email, customer_name, amount, net_amount } = event;

  // Find matching invoice by payment_id (idempotent) or by customer email + amount
  let invoice = db.prepare(
    "SELECT * FROM invoices WHERE status = 'pending' AND payment_ref = ?"
  ).get(payment_id);

  // Fallback: match by email in client notes + amount
  if (!invoice && customer_email) {
    const clients = db.prepare(
      "SELECT id FROM clients WHERE notes LIKE ?"
    ).all(`%${customer_email}%`);

    for (const client of clients) {
      invoice = db.prepare(
        "SELECT * FROM invoices WHERE client_id = ? AND status = 'pending' AND amount = ? LIMIT 1"
      ).get(client.id, Math.round(amount));
      if (invoice) break;
    }
  }

  if (!invoice) {
    console.log(`[WEBHOOK] No matching invoice for payment ${payment_id} — $${amount} from ${customer_email}`);
    return res.json({ received: true, matched: false });
  }

  // Mark invoice paid
  db.prepare(
    "UPDATE invoices SET status = 'paid', paid_at = datetime('now'), payment_ref = ? WHERE id = ?"
  ).run(payment_id, invoice.id);

  // Update client deposit/final_payment balance
  const field = invoice.type === 'deposit' ? 'deposit' : 'final_payment';
  db.prepare(
    `UPDATE clients SET ${field} = ${field} + ?, updated_at = datetime('now') WHERE id = ?`
  ).run(invoice.amount, invoice.client_id);

  // Auto-advance client stage on deposit payment
  if (invoice.type === 'deposit') {
    db.prepare(
      "UPDATE clients SET stage = 'in_progress', updated_at = datetime('now') WHERE id = ? AND stage IN ('lead', 'accepted')"
    ).run(invoice.client_id);
  }

  // Fire notification
  notify(
    'payment_received',
    `Payment received: $${amount}`,
    `${customer_name || invoice.client_name} paid $${amount} for ${invoice.project} (${invoice.type}). Net: $${net_amount || amount}.`,
    { invoiceId: invoice.id, clientId: invoice.client_id, paymentId: payment_id, amount },
    ''
  );

  console.log(`[WEBHOOK] Invoice ${invoice.id} marked paid — $${amount} from ${customer_name || customer_email}`);

  res.json({ received: true, matched: true, invoice_id: invoice.id });
});

export default router;

import db from '../db/connection.js';

function getSnipeLinkBase() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'snipelink_base'").get();
  return row?.value || 'https://snipelink.io/pay/';
}

export function generatePaymentLink(invoice) {
  const base = getSnipeLinkBase();
  // Generate a unique payment reference and store it for webhook matching
  const ref = `${invoice.client_id.slice(0, 8)}-${Date.now().toString(36)}`;
  // Save payment_ref on the invoice for webhook lookup
  db.prepare("UPDATE invoices SET payment_ref = ? WHERE id = ?").run(ref, invoice.id);
  return `${base}${ref}?amount=${invoice.amount}&project=${encodeURIComponent(invoice.project)}&type=${invoice.type}`;
}

export function getOverdueInvoices(daysThreshold = 7) {
  return db.prepare(`
    SELECT * FROM invoices
    WHERE status = 'pending'
    AND datetime(created_at, '+' || ? || ' days') < datetime('now')
    AND (reminder_sent_at IS NULL OR datetime(reminder_sent_at, '+3 days') < datetime('now'))
  `).all(daysThreshold);
}

export function markReminderSent(invoiceId) {
  db.prepare("UPDATE invoices SET reminder_sent_at = datetime('now') WHERE id = ?").run(invoiceId);
}

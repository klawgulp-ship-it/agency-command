import { Router } from 'express';
import db from '../db/connection.js';
import crypto from 'crypto';

const router = Router();

// Generate portal token for a client
export function generatePortalToken(clientId) {
  const token = crypto.randomBytes(16).toString('hex');
  db.prepare("UPDATE clients SET portal_token = ? WHERE id = ?").run(token, clientId);
  return token;
}

// GET /api/portal/:token — public client portal data
router.get('/:token', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const client = db.prepare('SELECT * FROM clients WHERE portal_token = ?').get(req.params.token);
  if (!client || !client.portal_token) return res.status(404).json({ error: 'Project not found' });

  const invoices = db.prepare('SELECT * FROM invoices WHERE client_id = ? ORDER BY created_at DESC').all(client.id);

  res.json({
    name: client.name,
    project: client.project,
    stage: client.stage,
    budget: client.budget,
    deposit: client.deposit,
    final_payment: client.final_payment,
    requirements: client.requirements,
    proposal: client.proposal,
    created_at: client.created_at,
    updated_at: client.updated_at,
    invoices: invoices.map(inv => ({
      id: inv.id,
      type: inv.type,
      amount: inv.amount,
      status: inv.status,
      payment_link: inv.payment_link,
      note: inv.note,
      paid_at: inv.paid_at,
      created_at: inv.created_at,
    })),
  });
});

// POST /api/portal/lookup — find portal by email
router.post('/lookup', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  // Find client by email in notes (where we store "Email: xxx")
  const clients = db.prepare("SELECT * FROM clients WHERE notes LIKE ? AND portal_token != '' ORDER BY created_at DESC").all(`%Email: ${email}%`);
  if (clients.length === 0) return res.status(404).json({ error: 'No projects found for that email.' });

  const results = clients.map(c => ({
    project: c.project,
    stage: c.stage,
    portal_url: `${req.protocol}://${req.get('host')}/api/portal/page/${c.portal_token}`,
    created_at: c.created_at,
  }));

  res.json({ projects: results });
});

// CORS preflight for lookup
router.options('/lookup', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// CORS preflight
router.options('/:token', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// GET /api/portal/page/:token — serve the portal HTML page
router.get('/page/:token', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE portal_token = ?').get(req.params.token);
  if (!client || !client.portal_token) return res.status(404).send('Project not found');

  const invoices = db.prepare('SELECT * FROM invoices WHERE client_id = ? ORDER BY created_at DESC').all(client.id);

  const stages = [
    { id: 'lead', label: 'Inquiry Received' },
    { id: 'proposal_sent', label: 'Proposal Sent' },
    { id: 'accepted', label: 'Accepted' },
    { id: 'deposit_paid', label: 'Deposit Paid' },
    { id: 'building', label: 'Building' },
    { id: 'delivered', label: 'Delivered' },
    { id: 'final_payment', label: 'Complete' },
  ];
  const currentIdx = stages.findIndex(s => s.id === client.stage);

  const stageHTML = stages.map((s, i) => {
    const done = i <= currentIdx;
    const active = i === currentIdx;
    return `<div style="display:flex;align-items:center;gap:10px;padding:10px 0;${active ? 'color:#C8FF32;font-weight:700;' : done ? 'color:#8B8B93;' : 'color:#3A3A42;'}">
      <div style="width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;
        ${active ? 'background:#C8FF32;color:#000;box-shadow:0 0 15px rgba(200,255,50,0.3);' : done ? 'background:#1E1E22;border:2px solid #4A4A52;color:#8B8B93;' : 'background:#111113;border:2px solid #1E1E22;color:#3A3A42;'}">
        ${done && !active ? '&#10003;' : i + 1}
      </div>
      <span style="font-size:14px;">${s.label}</span>
    </div>`;
  }).join('');

  const invoiceHTML = invoices.map(inv => {
    const isPaid = inv.status === 'paid';
    return `<div style="background:#111113;border:1px solid #1E1E22;border-radius:10px;padding:16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
      <div>
        <div style="font-size:14px;font-weight:600;color:#E0E0E4;text-transform:capitalize;">${inv.type} Invoice</div>
        <div style="font-size:12px;color:#6B6B73;margin-top:2px;">${inv.note || ''}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:20px;font-weight:800;color:${isPaid ? '#10B981' : '#C8FF32'};font-family:'JetBrains Mono',monospace;">$${inv.amount.toLocaleString()}</div>
        ${isPaid
          ? `<div style="font-size:11px;color:#10B981;font-weight:600;margin-top:4px;">PAID &#10003;</div>`
          : `<a href="${inv.payment_link}" target="_blank" style="display:inline-block;margin-top:6px;padding:8px 20px;background:#C8FF32;color:#000;font-weight:700;font-size:13px;border-radius:6px;text-decoration:none;transition:all 0.2s;">Pay Now</a>`
        }
      </div>
    </div>`;
  }).join('');

  const totalPaid = (client.deposit || 0) + (client.final_payment || 0);
  const remaining = Math.max(0, (client.budget || 0) - totalPaid);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${client.project} — Project Portal | SnipeLink LLC</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Inter', sans-serif; background: #0A0A0B; color: #E0E0E4; line-height: 1.6; padding: 24px; }
.container { max-width: 600px; margin: 0 auto; }
h1 { font-size: 24px; font-weight: 800; letter-spacing: -0.5px; margin-bottom: 4px; }
.subtitle { font-size: 14px; color: #6B6B73; margin-bottom: 32px; }
.section { margin-bottom: 32px; }
.section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; color: #C8FF32; margin-bottom: 12px; }
.card { background: #111113; border: 1px solid #1E1E22; border-radius: 12px; padding: 20px; }
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 24px; }
.stat { background: #111113; border: 1px solid #1E1E22; border-radius: 10px; padding: 16px; text-align: center; }
.stat-value { font-size: 22px; font-weight: 800; font-family: 'JetBrains Mono', monospace; color: #C8FF32; }
.stat-label { font-size: 11px; color: #6B6B73; margin-top: 4px; text-transform: uppercase; }
.invoices { display: flex; flex-direction: column; gap: 10px; }
.logo { font-size: 16px; font-weight: 800; margin-bottom: 24px; }
.logo span { color: #C8FF32; }
.proposal { background: #111113; border: 1px solid #1E1E22; border-radius: 10px; padding: 16px; font-size: 14px; color: #A0A0A8; line-height: 1.7; white-space: pre-wrap; }
@media (max-width: 480px) { .stats { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="container">
  <div class="logo">Snipe<span>Link</span> LLC</div>
  <h1>${client.project}</h1>
  <div class="subtitle">Project portal for ${client.name}</div>

  <div class="stats">
    <div class="stat"><div class="stat-value">$${(client.budget || 0).toLocaleString()}</div><div class="stat-label">Total Budget</div></div>
    <div class="stat"><div class="stat-value" style="color:#10B981;">$${totalPaid.toLocaleString()}</div><div class="stat-label">Paid</div></div>
    <div class="stat"><div class="stat-value" style="color:${remaining > 0 ? '#F59E0B' : '#10B981'};">$${remaining.toLocaleString()}</div><div class="stat-label">Remaining</div></div>
  </div>

  <div class="section">
    <div class="section-title">Project Progress</div>
    <div class="card">${stageHTML}</div>
  </div>

  ${client.proposal ? `<div class="section">
    <div class="section-title">Proposal</div>
    <div class="proposal">${client.proposal}</div>
  </div>` : ''}

  ${invoices.length > 0 ? `<div class="section">
    <div class="section-title">Invoices</div>
    <div class="invoices">${invoiceHTML}</div>
  </div>` : ''}

  <div style="text-align:center;padding:24px 0;font-size:12px;color:#3A3A42;">
    SnipeLink LLC — <a href="mailto:Hello@snipelink.com" style="color:#6B6B73;">Hello@snipelink.com</a>
  </div>
</div>
</body>
</html>`);
});

export default router;

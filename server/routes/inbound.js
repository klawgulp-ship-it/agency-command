import { Router } from 'express';
import db from '../db/connection.js';
import { v4 as uuid } from 'uuid';
import { notify } from '../services/notifications.js';
import { generatePaymentLink } from '../services/payments.js';

const router = Router();

// Budget string to number mapping
const BUDGET_MAP = {
  '$500 - $1,500': 1000,
  '$1,500 - $3,000': 2250,
  '$3,000 - $5,000': 4000,
  '$5,000 - $10,000': 7500,
  '$10,000+': 12000,
};

// POST /api/inbound/lead — public endpoint for portfolio site
// Creates lead → auto-quotes → auto-generates deposit invoice → notifies you
router.post('/lead', async (req, res) => {
  // Allow CORS from portfolio site
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { name, email, project_type, budget, description, ref } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });

  const clientId = uuid();
  const budgetValue = BUDGET_MAP[budget] || 2000;
  const depositAmount = Math.round(budgetValue * 0.5);

  // Look up referrer if ref code provided
  let referrer = null;
  if (ref) {
    referrer = db.prepare('SELECT * FROM referrers WHERE code = ?').get(ref);
  }

  // Create client in pipeline as "lead"
  const source = referrer ? `Portfolio Site (ref: ${ref})` : 'Portfolio Site';
  db.prepare(`
    INSERT INTO clients (id, name, project, stage, budget, requirements, notes, referrer_code, created_at, updated_at)
    VALUES (?, ?, ?, 'lead', ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    clientId,
    name,
    project_type || 'Project',
    budgetValue,
    description || '',
    `Email: ${email}\nBudget: ${budget}\nProject Type: ${project_type}\nSource: ${source}`,
    ref || ''
  );

  // Track referral conversion
  if (referrer) {
    db.prepare('UPDATE referrers SET total_referrals = total_referrals + 1 WHERE id = ?').run(referrer.id);
    db.prepare(`
      INSERT INTO referral_events (id, referrer_id, type, client_id, note)
      VALUES (?, ?, 'referral', ?, ?)
    `).run(uuid(), referrer.id, clientId, `Referred ${name} — ${project_type} — ${budget}`);
  }

  // Auto-generate deposit invoice with SnipeLink
  const invoiceId = uuid();
  const invoice = {
    id: invoiceId,
    client_id: clientId,
    client_name: name,
    project: project_type || 'Project',
    type: 'deposit',
    amount: depositAmount,
    note: `50% deposit for ${project_type || 'project'}. Auto-generated from portfolio inquiry.`,
  };
  invoice.payment_link = generatePaymentLink(invoice);

  db.prepare(`
    INSERT INTO invoices (id, client_id, client_name, project, type, amount, note, payment_link)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(invoiceId, clientId, name, invoice.project, 'deposit', depositAmount, invoice.note, invoice.payment_link);

  // Auto-generate quote/response with Claude if API key is set
  let quote = '';
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 600,
          messages: [{
            role: 'user',
            content: `Generate a brief, professional project quote/response for a client inquiry.

CLIENT: ${name} (${email})
PROJECT TYPE: ${project_type}
BUDGET: ${budget}
DESCRIPTION: ${description}

Write a 3-4 paragraph response that:
1. Acknowledges their project specifically
2. Confirms you can deliver it within their budget
3. Gives a rough timeline (be aggressive — you use AI-assisted development)
4. Mentions the 50/50 payment structure (50% deposit to start, 50% on delivery)
5. Ends with next steps (you'll follow up within 24h)

Keep it under 200 words. Professional but human. Sign off as "SnipeLink LLC".`
          }],
        }),
      });
      const data = await response.json();
      quote = data.content?.[0]?.text || '';

      // Save quote as proposal on the client
      if (quote) {
        db.prepare("UPDATE clients SET proposal = ?, updated_at = datetime('now') WHERE id = ?").run(quote, clientId);
      }
    } catch (e) {
      console.error('[INBOUND] Quote generation failed:', e.message);
    }
  }

  // Fire notification
  notify(
    'new_lead',
    `New lead: ${name}`,
    `${project_type} | Budget: ${budget} | ${email}. Quote + invoice auto-generated.`,
    { clientId, invoiceId, email, budget: budgetValue, projectType: project_type },
    ''
  );

  console.log(`[INBOUND] New lead: ${name} (${email}) — ${project_type} — ${budget}`);

  res.json({
    success: true,
    message: `Thanks ${name}! I'll review your project and get back to you within 24 hours.`,
    quote: quote || null,
  });
});

// CORS preflight
router.options('/lead', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

export default router;

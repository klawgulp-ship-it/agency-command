import db from '../db/connection.js';
import { notify } from './notifications.js';
import { v4 as uuid } from 'uuid';

const SNIPELINK_URL = 'https://snipelink.com';
const PORTFOLIO_URL = 'https://klawgulp-ship-it.github.io';

// ── DB Setup ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS tool_usage (
    id TEXT PRIMARY KEY,
    tool_name TEXT NOT NULL,
    input_preview TEXT DEFAULT '',
    paid INTEGER DEFAULT 0,
    amount REAL DEFAULT 0,
    payment_ref TEXT DEFAULT '',
    ip_address TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── Tool Catalog ────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    slug: 'readme-generator',
    name: 'README Generator',
    description: 'Generate a professional README.md from a GitHub repo URL.',
    price: 2,
    input_fields: ['repo_url'],
    preview_chars: 500,
  },
  {
    slug: 'pr-description',
    name: 'PR Description Writer',
    description: 'Generate a professional PR description with summary, changes, and test plan.',
    price: 1,
    input_fields: ['diff'],
    preview_chars: 400,
  },
  {
    slug: 'code-review',
    name: 'Code Review',
    description: 'Detailed code review with issues, suggestions, and security concerns.',
    price: 3,
    input_fields: ['code'],
    preview_chars: 600,
  },
  {
    slug: 'api-docs',
    name: 'API Docs Generator',
    description: 'Generate OpenAPI/Swagger documentation from Express or FastAPI route code.',
    price: 2,
    input_fields: ['code'],
    preview_chars: 500,
  },
  {
    slug: 'convert-to-typescript',
    name: 'JS → TypeScript Converter',
    description: 'Convert JavaScript code to TypeScript with proper types.',
    price: 2,
    input_fields: ['code'],
    preview_chars: 500,
  },
  {
    slug: 'landing-page',
    name: 'Landing Page Generator',
    description: 'Generate a complete HTML/CSS landing page from a product description.',
    price: 5,
    input_fields: ['product_name', 'description', 'features'],
    preview_chars: 800,
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────────

function logUsage(toolName, inputPreview, paid, amount, paymentRef = '', ipAddress = '') {
  try {
    db.prepare(`
      INSERT INTO tool_usage (id, tool_name, input_preview, paid, amount, payment_ref, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuid(), toolName, (inputPreview || '').slice(0, 200), paid ? 1 : 0, amount, paymentRef, ipAddress);
  } catch (e) {
    console.error('[microSaaS] logUsage error:', e.message);
  }
}

async function createCheckout(toolName, amount, metadata) {
  const apiKey = process.env.SNIPELINK_API_KEY;
  const productId = process.env.SNIPELINK_PRODUCT_ID;
  if (!apiKey || !productId) {
    return `${SNIPELINK_URL}/@agencycommand/tools`;
  }

  try {
    const res = await fetch(`${SNIPELINK_URL}/api/agent/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        productId,
        amount,
        metadata: JSON.stringify(metadata),
      }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return data.checkoutUrl || `${SNIPELINK_URL}/@agencycommand/tools`;
  } catch {
    return `${SNIPELINK_URL}/@agencycommand/tools`;
  }
}

async function askClaude(prompt, maxTokens = 4096, model = 'claude-haiku-4-5-20251001') {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(60000),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.map(c => c.text || '').join('\n') || '';
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
}

function truncatePreview(text, chars) {
  if (text.length <= chars) return text;
  return text.slice(0, chars) + '\n\n--- FULL VERSION AVAILABLE ---';
}

// ── Tool Prompts ────────────────────────────────────────────────────────────────

const TOOL_PROMPTS = {
  'readme-generator': (input) => `Generate a professional, comprehensive README.md for this GitHub repository.
Repository URL: ${input.repo_url}

Include:
- Project title and badges
- Clear description
- Features list
- Installation instructions
- Usage examples with code blocks
- Configuration section
- Contributing guidelines
- License section

Use clean markdown formatting. Make it look professional and complete.`,

  'pr-description': (input) => `Generate a professional pull request description from the following diff/changes.

${input.diff}

Format the output as:
## Summary
Brief 1-2 sentence overview of what this PR does.

## Changes
- Bulleted list of specific changes

## Test Plan
- Steps to verify the changes work correctly

## Notes
Any additional context or considerations.

Be concise but thorough.`,

  'code-review': (input) => `Perform a thorough code review of the following code. Be specific and actionable.

\`\`\`
${input.code}
\`\`\`

Structure your review as:

## Overview
Brief assessment of code quality.

## Issues Found
List each issue with:
- **Severity** (Critical/Warning/Info)
- **Line/Area**: Where the issue is
- **Problem**: What's wrong
- **Fix**: How to fix it

## Security Concerns
Any security issues or vulnerabilities.

## Suggestions
Improvements for readability, performance, or maintainability.

## Score
Rate the code X/10 with justification.`,

  'api-docs': (input) => `Generate OpenAPI 3.0 / Swagger documentation in YAML format for the following API route code.

\`\`\`
${input.code}
\`\`\`

Include:
- Path and HTTP method
- Summary and description
- Request parameters (path, query, header)
- Request body schema with examples
- Response schemas for success and error cases
- Authentication requirements if apparent

Output valid OpenAPI 3.0 YAML.`,

  'convert-to-typescript': (input) => `Convert the following JavaScript code to TypeScript with proper type annotations.

\`\`\`javascript
${input.code}
\`\`\`

Requirements:
- Add explicit type annotations for all function parameters and return types
- Create interfaces/types for object shapes
- Use proper generics where applicable
- Add JSDoc comments for complex types
- Use strict mode compatible types (no implicit any)
- Preserve all existing functionality exactly

Output only the converted TypeScript code.`,

  'landing-page': (input) => `Generate a complete, modern, responsive landing page in a single HTML file with embedded CSS.

Product Name: ${input.product_name}
Description: ${input.description}
Features: ${Array.isArray(input.features) ? input.features.join(', ') : input.features}

Requirements:
- Modern design with CSS variables for theming
- Responsive (mobile-first)
- Hero section with CTA
- Features grid
- Pricing or value proposition section
- Footer with links
- Smooth scroll and subtle animations (CSS only, no JS frameworks)
- Professional color scheme
- Clean typography (use system fonts or Google Fonts link)
- All CSS embedded in <style> tags (single file, no external dependencies)

Make it production-ready and visually impressive.`,
};

// ── Tool Input Validators ───────────────────────────────────────────────────────

const TOOL_VALIDATORS = {
  'readme-generator': (body) => {
    if (!body.repo_url) return 'repo_url is required';
    if (typeof body.repo_url !== 'string') return 'repo_url must be a string';
    if (!body.repo_url.match(/^https?:\/\//)) return 'repo_url must be a valid URL';
    return null;
  },
  'pr-description': (body) => {
    if (!body.diff) return 'diff is required (diff text or PR URL)';
    if (typeof body.diff !== 'string') return 'diff must be a string';
    if (body.diff.length < 10) return 'diff is too short';
    return null;
  },
  'code-review': (body) => {
    if (!body.code) return 'code is required';
    if (typeof body.code !== 'string') return 'code must be a string';
    if (body.code.length < 10) return 'code is too short for meaningful review';
    return null;
  },
  'api-docs': (body) => {
    if (!body.code) return 'code is required (Express/FastAPI route code)';
    if (typeof body.code !== 'string') return 'code must be a string';
    return null;
  },
  'convert-to-typescript': (body) => {
    if (!body.code) return 'code is required (JavaScript source)';
    if (typeof body.code !== 'string') return 'code must be a string';
    return null;
  },
  'landing-page': (body) => {
    if (!body.product_name) return 'product_name is required';
    if (!body.description) return 'description is required';
    return null;
  },
};

// ── Route Setup ─────────────────────────────────────────────────────────────────

export function setupToolRoutes(app) {
  // ── JSON Catalog ────────────────────────────────────────────────────────
  app.get('/api/tools', (_req, res) => {
    const catalog = TOOLS.map(t => ({
      slug: t.slug,
      name: t.name,
      description: t.description,
      price: `$${t.price}`,
      endpoint: `/api/tools/${t.slug}`,
      method: 'POST',
      input_fields: t.input_fields,
    }));
    res.json({ success: true, tools: catalog, count: catalog.length });
  });

  // ── HTML Storefront ─────────────────────────────────────────────────────
  app.get('/tools', (_req, res) => {
    const toolCards = TOOLS.map(t => `
      <div class="tool-card">
        <h3>${t.name}</h3>
        <p>${t.description}</p>
        <div class="price">$${t.price}<span>/use</span></div>
        <div class="fields">Input: <code>${t.input_fields.join(', ')}</code></div>
        <div class="endpoint"><code>POST /api/tools/${t.slug}</code></div>
        <a href="#try-${t.slug}" class="btn" onclick="toggleTry('${t.slug}')">Try it</a>
        <div id="try-${t.slug}" class="try-panel" style="display:none">
          <textarea id="input-${t.slug}" placeholder="Paste your input here..." rows="4"></textarea>
          <button onclick="tryTool('${t.slug}', '${t.input_fields[0]}')">Generate Preview (Free)</button>
          <pre id="output-${t.slug}"></pre>
        </div>
      </div>
    `).join('');

    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dev Tools by SnipeLink LLC</title>
  <style>
    :root { --bg: #0a0a0a; --card: #141414; --accent: #00d4ff; --text: #e0e0e0; --muted: #888; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
    .hero { text-align: center; padding: 4rem 1rem 2rem; }
    .hero h1 { font-size: 2.5rem; color: var(--accent); margin-bottom: 0.5rem; }
    .hero p { color: var(--muted); font-size: 1.1rem; max-width: 600px; margin: 0 auto; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 1.5rem; padding: 2rem; max-width: 1200px; margin: 0 auto; }
    .tool-card { background: var(--card); border: 1px solid #222; border-radius: 12px; padding: 1.5rem; transition: border-color 0.2s; }
    .tool-card:hover { border-color: var(--accent); }
    .tool-card h3 { color: var(--accent); margin-bottom: 0.5rem; }
    .tool-card p { color: var(--muted); font-size: 0.95rem; margin-bottom: 1rem; }
    .price { font-size: 1.8rem; font-weight: 700; color: #fff; }
    .price span { font-size: 0.9rem; color: var(--muted); font-weight: 400; }
    .fields, .endpoint { font-size: 0.85rem; color: var(--muted); margin-top: 0.5rem; }
    code { background: #1a1a2e; padding: 2px 6px; border-radius: 4px; font-size: 0.85rem; }
    .btn { display: inline-block; margin-top: 1rem; padding: 0.5rem 1.2rem; background: var(--accent); color: #000; text-decoration: none; border-radius: 6px; font-weight: 600; cursor: pointer; border: none; font-size: 0.95rem; }
    .btn:hover { opacity: 0.85; }
    .try-panel { margin-top: 1rem; }
    .try-panel textarea { width: 100%; background: #1a1a1a; border: 1px solid #333; color: var(--text); padding: 0.75rem; border-radius: 6px; resize: vertical; font-family: monospace; font-size: 0.9rem; }
    .try-panel button { margin-top: 0.5rem; padding: 0.4rem 1rem; background: #222; color: var(--accent); border: 1px solid var(--accent); border-radius: 6px; cursor: pointer; font-size: 0.9rem; }
    .try-panel button:hover { background: var(--accent); color: #000; }
    .try-panel pre { margin-top: 0.75rem; background: #0d0d0d; border: 1px solid #222; padding: 1rem; border-radius: 6px; white-space: pre-wrap; word-break: break-word; font-size: 0.85rem; max-height: 400px; overflow-y: auto; }
    footer { text-align: center; padding: 3rem 1rem; color: var(--muted); font-size: 0.85rem; }
    footer a { color: var(--accent); text-decoration: none; }
  </style>
</head>
<body>
  <div class="hero">
    <h1>Dev Tools</h1>
    <p>AI-powered developer micro-tools. Free preview, pay for full output. Every tool is an API call away.</p>
  </div>
  <div class="grid">${toolCards}</div>
  <footer>
    <p>Built by <a href="${PORTFOLIO_URL}">SnipeLink LLC</a> &middot; Payments via <a href="${SNIPELINK_URL}">SnipeLink</a></p>
  </footer>
  <script>
    function toggleTry(slug) {
      const el = document.getElementById('try-' + slug);
      el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }
    async function tryTool(slug, field) {
      const input = document.getElementById('input-' + slug).value;
      const output = document.getElementById('output-' + slug);
      if (!input.trim()) { output.textContent = 'Please enter input.'; return; }
      output.textContent = 'Generating...';
      try {
        const body = {};
        body[field] = input;
        const res = await fetch('/api/tools/' + slug, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (data.error) { output.textContent = 'Error: ' + data.error; return; }
        let text = data.preview || data.result || JSON.stringify(data, null, 2);
        if (data.checkout_url) text += '\\n\\nFull version: ' + data.checkout_url;
        output.textContent = text;
      } catch (e) { output.textContent = 'Request failed: ' + e.message; }
    }
  </script>
</body>
</html>`);
  });

  // ── Tool Endpoints ──────────────────────────────────────────────────────
  for (const tool of TOOLS) {
    app.post(`/api/tools/${tool.slug}`, async (req, res) => {
      const ip = getClientIp(req);

      try {
        // Validate input
        const validationError = TOOL_VALIDATORS[tool.slug]?.(req.body);
        if (validationError) {
          return res.status(400).json({ error: validationError });
        }

        // Build prompt and generate result
        const prompt = TOOL_PROMPTS[tool.slug](req.body);
        const result = await askClaude(prompt);

        // Check for payment token
        const paymentToken = req.headers['x-payment-token'];

        if (paymentToken) {
          // Paid request — return full output
          logUsage(tool.slug, JSON.stringify(req.body).slice(0, 200), true, tool.price, paymentToken, ip);

          notify(
            'micro-saas',
            `Paid use of ${tool.name}: $${tool.price}`,
            { tool: tool.slug, amount: tool.price },
          ).catch(() => {});

          return res.json({
            success: true,
            tool: tool.slug,
            result,
            paid: true,
          });
        }

        // Free request — return truncated preview + checkout link
        const preview = truncatePreview(result, tool.preview_chars);
        const checkoutUrl = await createCheckout(tool.slug, tool.price, {
          tool: tool.slug,
          input: JSON.stringify(req.body).slice(0, 100),
        });

        logUsage(tool.slug, JSON.stringify(req.body).slice(0, 200), false, 0, '', ip);

        return res.json({
          success: true,
          tool: tool.slug,
          preview,
          full_available: true,
          price: `$${tool.price}`,
          checkout_url: checkoutUrl,
          message: `Get the full output for $${tool.price}`,
        });
      } catch (err) {
        console.error(`[microSaaS] ${tool.slug} error:`, err.message);
        return res.status(500).json({ error: 'Tool processing failed. Try again.' });
      }
    });
  }

  console.log(`[microSaaS] ${TOOLS.length} tool routes mounted`);
}

// ── Stats & Revenue ─────────────────────────────────────────────────────────────

export function getToolStats() {
  try {
    const rows = db.prepare(`
      SELECT
        tool_name,
        COUNT(*) AS total_uses,
        SUM(CASE WHEN paid = 1 THEN 1 ELSE 0 END) AS paid_uses,
        SUM(CASE WHEN paid = 0 THEN 1 ELSE 0 END) AS free_uses,
        ROUND(SUM(amount), 2) AS revenue,
        MAX(created_at) AS last_used
      FROM tool_usage
      GROUP BY tool_name
      ORDER BY revenue DESC
    `).all();

    return {
      tools: rows,
      total_uses: rows.reduce((s, r) => s + r.total_uses, 0),
      total_paid: rows.reduce((s, r) => s + r.paid_uses, 0),
      total_revenue: rows.reduce((s, r) => s + r.revenue, 0),
    };
  } catch {
    return { tools: [], total_uses: 0, total_paid: 0, total_revenue: 0 };
  }
}

export function getToolRevenue() {
  try {
    const row = db.prepare(`
      SELECT ROUND(SUM(amount), 2) AS total FROM tool_usage WHERE paid = 1
    `).get();
    return row?.total || 0;
  } catch {
    return 0;
  }
}

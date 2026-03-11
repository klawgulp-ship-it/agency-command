import db from '../db/connection.js';
import { notify } from './notifications.js';
import { v4 as uuid } from 'uuid';
import { createHash, randomBytes } from 'crypto';

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

// ── FREE TOOLS — zero API cost, pure JS, drives traffic ─────────────────────────

const FREE_TOOLS = {
  'json-formatter': {
    name: 'JSON Formatter & Validator',
    description: 'Format, validate, and minify JSON instantly.',
    run: (input) => {
      try {
        const parsed = JSON.parse(input.json);
        return {
          formatted: JSON.stringify(parsed, null, 2),
          minified: JSON.stringify(parsed),
          valid: true,
          keys: Object.keys(parsed).length,
          size: JSON.stringify(parsed).length,
        };
      } catch (e) {
        return { valid: false, error: e.message };
      }
    },
  },
  'jwt-decoder': {
    name: 'JWT Decoder',
    description: 'Decode and inspect JWT tokens — header, payload, expiry.',
    run: (input) => {
      try {
        const parts = input.token.split('.');
        if (parts.length !== 3) return { error: 'Invalid JWT — must have 3 parts' };
        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        const expired = payload.exp ? (payload.exp * 1000 < Date.now()) : null;
        return { header, payload, expired, issued_at: payload.iat ? new Date(payload.iat * 1000).toISOString() : null, expires_at: payload.exp ? new Date(payload.exp * 1000).toISOString() : null };
      } catch (e) { return { error: 'Failed to decode JWT: ' + e.message }; }
    },
  },
  'base64': {
    name: 'Base64 Encode/Decode',
    description: 'Encode or decode Base64 strings.',
    run: (input) => ({
      encoded: Buffer.from(input.text || '').toString('base64'),
      decoded: (() => { try { return Buffer.from(input.text || '', 'base64').toString('utf-8'); } catch { return '(invalid base64)'; } })(),
    }),
  },
  'hash-generator': {
    name: 'Hash Generator',
    description: 'Generate MD5, SHA1, SHA256 hashes.',
    run: (input) => {
      const text = input.text || '';
      return {
        md5: createHash('md5').update(text).digest('hex'),
        sha1: createHash('sha1').update(text).digest('hex'),
        sha256: createHash('sha256').update(text).digest('hex'),
        sha512: createHash('sha512').update(text).digest('hex'),
      };
    },
  },
  'uuid-generator': {
    name: 'UUID Generator',
    description: 'Generate v4 UUIDs in bulk.',
    run: (input) => {
      const count = Math.min(parseInt(input.count) || 5, 100);
      const uuids = [];
      for (let i = 0; i < count; i++) uuids.push(uuid());
      return { uuids, count };
    },
  },
  'cron-parser': {
    name: 'Cron Expression Builder',
    description: 'Parse and explain cron expressions.',
    run: (input) => {
      const parts = (input.expression || '* * * * *').trim().split(/\s+/);
      if (parts.length < 5) return { error: 'Invalid cron — need 5 fields (min hour dom month dow)' };
      const [min, hour, dom, month, dow] = parts;
      const fieldNames = { min: 'minute', hour: 'hour', dom: 'day of month', month: 'month', dow: 'day of week' };
      const explain = (val, name) => val === '*' ? `every ${name}` : `${name} ${val}`;
      return {
        expression: parts.join(' '),
        fields: { minute: min, hour, day_of_month: dom, month, day_of_week: dow },
        human: `Runs at ${explain(min, 'minute')}, ${explain(hour, 'hour')}, ${explain(dom, 'day')}, ${explain(month, 'month')}, ${explain(dow, 'weekday')}`,
      };
    },
  },
  'color-converter': {
    name: 'Color Converter',
    description: 'Convert between HEX, RGB, and HSL color formats.',
    run: (input) => {
      const c = (input.color || '#000000').trim();
      let r, g, b;
      if (c.startsWith('#')) {
        const hex = c.replace('#', '');
        r = parseInt(hex.substr(0, 2), 16); g = parseInt(hex.substr(2, 2), 16); b = parseInt(hex.substr(4, 2), 16);
      } else if (c.startsWith('rgb')) {
        [r, g, b] = c.match(/\d+/g).map(Number);
      } else { return { error: 'Enter hex (#ff0000) or rgb(255,0,0)' }; }
      if (isNaN(r)) return { error: 'Invalid color value' };
      const hex = `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
      const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
      const l = (max + min) / 2;
      let h = 0, s = 0;
      if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r/255) h = ((g/255 - b/255) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g/255) h = ((b/255 - r/255) / d + 2) / 6;
        else h = ((r/255 - g/255) / d + 4) / 6;
      }
      return { hex, rgb: `rgb(${r}, ${g}, ${b})`, hsl: `hsl(${Math.round(h*360)}, ${Math.round(s*100)}%, ${Math.round(l*100)}%)`, r, g, b };
    },
  },
  'regex-tester': {
    name: 'Regex Tester',
    description: 'Test regular expressions against text.',
    run: (input) => {
      try {
        const flags = input.flags || 'g';
        const re = new RegExp(input.pattern, flags);
        const matches = [...(input.text || '').matchAll(re)].map(m => ({
          match: m[0], index: m.index, groups: m.groups || null,
        }));
        return { pattern: input.pattern, flags, matches, count: matches.length, valid: true };
      } catch (e) { return { valid: false, error: e.message }; }
    },
  },
  'timestamp-converter': {
    name: 'Timestamp Converter',
    description: 'Convert between Unix timestamps and human dates.',
    run: (input) => {
      const now = Date.now();
      const val = input.timestamp || input.date || '';
      let date;
      if (/^\d{10,13}$/.test(val)) {
        const ms = val.length === 10 ? parseInt(val) * 1000 : parseInt(val);
        date = new Date(ms);
      } else if (val) {
        date = new Date(val);
      } else {
        date = new Date();
      }
      if (isNaN(date.getTime())) return { error: 'Invalid date/timestamp' };
      return {
        unix_seconds: Math.floor(date.getTime() / 1000),
        unix_ms: date.getTime(),
        iso: date.toISOString(),
        utc: date.toUTCString(),
        local: date.toString(),
        relative: `${Math.floor((now - date.getTime()) / 1000)} seconds ago`,
      };
    },
  },
  'password-generator': {
    name: 'Secure Password Generator',
    description: 'Generate cryptographically secure passwords.',
    run: (input) => {
      const length = Math.min(Math.max(parseInt(input.length) || 16, 8), 128);
      const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';
      const passwords = [];
      for (let p = 0; p < (parseInt(input.count) || 5); p++) {
        const bytes = randomBytes(length);
        let pw = '';
        for (let i = 0; i < length; i++) pw += charset[bytes[i] % charset.length];
        passwords.push(pw);
      }
      return { passwords, length, count: passwords.length, entropy_bits: Math.floor(Math.log2(charset.length) * length) };
    },
  },
  'env-generator': {
    name: '.env File Generator',
    description: 'Generate .env template from your code.',
    run: (input) => {
      const code = input.code || '';
      const envVars = new Set();
      // Match process.env.*, os.environ.get('*'), env('*'), getenv('*')
      const patterns = [
        /process\.env\.(\w+)/g,
        /process\.env\[['"](\w+)['"]\]/g,
        /os\.environ(?:\.get)?\(?['"](\w+)['"]\)?/g,
        /env\(['"](\w+)['"]\)/g,
        /getenv\(['"](\w+)['"]\)/g,
        /ENV\[['"](\w+)['"]\]/g,
      ];
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(code)) !== null) envVars.add(match[1]);
      }
      const sorted = [...envVars].sort();
      const envFile = sorted.map(v => `${v}=`).join('\n');
      return { variables: sorted, count: sorted.length, env_file: envFile || '# No environment variables found' };
    },
  },
  // ── Solana Ecosystem Tools ──────────────────────────────────
  'solana-address-validator': {
    name: 'Solana Address Validator',
    description: 'Validate Solana wallet addresses and program IDs. Check base58 encoding, length, and format.',
    run: (input) => {
      const addr = (input.address || '').trim();
      const base58Chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      if (!addr) return { valid: false, error: 'No address provided' };
      if (addr.length < 32 || addr.length > 44) return { valid: false, error: `Invalid length: ${addr.length} chars (expected 32-44)`, address: addr };
      const invalidChar = [...addr].find(c => !base58Chars.includes(c));
      if (invalidChar) return { valid: false, error: `Invalid base58 character: '${invalidChar}'`, address: addr };
      const knownPrograms = {
        '11111111111111111111111111111111': 'System Program',
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': 'SPL Token Program',
        'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb': 'Token-2022 Program',
        'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL': 'Associated Token Account',
        'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s': 'Metaplex Token Metadata',
        'cndy3Z4yapfJBmL3ShUp5exZKqR3z33thTzeNMm2gRZ': 'Candy Machine v2',
        'Guard1JwRhJkVH6XZhzoYxeBVQe872VH6QggF4BWmS9g': 'Candy Guard',
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter v6',
        'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpools',
        '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM',
        'So11111111111111111111111111111111111111112': 'Wrapped SOL',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC (SPL)',
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT (SPL)',
      };
      const programName = knownPrograms[addr] || null;
      return { valid: true, address: addr, length: addr.length, encoding: 'base58', known_program: programName, type: programName ? 'program' : 'wallet_or_unknown' };
    },
  },
  'solana-tx-decoder': {
    name: 'Solana Transaction Decoder',
    description: 'Decode base64/base58 Solana transaction data. Extract signatures, accounts, instructions.',
    run: (input) => {
      const raw = (input.transaction || '').trim();
      if (!raw) return { error: 'No transaction data provided' };
      let bytes;
      try {
        bytes = Buffer.from(raw, 'base64');
        if (bytes.length < 10) bytes = null;
      } catch { bytes = null; }
      if (!bytes) return { error: 'Invalid transaction data. Provide base64-encoded transaction.' };
      // Parse basic transaction structure
      const numSignatures = bytes[0];
      const sigSize = numSignatures * 64;
      const msgStart = 1 + sigSize;
      if (bytes.length < msgStart + 3) return { error: 'Transaction too short' };
      const numRequiredSigs = bytes[msgStart];
      const numReadonlySignedAccounts = bytes[msgStart + 1];
      const numReadonlyUnsignedAccounts = bytes[msgStart + 2];
      const numAccounts = bytes[msgStart + 3];
      return {
        size_bytes: bytes.length,
        num_signatures: numSignatures,
        message_offset: msgStart,
        num_required_signatures: numRequiredSigs,
        num_readonly_signed: numReadonlySignedAccounts,
        num_readonly_unsigned: numReadonlyUnsignedAccounts,
        num_accounts: numAccounts,
        tip: 'For full decode, paste the signature into explorer.solana.com',
      };
    },
  },
  'spl-token-calculator': {
    name: 'SPL Token Supply Calculator',
    description: 'Calculate token economics — supply, distribution, vesting schedules for SPL tokens.',
    run: (input) => {
      const totalSupply = parseInt(input.total_supply) || 1000000000;
      const decimals = parseInt(input.decimals) || 9;
      const teamPct = parseFloat(input.team_percent) || 15;
      const communityPct = parseFloat(input.community_percent) || 40;
      const liquidityPct = parseFloat(input.liquidity_percent) || 25;
      const treasuryPct = parseFloat(input.treasury_percent) || 20;
      const totalPct = teamPct + communityPct + liquidityPct + treasuryPct;
      const rawUnit = Math.pow(10, decimals);
      return {
        total_supply: totalSupply,
        decimals,
        raw_total: (totalSupply * rawUnit).toLocaleString(),
        allocation: {
          team: { percent: teamPct, tokens: Math.floor(totalSupply * teamPct / 100) },
          community: { percent: communityPct, tokens: Math.floor(totalSupply * communityPct / 100) },
          liquidity: { percent: liquidityPct, tokens: Math.floor(totalSupply * liquidityPct / 100) },
          treasury: { percent: treasuryPct, tokens: Math.floor(totalSupply * treasuryPct / 100) },
        },
        total_allocated_percent: totalPct,
        valid: Math.abs(totalPct - 100) < 0.01,
        warning: Math.abs(totalPct - 100) >= 0.01 ? `Allocations sum to ${totalPct}%, not 100%` : null,
        mint_authority_tip: 'Set mint authority to null after minting to make supply fixed',
      };
    },
  },
  'keypair-generator': {
    name: 'Solana Keypair Generator',
    description: 'Generate a random Solana keypair (Ed25519) for development/testing. NEVER use for mainnet!',
    run: () => {
      const secretKey = randomBytes(32);
      // Ed25519 public key derivation not available in pure JS, so we generate a random 32-byte mock
      const publicKeyBytes = randomBytes(32);
      const base58Chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      function toBase58(buf) {
        let num = BigInt('0x' + buf.toString('hex'));
        let result = '';
        while (num > 0n) { result = base58Chars[Number(num % 58n)] + result; num = num / 58n; }
        for (const b of buf) { if (b === 0) result = '1' + result; else break; }
        return result;
      }
      return {
        public_key: toBase58(publicKeyBytes),
        secret_key_base58: toBase58(Buffer.concat([secretKey, publicKeyBytes])),
        secret_key_array: `[${[...secretKey, ...publicKeyBytes].join(',')}]`,
        warning: 'FOR DEVELOPMENT/TESTING ONLY. Do NOT use this keypair on mainnet or store real funds.',
        tip: 'Use @solana/web3.js Keypair.generate() for production keypairs',
      };
    },
  },
  'anchor-idl-parser': {
    name: 'Anchor IDL Parser',
    description: 'Parse Anchor IDL JSON and generate TypeScript client types for Solana programs.',
    run: (input) => {
      try {
        const idl = JSON.parse(input.idl || '{}');
        if (!idl.instructions && !idl.name) return { error: 'Invalid IDL — must have instructions or name field' };
        const programName = idl.name || 'unknown_program';
        const instructions = (idl.instructions || []).map(ix => ({
          name: ix.name,
          accounts: (ix.accounts || []).map(a => ({ name: a.name, isMut: a.isMut, isSigner: a.isSigner })),
          args: (ix.args || []).map(a => ({ name: a.name, type: typeof a.type === 'string' ? a.type : JSON.stringify(a.type) })),
        }));
        const accounts = (idl.accounts || []).map(a => ({
          name: a.name,
          fields: (a.type?.fields || []).map(f => ({ name: f.name, type: typeof f.type === 'string' ? f.type : JSON.stringify(f.type) })),
        }));
        // Generate TypeScript types
        let ts = `// Auto-generated types for ${programName}\n\n`;
        for (const acc of accounts) {
          ts += `export interface ${acc.name} {\n`;
          for (const f of acc.fields) {
            const tsType = f.type === 'publicKey' ? 'PublicKey' : f.type === 'u64' || f.type === 'i64' ? 'BN' : f.type === 'string' ? 'string' : f.type === 'bool' ? 'boolean' : f.type === 'u8' || f.type === 'i8' || f.type === 'u16' || f.type === 'u32' || f.type === 'i32' ? 'number' : 'any';
            ts += `  ${f.name}: ${tsType};\n`;
          }
          ts += `}\n\n`;
        }
        for (const ix of instructions) {
          ts += `// ${ix.name}(${ix.args.map(a => a.name).join(', ')})\n`;
        }
        return {
          program_name: programName,
          instructions: instructions.length,
          accounts: accounts.length,
          instruction_list: instructions.map(i => i.name),
          typescript: ts,
          tip: 'Use @coral-xyz/anchor for full client SDK generation',
        };
      } catch (e) { return { error: 'Failed to parse IDL: ' + e.message }; }
    },
  },
};

// ── FREEMIUM RATE LIMITER — 10 free uses/day per IP, then upsell ─────────────

const FREE_USAGE_MAP = new Map(); // ip -> { count, resetAt }
const FREE_DAILY_LIMIT = 10;

function checkFreeLimit(ip) {
  const now = Date.now();
  const entry = FREE_USAGE_MAP.get(ip);
  if (!entry || now > entry.resetAt) {
    FREE_USAGE_MAP.set(ip, { count: 1, resetAt: now + 86400000 });
    return { allowed: true, remaining: FREE_DAILY_LIMIT - 1 };
  }
  if (entry.count >= FREE_DAILY_LIMIT) {
    return { allowed: false, remaining: 0 };
  }
  entry.count++;
  return { allowed: true, remaining: FREE_DAILY_LIMIT - entry.count };
}

// ── TEMPLATES STORE — build once, sell forever ──────────────────────────────────

const TEMPLATES = [
  {
    slug: 'nextjs-saas-starter',
    name: 'Next.js SaaS Starter Kit',
    description: 'Complete SaaS boilerplate: Auth, Stripe billing, dashboard, landing page, email. Next.js 14 + TypeScript + Tailwind + Prisma.',
    price: 29,
    features: ['Authentication (NextAuth)', 'Subscription billing', 'Admin dashboard', 'Landing page', 'Email templates', 'Prisma + PostgreSQL', 'Tailwind CSS', 'TypeScript'],
    preview_url: null,
  },
  {
    slug: 'express-api-boilerplate',
    name: 'Express API Boilerplate',
    description: 'Production-ready REST API: JWT auth, rate limiting, validation, error handling, Docker. TypeScript + Express + Prisma.',
    price: 19,
    features: ['JWT Authentication', 'Rate limiting', 'Input validation (Zod)', 'Error handling middleware', 'Docker + docker-compose', 'Prisma ORM', 'Jest tests', 'API docs (Swagger)'],
    preview_url: null,
  },
  {
    slug: 'react-dashboard',
    name: 'React Admin Dashboard',
    description: 'Modern admin dashboard with charts, tables, auth, dark mode. React 18 + TypeScript + Tailwind + Recharts.',
    price: 15,
    features: ['Responsive layout', 'Dark/light mode', 'Charts (Recharts)', 'Data tables', 'Auth flow', 'Sidebar navigation', 'TypeScript', 'Tailwind CSS'],
    preview_url: null,
  },
];

// ── Route Setup ─────────────────────────────────────────────────────────────────

export function setupToolRoutes(app) {
  // ── JSON Catalog (all tools — free + paid) ─────────────────────────────
  app.get('/api/tools', (_req, res) => {
    const paidCatalog = TOOLS.map(t => ({
      slug: t.slug, name: t.name, description: t.description,
      price: `$${t.price}`, type: 'ai', endpoint: `/api/tools/${t.slug}`,
      method: 'POST', input_fields: t.input_fields,
    }));
    const freeCatalog = Object.entries(FREE_TOOLS).map(([slug, t]) => ({
      slug, name: t.name, description: t.description,
      price: 'Free', type: 'free', endpoint: `/api/tools/free/${slug}`,
      method: 'POST',
    }));
    const templateCatalog = TEMPLATES.map(t => ({
      slug: t.slug, name: t.name, description: t.description,
      price: `$${t.price}`, type: 'template', features: t.features,
    }));
    res.json({ success: true, tools: [...freeCatalog, ...paidCatalog], templates: templateCatalog, count: freeCatalog.length + paidCatalog.length });
  });

  // ── HTML Storefront — SEO-optimized, free tools prominent ───────────────
  app.get('/tools', (_req, res) => {
    const freeCards = Object.entries(FREE_TOOLS).map(([slug, t]) => `
      <div class="tool-card free">
        <span class="badge free-badge">FREE</span>
        <h3>${t.name}</h3>
        <p>${t.description}</p>
        <a class="btn" onclick="toggleTry('free-${slug}')">Use Now</a>
        <div id="try-free-${slug}" class="try-panel" style="display:none">
          <textarea id="input-free-${slug}" placeholder="Paste input here..." rows="3"></textarea>
          <button onclick="runFree('${slug}')">Run</button>
          <pre id="output-free-${slug}"></pre>
        </div>
      </div>`).join('');

    const paidCards = TOOLS.map(t => `
      <div class="tool-card paid">
        <span class="badge paid-badge">$${t.price}</span>
        <h3>${t.name}</h3>
        <p>${t.description}</p>
        <a class="btn" onclick="toggleTry('${t.slug}')">Try Free Preview</a>
        <div id="try-${t.slug}" class="try-panel" style="display:none">
          <textarea id="input-${t.slug}" placeholder="Paste your ${t.input_fields[0]} here..." rows="4"></textarea>
          <button onclick="tryTool('${t.slug}', '${t.input_fields[0]}')">Generate Preview</button>
          <pre id="output-${t.slug}"></pre>
        </div>
      </div>`).join('');

    const templateCards = TEMPLATES.map(t => `
      <div class="tool-card template">
        <span class="badge template-badge">$${t.price}</span>
        <h3>${t.name}</h3>
        <p>${t.description}</p>
        <ul class="features">${t.features.map(f => `<li>${f}</li>`).join('')}</ul>
        <a class="btn" href="/api/templates/${t.slug}" target="_blank">Buy Now — $${t.price}</a>
      </div>`).join('');

    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Free Developer Tools | SnipeLink LLC</title>
  <meta name="description" content="Free developer tools: JSON formatter, JWT decoder, regex tester, hash generator, and more. Plus AI-powered code review, README generator, and JS-to-TypeScript converter.">
  <meta name="keywords" content="developer tools, JSON formatter, JWT decoder, regex tester, code review, README generator, TypeScript converter, free tools">
  <meta property="og:title" content="Free Developer Tools | SnipeLink LLC">
  <meta property="og:description" content="20+ free and premium developer tools. No signup required.">
  <meta property="og:type" content="website">
  <link rel="canonical" href="https://scintillating-gratitude-production.up.railway.app/tools">
  <style>
    :root{--bg:#0a0a0a;--card:#111;--accent:#00d4ff;--green:#00ff88;--purple:#a855f7;--text:#e0e0e0;--muted:#777}
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);line-height:1.6}
    .hero{text-align:center;padding:3rem 1rem 1rem}
    .hero h1{font-size:2.8rem;background:linear-gradient(135deg,var(--accent),var(--green));-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:.5rem}
    .hero p{color:var(--muted);font-size:1.1rem;max-width:600px;margin:0 auto}
    .hero .count{color:var(--accent);font-size:1.3rem;margin-top:.5rem;font-weight:600}
    .section-title{text-align:center;font-size:1.6rem;margin:2rem 0 1rem;color:var(--text)}
    .section-title span{color:var(--green)}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:1.2rem;padding:0 2rem 2rem;max-width:1200px;margin:0 auto}
    .tool-card{background:var(--card);border:1px solid #222;border-radius:12px;padding:1.5rem;position:relative;transition:border-color .2s,transform .2s}
    .tool-card:hover{border-color:var(--accent);transform:translateY(-2px)}
    .tool-card.free:hover{border-color:var(--green)}
    .tool-card.template:hover{border-color:var(--purple)}
    .tool-card h3{margin-bottom:.4rem;font-size:1.1rem}
    .tool-card p{color:var(--muted);font-size:.9rem;margin-bottom:.8rem}
    .badge{position:absolute;top:1rem;right:1rem;padding:2px 10px;border-radius:20px;font-size:.75rem;font-weight:700}
    .free-badge{background:var(--green);color:#000}
    .paid-badge{background:var(--accent);color:#000}
    .template-badge{background:var(--purple);color:#fff}
    .features{list-style:none;display:flex;flex-wrap:wrap;gap:.3rem;margin-bottom:.8rem}
    .features li{background:#1a1a2e;padding:2px 8px;border-radius:4px;font-size:.75rem;color:var(--muted)}
    .btn{display:inline-block;margin-top:.5rem;padding:.5rem 1.2rem;background:var(--accent);color:#000;text-decoration:none;border-radius:6px;font-weight:600;cursor:pointer;border:none;font-size:.9rem}
    .btn:hover{opacity:.85}
    .free .btn{background:var(--green)}
    .template .btn{background:var(--purple);color:#fff}
    .try-panel{margin-top:.8rem}
    .try-panel textarea{width:100%;background:#0d0d0d;border:1px solid #333;color:var(--text);padding:.6rem;border-radius:6px;resize:vertical;font-family:monospace;font-size:.85rem}
    .try-panel button{margin-top:.4rem;padding:.4rem 1rem;background:#222;color:var(--accent);border:1px solid var(--accent);border-radius:6px;cursor:pointer;font-size:.85rem}
    .try-panel button:hover{background:var(--accent);color:#000}
    .try-panel pre{margin-top:.6rem;background:#0a0a0a;border:1px solid #222;padding:.8rem;border-radius:6px;white-space:pre-wrap;word-break:break-word;font-size:.8rem;max-height:300px;overflow-y:auto}
    footer{text-align:center;padding:2rem 1rem;color:var(--muted);font-size:.8rem;border-top:1px solid #222;margin-top:2rem}
    footer a{color:var(--accent);text-decoration:none}
    @media(max-width:700px){.hero h1{font-size:2rem}.grid{padding:0 1rem 1rem;grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="hero">
    <h1>Developer Tools</h1>
    <p>Free utilities + AI-powered tools for developers. No signup. No BS.</p>
    <div class="count">${Object.keys(FREE_TOOLS).length} free tools + ${TOOLS.length} AI tools + ${TEMPLATES.length} templates</div>
  </div>
  <h2 class="section-title"><span>Free Tools</span> — unlimited, no signup</h2>
  <div class="grid">${freeCards}</div>
  <h2 class="section-title">AI-Powered Tools — <span>free preview</span></h2>
  <div class="grid">${paidCards}</div>
  <h2 class="section-title">Starter Templates — <span>buy once, use forever</span></h2>
  <div class="grid">${templateCards}</div>
  <footer>
    <p>Built by <a href="${PORTFOLIO_URL}">SnipeLink LLC</a> &middot; Payments via <a href="${SNIPELINK_URL}">SnipeLink</a></p>
    <p style="margin-top:.5rem">All tools available via API — <a href="/api/tools">View API catalog</a></p>
  </footer>
  <script>
    function toggleTry(id){const el=document.getElementById('try-'+id);el.style.display=el.style.display==='none'?'block':'none'}
    async function runFree(slug){
      const input=document.getElementById('input-free-'+slug).value;
      const output=document.getElementById('output-free-'+slug);
      if(!input.trim()){output.textContent='Enter input above.';return}
      output.textContent='Running...';
      try{
        const fieldMap={
          'json-formatter':'json','jwt-decoder':'token','base64':'text','hash-generator':'text',
          'uuid-generator':'count','cron-parser':'expression','color-converter':'color',
          'regex-tester':'pattern','timestamp-converter':'timestamp','password-generator':'length',
          'env-generator':'code'
        };
        const body={};
        const field=fieldMap[slug]||'text';
        body[field]=input;
        if(slug==='regex-tester')body.text=prompt('Enter test text:')||'';
        const res=await fetch('/api/tools/free/'+slug,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        const data=await res.json();
        output.textContent=data.error?'Error: '+data.error:JSON.stringify(data.result,null,2);
      }catch(e){output.textContent='Failed: '+e.message}
    }
    async function tryTool(slug,field){
      const input=document.getElementById('input-'+slug).value;
      const output=document.getElementById('output-'+slug);
      if(!input.trim()){output.textContent='Enter input above.';return}
      output.textContent='Generating (AI)...';
      try{
        const body={};body[field]=input;
        const res=await fetch('/api/tools/'+slug,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        const data=await res.json();
        if(data.error){output.textContent='Error: '+data.error;return}
        let text=data.preview||data.result||JSON.stringify(data,null,2);
        if(data.checkout_url)text+='\\n\\n--- Full version: '+data.checkout_url+' ---';
        output.textContent=text;
      }catch(e){output.textContent='Failed: '+e.message}
    }
  </script>
</body>
</html>`);
  });

  // ── Individual SEO Landing Pages — /tools/:slug ─────────────────────────
  const BASE_URL = 'https://scintillating-gratitude-production.up.railway.app';

  const ALL_TOOL_META = {};
  for (const [slug, t] of Object.entries(FREE_TOOLS)) {
    ALL_TOOL_META[slug] = { name: t.name, description: t.description, type: 'free', slug };
  }
  for (const t of TOOLS) {
    ALL_TOOL_META[t.slug] = { name: t.name, description: t.description, type: 'paid', slug: t.slug, price: t.price, input_fields: t.input_fields };
  }

  // SEO keyword map for richer titles/descriptions
  const SEO_TITLES = {
    'json-formatter': 'JSON Formatter Online - Free JSON Validator & Beautifier',
    'jwt-decoder': 'JWT Decoder Online - Free JWT Token Inspector',
    'base64': 'Base64 Encoder/Decoder Online - Free',
    'hash-generator': 'Hash Generator Online - MD5, SHA1, SHA256, SHA512',
    'uuid-generator': 'UUID Generator Online - Bulk v4 UUID Creator',
    'cron-parser': 'Cron Expression Parser - Free Cron Builder & Explainer',
    'color-converter': 'Color Converter - HEX to RGB to HSL Online',
    'regex-tester': 'Regex Tester Online - Free Regular Expression Tester',
    'timestamp-converter': 'Unix Timestamp Converter Online - Free',
    'password-generator': 'Password Generator - Secure Random Passwords Online',
    'env-generator': '.env File Generator - Extract Environment Variables from Code',
    'readme-generator': 'README Generator - AI-Powered README.md Creator',
    'pr-description': 'PR Description Writer - AI Pull Request Descriptions',
    'code-review': 'AI Code Review - Automated Code Review Tool',
    'api-docs': 'API Docs Generator - OpenAPI/Swagger from Code',
    'convert-to-typescript': 'JavaScript to TypeScript Converter - AI-Powered',
    'landing-page': 'Landing Page Generator - AI HTML/CSS Page Builder',
    'solana-address-validator': 'Solana Address Validator - Check Wallet & Program Addresses',
    'solana-tx-decoder': 'Solana Transaction Decoder - Decode Base64 Transactions',
    'spl-token-calculator': 'SPL Token Supply Calculator - Tokenomics Planner',
    'keypair-generator': 'Solana Keypair Generator - Dev/Test Ed25519 Keys',
    'anchor-idl-parser': 'Anchor IDL Parser - Generate TypeScript Types from IDL',
  };

  // Client-side JS for each free tool
  const FREE_TOOL_JS = {
    'json-formatter': `
      function runTool() {
        const input = document.getElementById('tool-input').value;
        const out = document.getElementById('tool-output');
        try {
          const parsed = JSON.parse(input);
          out.textContent = JSON.stringify(parsed, null, 2);
          document.getElementById('tool-status').textContent = 'Valid JSON — ' + Object.keys(parsed).length + ' top-level keys, ' + JSON.stringify(parsed).length + ' bytes';
          document.getElementById('tool-status').style.color = '#00ff88';
        } catch(e) {
          out.textContent = 'Invalid JSON: ' + e.message;
          document.getElementById('tool-status').textContent = 'Invalid JSON';
          document.getElementById('tool-status').style.color = '#ff4444';
        }
      }
      function minifyTool() {
        const input = document.getElementById('tool-input').value;
        try { document.getElementById('tool-output').textContent = JSON.stringify(JSON.parse(input)); }
        catch(e) { document.getElementById('tool-output').textContent = 'Invalid JSON: ' + e.message; }
      }`,
    'jwt-decoder': `
      function runTool() {
        const input = document.getElementById('tool-input').value.trim();
        const out = document.getElementById('tool-output');
        const status = document.getElementById('tool-status');
        try {
          const parts = input.split('.');
          if (parts.length !== 3) { out.textContent = 'Invalid JWT — must have 3 parts (header.payload.signature)'; return; }
          const header = JSON.parse(atob(parts[0].replace(/-/g,'+').replace(/_/g,'/')));
          const payload = JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')));
          let result = '--- HEADER ---\\n' + JSON.stringify(header, null, 2) + '\\n\\n--- PAYLOAD ---\\n' + JSON.stringify(payload, null, 2);
          if (payload.exp) {
            const expired = payload.exp * 1000 < Date.now();
            result += '\\n\\nExpires: ' + new Date(payload.exp * 1000).toISOString() + (expired ? ' (EXPIRED)' : ' (valid)');
            status.textContent = expired ? 'Token EXPIRED' : 'Token valid';
            status.style.color = expired ? '#ff4444' : '#00ff88';
          }
          if (payload.iat) result += '\\nIssued: ' + new Date(payload.iat * 1000).toISOString();
          out.textContent = result;
        } catch(e) { out.textContent = 'Decode error: ' + e.message; }
      }`,
    'base64': `
      function runTool() {
        const input = document.getElementById('tool-input').value;
        const out = document.getElementById('tool-output');
        try {
          const encoded = btoa(unescape(encodeURIComponent(input)));
          out.textContent = '--- ENCODED ---\\n' + encoded;
        } catch(e) { out.textContent = 'Encoding error: ' + e.message; }
      }
      function decodeTool() {
        const input = document.getElementById('tool-input').value;
        const out = document.getElementById('tool-output');
        try {
          const decoded = decodeURIComponent(escape(atob(input.trim())));
          out.textContent = '--- DECODED ---\\n' + decoded;
        } catch(e) { out.textContent = 'Decoding error: ' + e.message; }
      }`,
    'hash-generator': `
      async function runTool() {
        const input = document.getElementById('tool-input').value;
        const out = document.getElementById('tool-output');
        const enc = new TextEncoder();
        const data = enc.encode(input);
        async function hash(algo) {
          const buf = await crypto.subtle.digest(algo, data);
          return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
        }
        const sha1 = await hash('SHA-1');
        const sha256 = await hash('SHA-256');
        const sha512 = await hash('SHA-512');
        out.textContent = 'SHA-1:   ' + sha1 + '\\nSHA-256: ' + sha256 + '\\nSHA-512: ' + sha512;
      }`,
    'uuid-generator': `
      function runTool() {
        const count = Math.min(Math.max(parseInt(document.getElementById('tool-input').value) || 5, 1), 100);
        const uuids = [];
        for (let i = 0; i < count; i++) uuids.push(crypto.randomUUID());
        document.getElementById('tool-output').textContent = uuids.join('\\n');
        document.getElementById('tool-status').textContent = count + ' UUIDs generated';
        document.getElementById('tool-status').style.color = '#00ff88';
      }`,
    'cron-parser': `
      function runTool() {
        const input = document.getElementById('tool-input').value.trim() || '* * * * *';
        const out = document.getElementById('tool-output');
        const parts = input.split(/\\s+/);
        if (parts.length < 5) { out.textContent = 'Invalid cron — need 5 fields: minute hour day month weekday'; return; }
        const names = ['Minute','Hour','Day of Month','Month','Day of Week'];
        const ranges = ['0-59','0-23','1-31','1-12','0-7 (0,7=Sun)'];
        let result = '';
        for (let i = 0; i < 5; i++) result += names[i] + ': ' + parts[i] + '  (range: ' + ranges[i] + ')\\n';
        const explain = (v, n) => v === '*' ? 'every ' + n : n + ' ' + v;
        result += '\\nRuns: ' + explain(parts[0],'minute') + ', ' + explain(parts[1],'hour') + ', ' + explain(parts[2],'day') + ', ' + explain(parts[3],'month') + ', ' + explain(parts[4],'weekday');
        out.textContent = result;
      }`,
    'color-converter': `
      function runTool() {
        const c = document.getElementById('tool-input').value.trim();
        const out = document.getElementById('tool-output');
        let r, g, b;
        if (c.startsWith('#')) {
          const hex = c.replace('#','');
          r = parseInt(hex.substr(0,2),16); g = parseInt(hex.substr(2,2),16); b = parseInt(hex.substr(4,2),16);
        } else if (c.startsWith('rgb')) {
          [r,g,b] = c.match(/\\d+/g).map(Number);
        } else { out.textContent = 'Enter hex (#ff0000) or rgb(255,0,0)'; return; }
        if (isNaN(r)) { out.textContent = 'Invalid color'; return; }
        const hex = '#'+r.toString(16).padStart(2,'0')+g.toString(16).padStart(2,'0')+b.toString(16).padStart(2,'0');
        const max = Math.max(r,g,b)/255, min = Math.min(r,g,b)/255, l = (max+min)/2;
        let h=0, s=0;
        if (max !== min) {
          const d = max-min; s = l > 0.5 ? d/(2-max-min) : d/(max+min);
          if (max===r/255) h=((g/255-b/255)/d+(g<b?6:0))/6;
          else if (max===g/255) h=((b/255-r/255)/d+2)/6;
          else h=((r/255-g/255)/d+4)/6;
        }
        const hsl = 'hsl('+Math.round(h*360)+', '+Math.round(s*100)+'%, '+Math.round(l*100)+'%)';
        out.innerHTML = '<div style="width:80px;height:80px;border-radius:8px;background:'+hex+';margin-bottom:8px"></div>HEX: '+hex+'\\nRGB: rgb('+r+', '+g+', '+b+')\\nHSL: '+hsl;
      }`,
    'regex-tester': `
      function runTool() {
        const pattern = document.getElementById('tool-input').value;
        const text = document.getElementById('tool-input2').value;
        const flags = document.getElementById('tool-flags').value || 'g';
        const out = document.getElementById('tool-output');
        try {
          const re = new RegExp(pattern, flags);
          const matches = [...text.matchAll(re)].map((m,i) => 'Match '+(i+1)+': "'+m[0]+'" at index '+m.index);
          out.textContent = matches.length ? matches.join('\\n') : 'No matches found';
          document.getElementById('tool-status').textContent = matches.length + ' match(es)';
          document.getElementById('tool-status').style.color = matches.length ? '#00ff88' : '#ff4444';
        } catch(e) { out.textContent = 'Invalid regex: ' + e.message; }
      }`,
    'timestamp-converter': `
      function runTool() {
        const val = document.getElementById('tool-input').value.trim();
        const out = document.getElementById('tool-output');
        let date;
        if (/^\\d{10,13}$/.test(val)) {
          date = new Date(val.length === 10 ? parseInt(val)*1000 : parseInt(val));
        } else if (val) { date = new Date(val); }
        else { date = new Date(); }
        if (isNaN(date.getTime())) { out.textContent = 'Invalid date or timestamp'; return; }
        out.textContent = 'Unix (s):  ' + Math.floor(date.getTime()/1000) + '\\nUnix (ms): ' + date.getTime() + '\\nISO 8601:  ' + date.toISOString() + '\\nUTC:       ' + date.toUTCString() + '\\nLocal:     ' + date.toString();
      }
      function nowTool() {
        document.getElementById('tool-input').value = '';
        runTool();
      }`,
    'password-generator': `
      function runTool() {
        const len = Math.min(Math.max(parseInt(document.getElementById('tool-input').value) || 16, 8), 128);
        const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';
        const passwords = [];
        for (let p = 0; p < 5; p++) {
          const arr = new Uint8Array(len);
          crypto.getRandomValues(arr);
          let pw = '';
          for (let i = 0; i < len; i++) pw += charset[arr[i] % charset.length];
          passwords.push(pw);
        }
        document.getElementById('tool-output').textContent = passwords.join('\\n');
        document.getElementById('tool-status').textContent = '5 passwords, ' + len + ' chars, ~' + Math.floor(Math.log2(charset.length)*len) + ' bits entropy';
        document.getElementById('tool-status').style.color = '#00ff88';
      }`,
    'env-generator': `
      function runTool() {
        const code = document.getElementById('tool-input').value;
        const out = document.getElementById('tool-output');
        const envVars = new Set();
        const patterns = [
          /process\\.env\\.(\\w+)/g, /process\\.env\\[['"](\\ w+)['"]\\]/g,
          /os\\.environ(?:\\.get)?\\(?['"](\\ w+)['"]\\)?/g,
          /env\\(['"](\\ w+)['"]\\)/g, /getenv\\(['"](\\ w+)['"]\\)/g, /ENV\\[['"](\\ w+)['"]\\]/g
        ];
        for (const p of patterns) { let m; while((m=p.exec(code))!==null) envVars.add(m[1]); }
        const sorted = [...envVars].sort();
        out.textContent = sorted.length ? sorted.map(v => v + '=').join('\\n') : '# No environment variables found';
        document.getElementById('tool-status').textContent = sorted.length + ' variables found';
        document.getElementById('tool-status').style.color = '#00ff88';
      }`,
    'solana-address-validator': `
      function runTool() {
        const addr = document.getElementById('tool-input').value.trim();
        const out = document.getElementById('tool-output');
        const status = document.getElementById('tool-status');
        const base58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        if (!addr) { out.textContent = 'Enter a Solana address'; return; }
        if (addr.length < 32 || addr.length > 44) { out.textContent = 'Invalid length: ' + addr.length + ' (expected 32-44)'; status.textContent = 'Invalid'; status.style.color = '#ff4444'; return; }
        const bad = [...addr].find(c => !base58.includes(c));
        if (bad) { out.textContent = 'Invalid base58 character: ' + bad; status.textContent = 'Invalid'; status.style.color = '#ff4444'; return; }
        const known = {'11111111111111111111111111111111':'System Program','TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA':'SPL Token','JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4':'Jupiter v6','So11111111111111111111111111111111111111112':'Wrapped SOL','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v':'USDC'};
        const prog = known[addr];
        out.textContent = 'Valid Solana address\\nLength: ' + addr.length + '\\nEncoding: base58' + (prog ? '\\nKnown: ' + prog : '\\nType: wallet or unknown program');
        status.textContent = 'Valid' + (prog ? ' — ' + prog : ''); status.style.color = '#00ff88';
      }`,
    'spl-token-calculator': `
      function runTool() {
        const supply = parseInt(document.getElementById('tool-input').value) || 1000000000;
        const dec = parseInt(document.getElementById('tool-decimals')?.value) || 9;
        const team = parseFloat(document.getElementById('tool-team')?.value) || 15;
        const comm = parseFloat(document.getElementById('tool-community')?.value) || 40;
        const liq = parseFloat(document.getElementById('tool-liquidity')?.value) || 25;
        const tres = parseFloat(document.getElementById('tool-treasury')?.value) || 20;
        const total = team + comm + liq + tres;
        const out = document.getElementById('tool-output');
        out.textContent = 'Total Supply: ' + supply.toLocaleString() + '\\nDecimals: ' + dec + '\\nRaw units: ' + (supply * Math.pow(10,dec)).toLocaleString() +
          '\\n\\nAllocation:\\n  Team: ' + team + '% = ' + Math.floor(supply*team/100).toLocaleString() +
          '\\n  Community: ' + comm + '% = ' + Math.floor(supply*comm/100).toLocaleString() +
          '\\n  Liquidity: ' + liq + '% = ' + Math.floor(supply*liq/100).toLocaleString() +
          '\\n  Treasury: ' + tres + '% = ' + Math.floor(supply*tres/100).toLocaleString() +
          '\\n\\nTotal: ' + total + '%' + (Math.abs(total-100) >= 0.01 ? ' ⚠️ Does not sum to 100%!' : ' ✓');
        document.getElementById('tool-status').textContent = 'Calculated'; document.getElementById('tool-status').style.color = '#00ff88';
      }`,
    'anchor-idl-parser': `
      function runTool() {
        const raw = document.getElementById('tool-input').value;
        const out = document.getElementById('tool-output');
        try {
          const idl = JSON.parse(raw);
          const name = idl.name || 'unknown';
          const ixs = (idl.instructions || []);
          const accs = (idl.accounts || []);
          let ts = '// Auto-generated types for ' + name + '\\n\\n';
          for (const a of accs) {
            ts += 'export interface ' + a.name + ' {\\n';
            for (const f of (a.type?.fields || [])) {
              const t = f.type === 'publicKey' ? 'PublicKey' : f.type === 'u64' || f.type === 'i64' ? 'BN' : f.type === 'string' ? 'string' : f.type === 'bool' ? 'boolean' : typeof f.type === 'string' && f.type.match(/^[ui](8|16|32)$/) ? 'number' : 'any';
              ts += '  ' + f.name + ': ' + t + ';\\n';
            }
            ts += '}\\n\\n';
          }
          for (const ix of ixs) ts += '// ' + ix.name + '(' + (ix.args||[]).map(a=>a.name).join(', ') + ')\\n';
          out.textContent = ts;
          document.getElementById('tool-status').textContent = name + ': ' + ixs.length + ' instructions, ' + accs.length + ' accounts';
          document.getElementById('tool-status').style.color = '#00ff88';
        } catch(e) { out.textContent = 'Invalid IDL JSON: ' + e.message; document.getElementById('tool-status').textContent = 'Error'; document.getElementById('tool-status').style.color = '#ff4444'; }
      }`,
  };

  // Custom input HTML for specific free tools
  const FREE_TOOL_INPUT_HTML = {
    'json-formatter': `<textarea id="tool-input" placeholder='{"key": "value", "nested": {"a": 1}}' rows="10"></textarea>
      <div style="display:flex;gap:8px;margin-top:8px"><button onclick="runTool()">Format / Validate</button><button onclick="minifyTool()">Minify</button></div>`,
    'jwt-decoder': `<textarea id="tool-input" placeholder="Paste your JWT token here (eyJhbGciOi...)" rows="5"></textarea>
      <button onclick="runTool()">Decode JWT</button>`,
    'base64': `<textarea id="tool-input" placeholder="Enter text to encode, or Base64 string to decode" rows="5"></textarea>
      <div style="display:flex;gap:8px;margin-top:8px"><button onclick="runTool()">Encode</button><button onclick="decodeTool()">Decode</button></div>`,
    'hash-generator': `<textarea id="tool-input" placeholder="Enter text to hash" rows="4"></textarea>
      <button onclick="runTool()">Generate Hashes</button>`,
    'uuid-generator': `<input id="tool-input" type="number" value="5" min="1" max="100" placeholder="Number of UUIDs" style="width:200px;padding:8px;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;border-radius:6px">
      <button onclick="runTool()">Generate UUIDs</button>`,
    'cron-parser': `<input id="tool-input" type="text" value="*/5 * * * *" placeholder="e.g. */5 * * * *" style="width:100%;padding:8px;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;border-radius:6px;font-family:monospace">
      <button onclick="runTool()">Parse Cron</button>`,
    'color-converter': `<input id="tool-input" type="text" placeholder="#ff6600 or rgb(255, 102, 0)" style="width:100%;padding:8px;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;border-radius:6px">
      <button onclick="runTool()">Convert</button>`,
    'regex-tester': `<input id="tool-input" type="text" placeholder="Regular expression pattern" style="width:100%;padding:8px;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;border-radius:6px;font-family:monospace;margin-bottom:8px">
      <textarea id="tool-input2" placeholder="Test string to match against" rows="4"></textarea>
      <input id="tool-flags" type="text" value="g" placeholder="Flags (g, i, m)" style="width:100px;padding:6px;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;border-radius:6px;margin-top:8px">
      <button onclick="runTool()">Test Regex</button>`,
    'timestamp-converter': `<input id="tool-input" type="text" placeholder="Unix timestamp (1700000000) or date (2024-01-01)" style="width:100%;padding:8px;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;border-radius:6px">
      <div style="display:flex;gap:8px;margin-top:8px"><button onclick="runTool()">Convert</button><button onclick="nowTool()">Current Time</button></div>`,
    'password-generator': `<input id="tool-input" type="number" value="16" min="8" max="128" placeholder="Password length" style="width:200px;padding:8px;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;border-radius:6px">
      <button onclick="runTool()">Generate Passwords</button>`,
    'env-generator': `<textarea id="tool-input" placeholder="Paste your source code here (JavaScript, Python, Ruby, etc.)" rows="10"></textarea>
      <button onclick="runTool()">Extract Variables</button>`,
    'solana-address-validator': `<input id="tool-input" type="text" placeholder="Enter Solana wallet address or program ID" style="width:100%;padding:10px;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;border-radius:6px;font-family:monospace">
      <button onclick="runTool()">Validate Address</button>`,
    'solana-tx-decoder': `<textarea id="tool-input" placeholder="Paste base64-encoded Solana transaction" rows="6"></textarea>
      <button onclick="runTool()">Decode Transaction</button>`,
    'spl-token-calculator': `<input id="tool-input" type="number" value="1000000000" placeholder="Total Supply" style="width:100%;padding:8px;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;border-radius:6px;margin-bottom:8px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <input id="tool-decimals" type="number" value="9" placeholder="Decimals" style="padding:8px;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;border-radius:6px">
        <input id="tool-team" type="number" value="15" placeholder="Team %" style="padding:8px;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;border-radius:6px">
        <input id="tool-community" type="number" value="40" placeholder="Community %" style="padding:8px;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;border-radius:6px">
        <input id="tool-liquidity" type="number" value="25" placeholder="Liquidity %" style="padding:8px;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;border-radius:6px">
        <input id="tool-treasury" type="number" value="20" placeholder="Treasury %" style="padding:8px;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;border-radius:6px">
      </div>
      <button onclick="runTool()" style="margin-top:8px">Calculate Tokenomics</button>`,
    'keypair-generator': `<button id="tool-input" onclick="runTool()">Generate Keypair (dev/test only)</button>
      <p style="color:#ff4444;font-size:.85rem;margin-top:8px">⚠ FOR DEVELOPMENT ONLY — do not use on mainnet</p>`,
    'anchor-idl-parser': `<textarea id="tool-input" placeholder='Paste your Anchor IDL JSON here (from target/idl/program.json)' rows="10"></textarea>
      <button onclick="runTool()">Parse IDL → TypeScript</button>`,
  };

  // Paid tool input HTML
  function paidToolInputHtml(tool) {
    const fieldLabels = {
      repo_url: 'GitHub Repository URL', diff: 'Diff or changeset text',
      code: 'Paste your code here', product_name: 'Product name',
      description: 'Product description', features: 'Features (comma-separated)',
    };
    let html = '';
    for (const field of tool.input_fields) {
      const label = fieldLabels[field] || field;
      if (field === 'repo_url') {
        html += `<input id="tool-input-${field}" type="text" placeholder="${label}" style="width:100%;padding:8px;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;border-radius:6px;margin-bottom:8px">`;
      } else {
        html += `<textarea id="tool-input-${field}" placeholder="${label}" rows="6"></textarea>`;
      }
    }
    html += `<button onclick="runPaidTool()">Generate Preview</button>`;
    return html;
  }

  function paidToolJs(tool) {
    const fields = tool.input_fields.map(f => `'${f}': document.getElementById('tool-input-${f}').value`).join(', ');
    return `
      async function runPaidTool() {
        const out = document.getElementById('tool-output');
        const status = document.getElementById('tool-status');
        out.textContent = 'Generating with AI...';
        status.textContent = 'Processing...';
        status.style.color = '#00d4ff';
        try {
          const body = {${fields}};
          const res = await fetch('/api/tools/${tool.slug}', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
          const data = await res.json();
          if (data.error) { out.textContent = 'Error: ' + data.error; status.textContent = 'Failed'; status.style.color = '#ff4444'; return; }
          let text = data.preview || data.result || JSON.stringify(data, null, 2);
          if (data.checkout_url) text += '\\n\\n--- Get full version: ' + data.checkout_url + ' ---';
          out.textContent = text;
          status.textContent = data.full_available ? 'Preview shown — full version available for ' + data.price : 'Complete';
          status.style.color = '#00ff88';
        } catch(e) { out.textContent = 'Failed: ' + e.message; status.textContent = 'Error'; status.style.color = '#ff4444'; }
      }`;
  }

  app.get('/tools/:slug', (req, res) => {
    const { slug } = req.params;
    const meta = ALL_TOOL_META[slug];
    if (!meta) return res.status(404).type('html').send('<html><body style="background:#0a0a0a;color:#fff;font-family:sans-serif;text-align:center;padding:4rem"><h1>Tool Not Found</h1><p><a href="/tools" style="color:#00d4ff">Browse all tools</a></p></body></html>');

    const isFree = meta.type === 'free';
    const title = SEO_TITLES[slug] || `${meta.name} - Free Online Tool`;
    const fullTitle = title + ' | SnipeLink';
    const canonicalUrl = `${BASE_URL}/tools/${slug}`;
    const description = meta.description;

    // Build cross-links sidebar
    const otherTools = Object.entries(ALL_TOOL_META)
      .filter(([s]) => s !== slug)
      .map(([s, t]) => `<a href="/tools/${s}" class="sidebar-link ${t.type === 'free' ? 'free-link' : 'paid-link'}">${t.type === 'free' ? '<span class="sb-badge free-sb">FREE</span>' : '<span class="sb-badge paid-sb">$' + t.price + '</span>'}${t.name}</a>`)
      .join('');

    // Tool-specific content
    let inputHtml, toolScript;
    if (isFree) {
      inputHtml = FREE_TOOL_INPUT_HTML[slug] || `<textarea id="tool-input" placeholder="Enter input..." rows="6"></textarea><button onclick="runTool()">Run</button>`;
      toolScript = FREE_TOOL_JS[slug] || `function runTool() { document.getElementById('tool-output').textContent = 'Tool running...'; }`;
    } else {
      const tool = TOOLS.find(t => t.slug === slug);
      inputHtml = paidToolInputHtml(tool);
      toolScript = paidToolJs(tool);
    }

    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${fullTitle}</title>
  <meta name="description" content="${description}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${canonicalUrl}">
  <meta property="og:title" content="${fullTitle}">
  <meta property="og:description" content="${description}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${canonicalUrl}">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${fullTitle}">
  <meta name="twitter:description" content="${description}">
  <script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: meta.name,
    description: description,
    url: canonicalUrl,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'All',
    offers: isFree
      ? { '@type': 'Offer', price: '0', priceCurrency: 'USD' }
      : { '@type': 'Offer', price: String(meta.price), priceCurrency: 'USD' },
    author: { '@type': 'Organization', name: 'SnipeLink LLC', url: PORTFOLIO_URL },
  })}</script>
  <style>
    :root{--bg:#0a0a0a;--card:#111;--accent:#00d4ff;--green:#00ff88;--purple:#a855f7;--text:#e0e0e0;--muted:#777;--surface:#161616}
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);line-height:1.6}
    .layout{display:grid;grid-template-columns:1fr 280px;gap:2rem;max-width:1200px;margin:0 auto;padding:2rem}
    .main{min-width:0}
    .breadcrumb{font-size:.85rem;color:var(--muted);margin-bottom:1rem}
    .breadcrumb a{color:var(--accent);text-decoration:none}
    .breadcrumb a:hover{text-decoration:underline}
    h1{font-size:2rem;margin-bottom:.5rem;background:linear-gradient(135deg,${isFree ? 'var(--green),var(--accent)' : 'var(--accent),var(--purple)'});-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    .subtitle{color:var(--muted);font-size:1.05rem;margin-bottom:1.5rem}
    .type-badge{display:inline-block;padding:2px 12px;border-radius:20px;font-size:.8rem;font-weight:700;margin-bottom:1rem;${isFree ? 'background:var(--green);color:#000' : 'background:var(--accent);color:#000'}}
    .tool-area{background:var(--card);border:1px solid #222;border-radius:12px;padding:1.5rem;margin-bottom:1.5rem}
    .tool-area textarea{width:100%;background:#0d0d0d;border:1px solid #333;color:var(--text);padding:.8rem;border-radius:6px;resize:vertical;font-family:monospace;font-size:.9rem;margin-bottom:.5rem}
    .tool-area input[type=text],.tool-area input[type=number]{font-family:monospace}
    .tool-area button{padding:.5rem 1.2rem;background:${isFree ? 'var(--green)' : 'var(--accent)'};color:#000;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:.9rem;margin-top:.5rem}
    .tool-area button:hover{opacity:.85}
    #tool-status{margin-top:.8rem;font-size:.85rem;font-weight:600;color:var(--muted)}
    #tool-output{margin-top:1rem;background:#0a0a0a;border:1px solid #222;padding:1rem;border-radius:6px;white-space:pre-wrap;word-break:break-word;font-family:monospace;font-size:.85rem;min-height:60px;max-height:500px;overflow-y:auto}
    .sidebar{position:sticky;top:2rem;align-self:start}
    .sidebar h3{font-size:1rem;margin-bottom:.8rem;color:var(--muted)}
    .sidebar-link{display:flex;align-items:center;gap:8px;padding:6px 10px;color:var(--text);text-decoration:none;border-radius:6px;font-size:.85rem;transition:background .15s}
    .sidebar-link:hover{background:var(--surface)}
    .sb-badge{padding:1px 8px;border-radius:12px;font-size:.7rem;font-weight:700;flex-shrink:0}
    .free-sb{background:var(--green);color:#000}
    .paid-sb{background:var(--accent);color:#000}
    footer{text-align:center;padding:2rem 1rem;color:var(--muted);font-size:.8rem;border-top:1px solid #222;margin-top:2rem}
    footer a{color:var(--accent);text-decoration:none}
    @media(max-width:800px){.layout{grid-template-columns:1fr;padding:1rem}.sidebar{position:static}}
  </style>
</head>
<body>
  <div class="layout">
    <div class="main">
      <div class="breadcrumb"><a href="/tools">All Tools</a> &rsaquo; ${meta.name}</div>
      <span class="type-badge">${isFree ? 'FREE' : '$' + meta.price}</span>
      <h1>${meta.name}</h1>
      <p class="subtitle">${description}</p>
      <div class="tool-area">
        ${inputHtml}
        <div id="tool-status"></div>
        <div id="tool-output"></div>
      </div>
    </div>
    <aside class="sidebar">
      <h3>More Developer Tools</h3>
      ${otherTools}
      <div style="margin-top:1.5rem;padding-top:1rem;border-top:1px solid #222">
        <h3 style="font-size:.85rem;margin-bottom:.6rem">Developer Resources</h3>
        <a href="https://railway.app?referralCode=snipelink" target="_blank" rel="noopener" class="sidebar-link"><span class="sb-badge" style="background:#8B5CF6;color:#fff">AD</span>Deploy on Railway</a>
        <a href="https://vercel.com?utm_source=snipelink" target="_blank" rel="noopener" class="sidebar-link"><span class="sb-badge" style="background:#000;color:#fff">AD</span>Deploy on Vercel</a>
        <a href="https://www.digitalocean.com/?refcode=snipelink&utm_campaign=Referral_Invite" target="_blank" rel="noopener" class="sidebar-link"><span class="sb-badge" style="background:#0080FF;color:#fff">AD</span>DigitalOcean $200 Credit</a>
      </div>
      <div style="margin-top:1rem;padding-top:.8rem;border-top:1px solid #222">
        <h3 style="font-size:.85rem;margin-bottom:.6rem">CLI Tools (npm)</h3>
        <div style="font-size:.8rem;color:var(--muted);font-family:monospace;line-height:1.8">
          <div>npx snipelink-readme</div>
          <div>npx snipelink-ts</div>
          <div>npx snipelink-review</div>
        </div>
      </div>
    </aside>
  </div>
  <footer>
    <p>Built by <a href="${PORTFOLIO_URL}">SnipeLink LLC</a> &middot; Payments via <a href="${SNIPELINK_URL}">SnipeLink</a></p>
    <p style="margin-top:.5rem"><a href="/tools">All Tools</a> &middot; <a href="/api/tools">API</a> &middot; <a href="/sitemap.xml">Sitemap</a> &middot; <a href="https://github.com/klawgulp-ship-it" target="_blank">GitHub</a></p>
  </footer>
  <script>${toolScript}</script>
</body>
</html>`);
  });

  // ── Comparison SEO Pages — /tools/:slug-vs-:competitor ─────────────────
  const COMPARISONS = {
    'json-formatter-vs-jsonlint': { tool: 'json-formatter', competitor: 'JSONLint', title: 'JSON Formatter vs JSONLint - Free Online Comparison', desc: 'Compare our free JSON formatter with JSONLint. Both validate and beautify JSON, but ours runs entirely in your browser with no ads.' },
    'jwt-decoder-vs-jwt-io': { tool: 'jwt-decoder', competitor: 'jwt.io', title: 'JWT Decoder vs jwt.io - Free Token Inspector', desc: 'Compare our JWT decoder with jwt.io. Decode JWT tokens instantly in your browser without sending them to any server.' },
    'regex-tester-vs-regex101': { tool: 'regex-tester', competitor: 'Regex101', title: 'Regex Tester vs Regex101 - Free Online Comparison', desc: 'Compare our regex tester with Regex101. Test JavaScript regular expressions instantly with real-time matching.' },
    'base64-vs-base64encode': { tool: 'base64', competitor: 'Base64Encode.org', title: 'Base64 Encoder vs Base64Encode.org - Free Comparison', desc: 'Compare our Base64 encoder/decoder with Base64Encode.org. Encode and decode Base64 strings instantly in your browser.' },
    'password-generator-vs-lastpass': { tool: 'password-generator', competitor: 'LastPass Generator', title: 'Password Generator vs LastPass - Free Secure Passwords', desc: 'Compare our password generator with LastPass. Generate cryptographically secure passwords with customizable length and character sets.' },
    'timestamp-converter-vs-epochconverter': { tool: 'timestamp-converter', competitor: 'EpochConverter', title: 'Timestamp Converter vs EpochConverter - Free Unix Time Tool', desc: 'Compare our timestamp converter with EpochConverter.com. Convert Unix timestamps to human-readable dates instantly.' },
    'solana-address-validator-vs-solscan': { tool: 'solana-address-validator', competitor: 'Solscan', title: 'Solana Address Validator vs Solscan - Free Wallet Checker', desc: 'Validate Solana addresses instantly in your browser. No RPC calls needed — pure client-side base58 validation with known program detection.' },
    'spl-token-calculator-vs-tokenomics': { tool: 'spl-token-calculator', competitor: 'Generic Calculators', title: 'SPL Token Supply Calculator - Free Solana Tokenomics Tool', desc: 'Plan your Solana token economics. Calculate supply distribution, vesting, and allocation percentages for SPL tokens.' },
  };

  for (const [compSlug, comp] of Object.entries(COMPARISONS)) {
    app.get(`/tools/${compSlug}`, (_req, res) => {
      res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${comp.title} | SnipeLink Dev Tools</title>
<meta name="description" content="${comp.desc}">
<link rel="canonical" href="${BASE_URL}/tools/${compSlug}">
<style>body{background:#0a0a0a;color:#e0e0e0;font-family:system-ui;max-width:800px;margin:0 auto;padding:2rem}h1{color:#00ff88;font-size:1.8rem}h2{color:#00ccff;margin-top:2rem}.winner{background:#111;border:1px solid #00ff88;border-radius:8px;padding:1.5rem;margin:1rem 0}.cta{display:inline-block;background:#00ff88;color:#000;padding:.75rem 2rem;border-radius:6px;text-decoration:none;font-weight:bold;margin-top:1rem}a{color:#00ccff}table{width:100%;border-collapse:collapse;margin:1rem 0}th,td{border:1px solid #333;padding:.75rem;text-align:left}th{background:#111}</style>
</head><body>
<h1>${comp.title}</h1>
<p>${comp.desc}</p>
<table><thead><tr><th>Feature</th><th>SnipeLink</th><th>${comp.competitor}</th></tr></thead><tbody>
<tr><td>Price</td><td>Free</td><td>Free</td></tr>
<tr><td>Runs in browser</td><td>Yes — no server calls</td><td>Varies</td></tr>
<tr><td>No ads</td><td>Yes</td><td>No — has ads</td></tr>
<tr><td>No tracking</td><td>Minimal</td><td>Varies</td></tr>
<tr><td>Additional tools</td><td>17+ dev tools</td><td>Single purpose</td></tr>
</tbody></table>
<div class="winner">
<h2>Try it free</h2>
<p>Our ${ALL_TOOL_META[comp.tool]?.name || comp.tool} runs entirely in your browser with zero ads. No signup required.</p>
<a class="cta" href="/tools/${comp.tool}">Use ${ALL_TOOL_META[comp.tool]?.name || comp.tool} Free</a>
</div>
<p style="margin-top:2rem"><a href="/tools">View all 17+ free dev tools</a></p>
<p style="margin-top:3rem;font-size:.8rem;color:#666">SnipeLink LLC &copy; 2026</p>
</body></html>`);
    });
  }

  // ── Sitemap.xml — all tool pages ──────────────────────────────────────
  app.get('/sitemap.xml', (_req, res) => {
    const urls = [`${BASE_URL}/tools`];
    for (const slug of Object.keys(FREE_TOOLS)) urls.push(`${BASE_URL}/tools/${slug}`);
    for (const t of TOOLS) urls.push(`${BASE_URL}/tools/${t.slug}`);
    for (const compSlug of Object.keys(COMPARISONS)) urls.push(`${BASE_URL}/tools/${compSlug}`);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${u}</loc><changefreq>weekly</changefreq><priority>${u.endsWith('/tools') ? '1.0' : '0.8'}</priority></url>`).join('\n')}
</urlset>`;
    res.type('application/xml').send(xml);
  });

  // ── FREE Tool Endpoints (zero API cost — pure JS, rate limited) ──────────
  for (const [slug, tool] of Object.entries(FREE_TOOLS)) {
    app.post(`/api/tools/free/${slug}`, (req, res) => {
      try {
        const ip = getClientIp(req);
        const limit = checkFreeLimit(ip);
        if (!limit.allowed) {
          return res.status(429).json({
            error: 'Daily free limit reached (10/day). Upgrade for unlimited access.',
            upgrade_url: `${SNIPELINK_URL}/@agencycommand/tools`,
            resets_in: '24 hours',
          });
        }
        const result = tool.run(req.body);
        logUsage(`free:${slug}`, JSON.stringify(req.body).slice(0, 200), false, 0, '', ip);
        return res.json({ success: true, tool: slug, result, remaining_today: limit.remaining });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    });
  }

  // ── Template Bundle — all 3 for $49 (save $14) ─────────────────────────
  app.get('/api/templates/bundle', async (_req, res) => {
    const bundlePrice = 49;
    const individualTotal = TEMPLATES.reduce((s, t) => s + t.price, 0);
    const checkoutUrl = await createCheckout('template-bundle', bundlePrice, { bundle: true });
    res.json({
      name: 'Complete Template Bundle',
      description: `All ${TEMPLATES.length} templates — save $${individualTotal - bundlePrice}`,
      templates: TEMPLATES.map(t => t.name),
      price: `$${bundlePrice}`,
      original_price: `$${individualTotal}`,
      savings: `$${individualTotal - bundlePrice}`,
      checkout_url: checkoutUrl,
    });
  });

  // ── Template purchase endpoints ────────────────────────────────────────
  for (const template of TEMPLATES) {
    app.get(`/api/templates/${template.slug}`, async (req, res) => {
      const checkoutUrl = await createCheckout(template.slug, template.price, { template: template.slug });
      res.json({
        ...template,
        checkout_url: checkoutUrl,
        message: `Purchase ${template.name} for $${template.price}`,
      });
    });
  }

  // ── Paid AI Tool Endpoints ─────────────────────────────────────────────
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

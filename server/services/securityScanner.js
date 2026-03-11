import db from '../db/connection.js';
import { notify } from './notifications.js';
import crypto from 'crypto';

const GITHUB_API = 'https://api.github.com';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const GITHUB_USERNAME = 'klawgulp-ship-it';

// Payout wallets
const WALLET_SOL = 'A9REHRDTD8DAqbiSxdiTeTA41CqdoJ4QFPzo4FCpQrtL';
const WALLET_ETH = '0x46b237D2561a520A5Ef3795911814fd5045Fe01e';

// ─── Schema ──────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS security_programs (
    id TEXT PRIMARY KEY,
    repo TEXT UNIQUE NOT NULL,
    program_url TEXT DEFAULT '',
    platform TEXT DEFAULT '',
    min_payout INTEGER DEFAULT 0,
    max_payout INTEGER DEFAULT 0,
    scope TEXT DEFAULT '',
    security_md TEXT DEFAULT '',
    scanned_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS security_findings (
    id TEXT PRIMARY KEY,
    program_id TEXT,
    repo TEXT NOT NULL,
    vulnerability_type TEXT NOT NULL,
    severity TEXT DEFAULT 'medium',
    file_path TEXT DEFAULT '',
    description TEXT DEFAULT '',
    fix_description TEXT DEFAULT '',
    pr_url TEXT DEFAULT '',
    status TEXT DEFAULT 'found',
    payout INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (program_id) REFERENCES security_programs(id)
  );
`);

// ─── GitHub API helper ───────────────────────────────────
function gh(path, options = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set');
  return fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `token ${token}`,
      'User-Agent': 'AgencyCommand/1.0',
      'Content-Type': 'application/json',
      ...options.headers,
    },
    signal: AbortSignal.timeout(30000),
  }).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || `GitHub API ${r.status}`);
    return data;
  });
}

// ─── Claude API helpers ──────────────────────────────────
async function askClaude(prompt, maxTokens = 4096, model = 'claude-sonnet-4-6') {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const res = await fetch(ANTHROPIC_API, {
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
    signal: AbortSignal.timeout(90000),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Claude API error');
  return data.content?.map(c => c.text || '').join('\n') || '';
}

const askHaiku = (prompt, maxTokens = 1024) => askClaude(prompt, maxTokens, 'claude-haiku-4-5-20251001');

// ─── Read a file from a GitHub repo ──────────────────────
async function readFile(owner, repo, path) {
  try {
    const file = await gh(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`);
    if (file.content) {
      return Buffer.from(file.content, 'base64').toString('utf-8');
    }
  } catch (e) {}
  return null;
}

// ─── Step 1: Discover repos with bug bounty programs ─────
async function discoverBountyPrograms() {
  const queries = [
    'filename:SECURITY.md "bounty" "reward"',
    'filename:SECURITY.md "hackerone" OR "bugcrowd"',
    'filename:.github/SECURITY.md "responsible disclosure" "reward"',
  ];

  const programs = [];

  for (const q of queries) {
    try {
      const results = await gh(`/search/code?q=${encodeURIComponent(q)}&per_page=20`);
      if (!results.items) continue;

      for (const item of results.items) {
        const repo = item.repository?.full_name;
        if (!repo) continue;

        // Skip if already stored
        const existing = db.prepare('SELECT id FROM security_programs WHERE repo = ?').get(repo);
        if (existing) continue;

        // Read the SECURITY.md to extract program details
        const [owner, repoName] = repo.split('/');
        let securityMd = null;
        for (const secPath of ['SECURITY.md', '.github/SECURITY.md']) {
          securityMd = await readFile(owner, repoName, secPath);
          if (securityMd) break;
        }
        if (!securityMd) continue;

        // Extract program details with Haiku (cheap)
        const extractPrompt = `Analyze this SECURITY.md and extract bug bounty program details.

SECURITY.MD CONTENT:
${securityMd.slice(0, 3000)}

Extract:
1. Does this repo have a bug bounty or reward program? (yes/no)
2. Platform (hackerone, bugcrowd, self-hosted, email, or none)
3. Program URL (if any)
4. Minimum payout in USD (0 if unknown)
5. Maximum payout in USD (0 if unknown)
6. Scope (what's in scope — e.g. "web app", "API", "all code", etc.)

Respond in JSON: {"has_bounty": true/false, "platform": "...", "program_url": "...", "min_payout": 0, "max_payout": 0, "scope": "..."}`;

        try {
          const analysis = await askHaiku(extractPrompt, 512);
          const jsonMatch = analysis.match(/\{[\s\S]*\}/);
          if (!jsonMatch) continue;

          const info = JSON.parse(jsonMatch[0]);
          if (!info.has_bounty) continue;

          const id = crypto.randomUUID();
          db.prepare(`
            INSERT OR IGNORE INTO security_programs (id, repo, program_url, platform, min_payout, max_payout, scope, security_md, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          `).run(id, repo, info.program_url || '', info.platform || '', info.min_payout || 0, info.max_payout || 0, info.scope || '', securityMd.slice(0, 5000));

          programs.push({ id, repo, ...info });
          console.log(`[SECURITY] Found bounty program: ${repo} ($${info.min_payout}-$${info.max_payout})`);
        } catch (e) {
          console.error(`[SECURITY] Failed to analyze ${repo}:`, e.message);
        }
      }

      // Respect GitHub search rate limit — 10 req/min for code search
      await new Promise(r => setTimeout(r, 6000));
    } catch (e) {
      console.error(`[SECURITY] Search query failed:`, e.message);
    }
  }

  console.log(`[SECURITY] Discovered ${programs.length} new bounty programs`);
  return programs;
}

// ─── Step 2: Scan a repo for security issues ─────────────
async function scanForIssues(repo) {
  const [owner, repoName] = repo.split('/');

  // Get repo tree
  let tree = [];
  try {
    const treeData = await gh(`/repos/${owner}/${repoName}/git/trees/HEAD?recursive=1`);
    tree = (treeData.tree || [])
      .filter(t => t.type === 'blob')
      .map(t => t.path);
  } catch (e) {
    console.error(`[SECURITY] Failed to get tree for ${repo}:`, e.message);
    return [];
  }

  // Target files most likely to have security issues
  const targetPatterns = [
    /\.(js|ts|jsx|tsx|py|rb|go|java|php)$/,  // source code
    /package\.json$/,                          // dependencies
    /requirements\.txt$/,                      // python deps
    /Gemfile$/,                                // ruby deps
    /\.env\.example$/,                         // env templates (may leak key names)
    /config\//,                                // config files
    /auth/i,                                   // auth-related
    /login|signup|register/i,                  // auth endpoints
    /api\//i,                                  // API routes
  ];

  const targetFiles = tree.filter(f =>
    targetPatterns.some(p => p.test(f))
  ).slice(0, 30); // cap to keep costs down

  if (targetFiles.length === 0) {
    console.log(`[SECURITY] No scannable files found in ${repo}`);
    return [];
  }

  // Read up to 10 key files for scanning
  const filesToScan = targetFiles.slice(0, 10);
  const fileContents = {};
  for (const filePath of filesToScan) {
    const content = await readFile(owner, repoName, filePath);
    if (content) {
      fileContents[filePath] = content.slice(0, 4000); // cap per file
    }
  }

  if (Object.keys(fileContents).length === 0) {
    console.log(`[SECURITY] Couldn't read any files from ${repo}`);
    return [];
  }

  // Build code context for Claude
  const codeContext = Object.entries(fileContents)
    .map(([path, content]) => `--- FILE: ${path} ---\n${content}`)
    .join('\n\n');

  const scanPrompt = `You are a security researcher performing responsible disclosure on a public repo that has an explicit bug bounty program. Scan this code for CLEAR, PROVABLE security vulnerabilities.

REPO: ${repo}
FILE TREE (relevant files): ${targetFiles.slice(0, 50).join(', ')}

CODE TO SCAN:
${codeContext.slice(0, 12000)}

Look for these specific vulnerability types:
1. HARDCODED_SECRET — API keys, passwords, tokens in source code (not .env.example placeholders)
2. SQL_INJECTION — String concatenation in SQL queries instead of parameterized queries
3. MISSING_INPUT_VALIDATION — Public endpoints accepting unvalidated user input
4. INSECURE_DEPENDENCY — Known vulnerable package versions in package.json/requirements.txt
5. XSS — dangerouslySetInnerHTML with user input, unescaped template interpolation
6. MISSING_RATE_LIMIT — Auth endpoints (login, register, password reset) without rate limiting
7. DEBUG_ENDPOINT — Exposed debug/test/admin routes in production code
8. MISSING_CORS — No CORS restrictions or overly permissive CORS (origin: *)

RULES:
- ONLY flag clear, provable issues with specific file paths and line references
- Do NOT flag style concerns, TODOs, or theoretical issues
- Do NOT flag things behind authentication unless auth itself is broken
- Each finding must include: the vulnerability type, severity (low/medium/high/critical), file path, description, and a proposed fix
- Be conservative — false positives waste everyone's time

Respond in JSON:
{
  "findings": [
    {
      "type": "VULNERABILITY_TYPE",
      "severity": "medium",
      "file": "path/to/file.js",
      "description": "Specific description of the vulnerability with code reference",
      "fix": "Specific description of how to fix it"
    }
  ]
}

If no clear vulnerabilities found, return: {"findings": []}`;

  try {
    const result = await askHaiku(scanPrompt, 2048);
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.findings || [];
  } catch (e) {
    console.error(`[SECURITY] Scan failed for ${repo}:`, e.message);
    return [];
  }
}

// ─── Step 3: Submit security report / generate fix PR ────
async function submitSecurityReport(repo, issue, programId) {
  const [owner, repoName] = repo.split('/');
  const findingId = crypto.randomUUID();

  // Get the program details
  const program = db.prepare('SELECT * FROM security_programs WHERE id = ?').get(programId);

  // Store the finding
  db.prepare(`
    INSERT INTO security_findings (id, program_id, repo, vulnerability_type, severity, file_path, description, fix_description, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'found', datetime('now'))
  `).run(findingId, programId, repo, issue.type, issue.severity, issue.file, issue.description, issue.fix);

  // Determine reporting method
  const securityMd = program?.security_md || '';
  const hasHackerOne = securityMd.toLowerCase().includes('hackerone');
  const hasBugcrowd = securityMd.toLowerCase().includes('bugcrowd');
  const emailMatch = securityMd.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);

  if (hasHackerOne || hasBugcrowd) {
    // Note for manual submission to bounty platform
    const platform = hasHackerOne ? 'HackerOne' : 'Bugcrowd';
    db.prepare("UPDATE security_findings SET status = 'pending_manual', fix_description = fix_description || ? WHERE id = ?")
      .run(`\n[ACTION] Submit to ${platform}: ${program?.program_url || 'see SECURITY.md'}`, findingId);

    notify('security_finding', `Security finding: ${issue.type} in ${repo}`,
      `${issue.severity.toUpperCase()} — ${issue.description.slice(0, 100)}\nSubmit to ${platform}: ${program?.program_url || 'check SECURITY.md'}`,
      { findingId, repo, type: issue.type, severity: issue.severity, platform },
      program?.program_url || '');

    console.log(`[SECURITY] Finding noted for ${platform} submission: ${issue.type} in ${repo}`);
    return { findingId, action: 'manual_submit', platform };
  }

  if (emailMatch) {
    // Note for email-based responsible disclosure
    db.prepare("UPDATE security_findings SET status = 'pending_manual', fix_description = fix_description || ? WHERE id = ?")
      .run(`\n[ACTION] Email security team: ${emailMatch[0]}`, findingId);

    notify('security_finding', `Security finding: ${issue.type} in ${repo}`,
      `${issue.severity.toUpperCase()} — ${issue.description.slice(0, 100)}\nEmail: ${emailMatch[0]}`,
      { findingId, repo, type: issue.type, severity: issue.severity, email: emailMatch[0] },
      '');

    console.log(`[SECURITY] Finding noted for email disclosure to ${emailMatch[0]}`);
    return { findingId, action: 'manual_email', email: emailMatch[0] };
  }

  // If the fix is straightforward, generate a fix PR
  const fixableTypes = ['HARDCODED_SECRET', 'SQL_INJECTION', 'XSS', 'MISSING_INPUT_VALIDATION', 'MISSING_CORS'];
  if (!fixableTypes.includes(issue.type)) {
    db.prepare("UPDATE security_findings SET status = 'reported' WHERE id = ?").run(findingId);
    return { findingId, action: 'reported_only' };
  }

  // Read the vulnerable file
  const fileContent = await readFile(owner, repoName, issue.file);
  if (!fileContent) {
    db.prepare("UPDATE security_findings SET status = 'reported' WHERE id = ?").run(findingId);
    return { findingId, action: 'reported_only', reason: 'Could not read file' };
  }

  // Generate fix with Haiku
  const fixPrompt = `You are a security researcher submitting a fix PR for a vulnerability. Generate a minimal, surgical fix.

REPO: ${repo}
VULNERABILITY: ${issue.type} — ${issue.description}
PROPOSED FIX: ${issue.fix}

CURRENT FILE (${issue.file}):
${fileContent.slice(0, 6000)}

Generate the COMPLETE fixed file content. Rules:
- ONLY fix the security issue — no refactoring, no style changes
- Keep the fix as small as possible
- Follow the existing code style exactly
- The fix must be correct and not break existing functionality

Respond in JSON:
{
  "fixed_content": "FULL file content with fix applied",
  "commit_message": "security: fix [type] in [file]",
  "pr_title": "security: fix [vulnerability] in [file]",
  "pr_body": "## Security Fix\\n\\nThis PR fixes a [type] vulnerability in \`[file]\`.\\n\\n### Details\\n[description]\\n\\n### Fix\\n[what was changed]\\n\\nThis fix follows the responsible disclosure guidelines in your SECURITY.md."
}`;

  let fix;
  try {
    const fixResult = await askHaiku(fixPrompt, 8192);
    const jsonMatch = fixResult.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Failed to parse fix');
    fix = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error(`[SECURITY] Fix generation failed for ${repo}:`, e.message);
    db.prepare("UPDATE security_findings SET status = 'reported' WHERE id = ?").run(findingId);
    return { findingId, action: 'reported_only', reason: 'Fix generation failed' };
  }

  // Fork, branch, commit, PR — same pattern as bountySolver
  try {
    // Fork (idempotent)
    try {
      await gh(`/repos/${owner}/${repoName}/forks`, { method: 'POST', body: JSON.stringify({}) });
    } catch (e) {
      await gh(`/repos/${GITHUB_USERNAME}/${repoName}`);
    }
    await new Promise(r => setTimeout(r, 3000));

    // Get default branch
    const parentRepo = await gh(`/repos/${owner}/${repoName}`);
    const defaultBranch = parentRepo.default_branch || 'main';

    // Get latest commit SHA
    const ref = await gh(`/repos/${owner}/${repoName}/git/ref/heads/${defaultBranch}`);
    const baseSha = ref.object.sha;

    // Create branch
    const branchName = `security/${issue.type.toLowerCase()}-${Date.now().toString(36)}`;
    await gh(`/repos/${GITHUB_USERNAME}/${repoName}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
    });

    // Get existing file SHA
    let fileSha = null;
    try {
      const existing = await gh(`/repos/${GITHUB_USERNAME}/${repoName}/contents/${encodeURIComponent(issue.file)}?ref=${branchName}`);
      fileSha = existing.sha;
    } catch (e) {}

    // Commit the fix
    const commitBody = {
      message: fix.commit_message || `security: fix ${issue.type.toLowerCase()} in ${issue.file}`,
      content: Buffer.from(fix.fixed_content).toString('base64'),
      branch: branchName,
    };
    if (fileSha) commitBody.sha = fileSha;

    await gh(`/repos/${GITHUB_USERNAME}/${repoName}/contents/${encodeURIComponent(issue.file)}`, {
      method: 'PUT',
      body: JSON.stringify(commitBody),
    });

    // Create PR referencing their security policy
    const prBody = [
      fix.pr_body || `## Security Fix\n\nFixes a ${issue.type} vulnerability in \`${issue.file}\`.`,
      '',
      '---',
      '**Payout info** (if bounty applies):',
      `- ETH/USDC (Ethereum/Base): \`${WALLET_ETH}\``,
      `- SOL/USDC (Solana): \`${WALLET_SOL}\``,
    ].join('\n');

    const pr = await gh(`/repos/${owner}/${repoName}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title: fix.pr_title || `security: fix ${issue.type.toLowerCase()} in ${issue.file}`,
        body: prBody,
        head: `${GITHUB_USERNAME}:${branchName}`,
        base: defaultBranch,
      }),
    });

    // Update finding with PR URL
    db.prepare("UPDATE security_findings SET pr_url = ?, status = 'submitted' WHERE id = ?")
      .run(pr.html_url, findingId);

    notify('security_pr', `Security fix PR submitted: ${repo}`,
      `${issue.type} in ${issue.file}\nPR: ${pr.html_url}\nPotential payout: $${program?.min_payout || 0}-$${program?.max_payout || 0}`,
      { findingId, repo, pr_url: pr.html_url, type: issue.type },
      pr.html_url);

    console.log(`[SECURITY] Fix PR submitted: ${pr.html_url}`);
    return { findingId, action: 'pr_submitted', pr_url: pr.html_url };
  } catch (e) {
    console.error(`[SECURITY] PR creation failed for ${repo}:`, e.message);
    db.prepare("UPDATE security_findings SET status = 'reported' WHERE id = ?").run(findingId);
    return { findingId, action: 'pr_failed', reason: e.message };
  }
}

// ─── Main: Run security scanner cycle ────────────────────
export async function runSecurityScanner() {
  const token = process.env.GITHUB_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!token || !apiKey) {
    console.log('[SECURITY] Missing GITHUB_TOKEN or ANTHROPIC_API_KEY — skipping');
    return { scanned: 0, findings: 0, log: ['Missing required API keys'] };
  }

  const log = [];
  let totalFindings = 0;
  let scanned = 0;

  // Step 1: Discover new bounty programs
  log.push('[SECURITY] Discovering bounty programs...');
  try {
    const newPrograms = await discoverBountyPrograms();
    log.push(`[SECURITY] Found ${newPrograms.length} new bounty programs`);
  } catch (e) {
    log.push(`[SECURITY] Discovery failed: ${e.message}`);
  }

  // Step 2: Pick top 3 programs to scan (prioritize by max payout, not yet scanned)
  const programs = db.prepare(`
    SELECT * FROM security_programs
    WHERE scanned_at IS NULL
       OR scanned_at < datetime('now', '-7 days')
    ORDER BY max_payout DESC, created_at ASC
    LIMIT 3
  `).all();

  log.push(`[SECURITY] Scanning ${programs.length} repos this cycle`);

  for (const program of programs) {
    try {
      log.push(`[SECURITY] Scanning ${program.repo} (bounty: $${program.min_payout}-$${program.max_payout})...`);

      // Scan for issues
      const findings = await scanForIssues(program.repo);
      scanned++;

      // Mark as scanned
      db.prepare("UPDATE security_programs SET scanned_at = datetime('now') WHERE id = ?")
        .run(program.id);

      if (findings.length === 0) {
        log.push(`[SECURITY] No issues found in ${program.repo}`);
        continue;
      }

      log.push(`[SECURITY] Found ${findings.length} potential issues in ${program.repo}`);

      // Process each finding
      for (const finding of findings) {
        // Skip if we already reported this exact issue
        const duplicate = db.prepare(
          'SELECT id FROM security_findings WHERE repo = ? AND vulnerability_type = ? AND file_path = ?'
        ).get(program.repo, finding.type, finding.file);

        if (duplicate) {
          log.push(`[SECURITY] Skipping duplicate: ${finding.type} in ${finding.file}`);
          continue;
        }

        const result = await submitSecurityReport(program.repo, finding, program.id);
        totalFindings++;
        log.push(`[SECURITY] ${finding.type} (${finding.severity}) in ${program.repo} — action: ${result.action}`);

        if (result.pr_url) {
          log.push(`[SECURITY] PR: ${result.pr_url}`);
        }
      }

      // Brief pause between repos
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      log.push(`[SECURITY] Error scanning ${program.repo}: ${e.message}`);
      console.error(`[SECURITY] Scan error for ${program.repo}:`, e.message);
    }
  }

  log.push(`[SECURITY] Done: scanned ${scanned} repos, ${totalFindings} findings`);

  if (totalFindings > 0) {
    notify('security_scan', `Security scan complete: ${totalFindings} findings`,
      `Scanned ${scanned} repos with bounty programs.\n${totalFindings} potential vulnerabilities found.`,
      { scanned, findings: totalFindings },
      '');
  }

  return { scanned, findings: totalFindings, log };
}

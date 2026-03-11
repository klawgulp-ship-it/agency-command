import db from '../db/connection.js';
import { notify } from './notifications.js';
import { humanizeCode } from './codeHumanizer.js';

const GITHUB_API = 'https://api.github.com';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const GITHUB_USERNAME = 'klawgulp-ship-it';
const SNIPELINK_API = 'https://snipelink.com/api/agent';

// Payout wallets
const WALLET_SOL = 'A9REHRDTD8DAqbiSxdiTeTA41CqdoJ4QFPzo4FCpQrtL';
const WALLET_ETH = '0x46b237D2561a520A5Ef3795911814fd5045Fe01e';

// Blocked orgs/repos — burned bridges, never submit again
const BLOCKED_REPOS = [
  '1712n/',        // blocked us — spammed them with duplicate PRs
  'CapSoftware/',  // buggy PR, closed
];

function isBlockedRepo(repo) {
  return BLOCKED_REPOS.some(b => repo.startsWith(b));
}

async function generateBountyPaymentLink(bountyId, reward, title) {
  const apiKey = process.env.SNIPELINK_API_KEY;
  const productId = process.env.SNIPELINK_PRODUCT_ID;

  if (!apiKey || !productId) {
    // Fallback to direct profile link
    const ref = `bounty-${bountyId.slice(0, 8)}`;
    return `https://snipelink.com/@agencycommand/bounty?meta=${encodeURIComponent(JSON.stringify({ bountyId, reward }))}`;
  }

  try {
    const res = await fetch(`${SNIPELINK_API}/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        productId,
        metadata: JSON.stringify({ bountyId, reward, title: title.slice(0, 60) }),
      }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (data.checkoutUrl) {
      db.prepare("UPDATE bounties SET notes = COALESCE(notes, '') || ? WHERE id = ?")
        .run(`\nPayment URL: ${data.checkoutUrl}`, bountyId);
      return data.checkoutUrl;
    }
  } catch (e) {
    console.error('[SOLVER] SnipeLink checkout failed:', e.message);
  }

  // Fallback
  return `https://snipelink.com/@agencycommand/bounty`;
}

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

// Cheap + fast for screening, Sonnet for actual fixes
const askHaiku = (prompt, maxTokens = 1024) => askClaude(prompt, maxTokens, 'claude-haiku-4-5-20251001');
const askSonnet = (prompt, maxTokens = 8192) => askClaude(prompt, maxTokens, 'claude-sonnet-4-6');

// ─── Step 1: Pick best solvable bounties ────────────────
function pickBounties(limit = 3) {
  return db.prepare(`
    SELECT * FROM bounties
    WHERE status = 'open'
      AND claimed = 0
      AND roi_score >= 20
      AND difficulty IN ('easy', 'medium')
      AND reward >= 25
      AND repo != ''
      AND (notes IS NULL OR notes NOT LIKE '%${new Date().toISOString().slice(0,10)}%')
    ORDER BY
      CASE source WHEN 'Verified' THEN 0 WHEN 'AutoMerge' THEN 1 ELSE 2 END,
      CASE difficulty WHEN 'easy' THEN 0 ELSE 1 END,
      CASE
        WHEN labels LIKE '%typo%' OR title LIKE '%typo%' THEN 0
        WHEN labels LIKE '%docs%' OR labels LIKE '%documentation%' THEN 1
        WHEN labels LIKE '%bug%' AND labels LIKE '%good first issue%' THEN 2
        WHEN labels LIKE '%bug%' THEN 3
        WHEN labels LIKE '%config%' OR labels LIKE '%ci%' THEN 4
        ELSE 5
      END,
      roi_score DESC,
      reward DESC
    LIMIT ?
  `).all(limit).map(b => ({
    ...b,
    labels: JSON.parse(b.labels || '[]'),
    skills: JSON.parse(b.skills || '[]'),
  }));
}

// ─── Step 2: Read repo context ──────────────────────────
async function getRepoContext(owner, repo, issueNumber) {
  const context = { files: [], readme: '', tree: [] };

  // Get issue details with comments
  try {
    const issue = await gh(`/repos/${owner}/${repo}/issues/${issueNumber}`);
    context.issueBody = issue.body || '';
    context.issueTitle = issue.title || '';
  } catch (e) {
    console.error(`[SOLVER] Failed to get issue: ${e.message}`);
  }

  // Get issue comments for extra context
  try {
    const comments = await gh(`/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=10`);
    context.comments = comments.map(c => c.body).join('\n---\n');
  } catch (e) { context.comments = ''; }

  // Get repo tree (top-level + src)
  try {
    const tree = await gh(`/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`);
    context.tree = (tree.tree || [])
      .filter(t => t.type === 'blob')
      .map(t => t.path)
      .slice(0, 200); // cap for context window
  } catch (e) { context.tree = []; }

  // Get README
  try {
    const readme = await gh(`/repos/${owner}/${repo}/readme`);
    if (readme.content) {
      context.readme = Buffer.from(readme.content, 'base64').toString('utf-8').slice(0, 2000);
    }
  } catch (e) { context.readme = ''; }

  // Get CONTRIBUTING.md — follow their rules or get rejected
  context.contributing = '';
  for (const path of ['CONTRIBUTING.md', 'contributing.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md']) {
    try {
      const file = await gh(`/repos/${owner}/${repo}/contents/${path}`);
      if (file.content) {
        context.contributing = Buffer.from(file.content, 'base64').toString('utf-8').slice(0, 2000);
        break;
      }
    } catch (e) {}
  }

  return context;
}

// ─── Step 3: Read specific files ────────────────────────
async function readFile(owner, repo, path, ref = 'HEAD') {
  try {
    const file = await gh(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${ref}`);
    if (file.content) {
      return Buffer.from(file.content, 'base64').toString('utf-8');
    }
  } catch (e) {}
  return null;
}

// ─── Step 4: Ask Claude to analyze + solve ──────────────
async function analyzeBounty(bounty, repoContext) {
  const fileList = repoContext.tree.join('\n');

  // Phase 1: Analyze which files need changes
  const analysisPrompt = `You are an expert developer analyzing a GitHub bounty to solve it.

ISSUE TITLE: ${repoContext.issueTitle || bounty.title}
ISSUE BODY:
${(repoContext.issueBody || bounty.description).slice(0, 3000)}

COMMENTS:
${(repoContext.comments || '').slice(0, 1500)}

REPO FILE TREE:
${fileList.slice(0, 3000)}

README (excerpt):
${repoContext.readme.slice(0, 1000)}

Analyze this issue and determine:
1. Can this be solved with code changes? (yes/no)
2. Which specific files need to be modified? (max 3 files)
3. What's the nature of the fix? (bug fix, feature, docs, refactor, etc.)
4. Confidence level: high/medium/low
5. Brief description of the fix needed (1-2 sentences)

IMPORTANT: Only say "yes" if this is clearly solvable from the information provided. If it requires access to a database, external service, or extensive architectural knowledge you don't have, say "no".

Respond in this exact JSON format:
{"solvable": true/false, "files": ["path/to/file1.ts", "path/to/file2.ts"], "fix_type": "bug_fix", "confidence": "high", "description": "Brief fix description"}`;

  const analysis = await askHaiku(analysisPrompt, 1024);

  // Parse JSON from response
  const jsonMatch = analysis.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { solvable: false, reason: 'Failed to parse analysis' };

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    return { solvable: false, reason: 'Invalid JSON in analysis' };
  }
}

async function generateFix(bounty, repoContext, analysis, fileContents) {
  const filesContext = Object.entries(fileContents)
    .map(([path, content]) => `--- FILE: ${path} ---\n${content?.slice(0, 4000) || '(new file)'}`)
    .join('\n\n');

  const contributingRules = repoContext.contributing
    ? `\nCONTRIBUTING GUIDELINES (YOU MUST FOLLOW THESE):\n${repoContext.contributing.slice(0, 1000)}\n`
    : '';

  const fixPrompt = `You are an expert developer submitting a PR that MUST be merged. Quality is everything.

ISSUE: ${repoContext.issueTitle || bounty.title}
DESCRIPTION:
${(repoContext.issueBody || bounty.description).slice(0, 1500)}

FIX NEEDED: ${analysis.description}
${contributingRules}
CURRENT FILES:
${filesContext}

CRITICAL JSON RULES:
- Your entire response must be valid JSON — no markdown, no backticks, no text outside the JSON
- Escape all special characters in strings: newlines as \\n, tabs as \\t, quotes as \\"
- Keep file content SHORT — only include the necessary code
- If a file would be very large (>200 lines), break it into smaller focused files

Respond in this exact JSON format:
{
  "changes": [
    {"path": "path/to/file.ts", "content": "FULL updated file content here", "description": "What changed"}
  ],
  "commit_message": "fix: brief description of fix",
  "pr_title": "fix: brief PR title (under 72 chars)",
  "pr_body": "## What\\n- Description of changes\\n\\n## Why\\n- Fixes #ISSUE_NUMBER"
}

RULES:
- Include the COMPLETE file content, not just the diff
- Keep changes minimal and surgical
- Follow the existing code style exactly
- Do NOT add unnecessary comments, refactoring, or changes
- The commit message should start with fix:, feat:, docs:, or chore:
- Use the correct import paths, function names, and types from the existing codebase
- Make sure all new functions are actually called/wired up — no dead code
- Double-check that variable names, API endpoints, and schemas match existing patterns
- If unsure about framework-specific details, keep the change as simple as possible`;

  // Use Haiku for easy bounties (60x cheaper), Sonnet for medium
  const useHaiku = bounty.difficulty === 'easy';
  const result = useHaiku
    ? await askHaiku(fixPrompt, 8192)
    : await askSonnet(fixPrompt, 16384);

  const jsonMatch = result.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Failed to parse fix');

  let fix;
  try {
    fix = JSON.parse(jsonMatch[0]);
  } catch (e) {
    const partial = jsonMatch[0];
    const lastComplete = partial.lastIndexOf('"}');
    if (lastComplete > 0) {
      const repaired = partial.slice(0, lastComplete + 2) + '],"commit_message":"fix: resolve issue","pr_title":"fix: resolve issue","pr_body":"Fixes the issue"}';
      try { fix = JSON.parse(repaired); } catch (e2) {}
    }
    if (!fix) throw new Error('Failed to parse fix JSON');
  }

  // ── QUALITY GATE: Haiku reviews the fix before we submit ──
  // Costs ~$0.001 but saves us from submitting broken PRs
  const changesSummary = (fix.changes || [])
    .map(c => `FILE: ${c.path}\nCHANGES: ${c.description}\nCODE (first 2000 chars):\n${(c.content || '').slice(0, 2000)}`)
    .join('\n---\n');

  const reviewPrompt = `You are a senior code reviewer. A developer wants to submit this PR to fix a GitHub issue. Review it for OBVIOUS bugs only.

ISSUE: ${repoContext.issueTitle || bounty.title}
FIX DESCRIPTION: ${analysis.description}

PROPOSED CHANGES:
${changesSummary.slice(0, 4000)}

Check ONLY for:
1. Wrong import paths or function names that don't exist
2. Missing function calls (defined but never invoked)
3. Syntax errors
4. Obviously wrong logic (off-by-one, wrong variable, etc.)
5. Missing required parameters

Do NOT flag style preferences, missing tests, or nice-to-haves.

Respond with JSON: {"pass": true/false, "issues": ["issue1", "issue2"]}
If the code looks correct enough to merge, pass it.`;

  const reviewResult = await askHaiku(reviewPrompt, 512);
  const reviewMatch = reviewResult.match(/\{[\s\S]*\}/);
  if (reviewMatch) {
    try {
      const review = JSON.parse(reviewMatch[0]);
      if (!review.pass) {
        console.log(`[SOLVER] Quality gate FAILED:`, review.issues?.join(', '));
        throw new Error(`Quality gate: ${(review.issues || []).slice(0, 2).join('; ')}`);
      }
      console.log(`[SOLVER] Quality gate PASSED`);
    } catch (e) {
      if (e.message.startsWith('Quality gate')) throw e;
      // If review JSON parsing fails, let it through
    }
  }

  return fix;
}

// ─── Step 4b: Check repo merge cadence ──────────────────
async function getRepoMergeSpeed(owner, repo) {
  try {
    // Check recent closed PRs to gauge how fast maintainers merge
    const prs = await gh(`/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=10`);
    if (!prs.length) return { speed: 'unknown', avgDays: 14 }; // no PRs = new repo, give it a shot

    let mergedCount = 0;
    let totalDays = 0;
    for (const pr of prs) {
      if (pr.merged_at) {
        mergedCount++;
        const created = new Date(pr.created_at);
        const merged = new Date(pr.merged_at);
        totalDays += (merged - created) / (1000 * 60 * 60 * 24);
      }
    }

    // If repo has PRs but none merged in last 90 days, skip
    if (mergedCount === 0 && prs.length > 3) {
      return { speed: 'dead', avgDays: 999, mergedCount: 0 };
    }
    if (mergedCount === 0) return { speed: 'unknown', avgDays: 14 }; // PRs exist but none merged — still try
    const avgDays = totalDays / mergedCount;
    const speed = avgDays <= 3 ? 'fast' : avgDays <= 14 ? 'medium' : 'slow';
    return { speed, avgDays: Math.round(avgDays * 10) / 10, mergedCount };
  } catch (e) {
    return { speed: 'unknown', avgDays: 99 };
  }
}

// ─── Step 5: Fork, commit, and PR ───────────────────────
async function forkAndPR(owner, repo, issueNumber, fix) {
  // Fork the repo (idempotent — returns existing fork if already forked)
  console.log(`[SOLVER] Forking ${owner}/${repo}...`);
  let fork;
  try {
    fork = await gh(`/repos/${owner}/${repo}/forks`, { method: 'POST', body: JSON.stringify({}) });
  } catch (e) {
    // Fork might already exist
    fork = await gh(`/repos/${GITHUB_USERNAME}/${repo}`);
  }

  // Wait for fork to be ready
  await new Promise(r => setTimeout(r, 3000));

  // Auto-setup webhook on fork for instant PR review/merge notifications
  try {
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
    const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
    if (webhookSecret && railwayDomain) {
      const webhookUrl = `https://${railwayDomain}/api/github/webhook`;
      await gh(`/repos/${GITHUB_USERNAME}/${repo}/hooks`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'web', active: true,
          events: ['pull_request', 'pull_request_review', 'pull_request_review_comment'],
          config: { url: webhookUrl, content_type: 'json', secret: webhookSecret },
        }),
      });
      console.log(`[SOLVER] Webhook installed on fork ${GITHUB_USERNAME}/${repo}`);
    }
  } catch (e) { /* webhook already exists or permission issue — non-fatal */ }

  // Get default branch
  const parentRepo = await gh(`/repos/${owner}/${repo}`);
  const defaultBranch = parentRepo.default_branch || 'main';

  // Get latest commit SHA from parent
  const ref = await gh(`/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`);
  const baseSha = ref.object.sha;

  // Create branch on fork
  const branchName = `fix/issue-${issueNumber}-${Date.now().toString(36)}`;
  try {
    await gh(`/repos/${GITHUB_USERNAME}/${repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
    });
  } catch (e) {
    console.error(`[SOLVER] Branch creation failed: ${e.message}`);
    throw e;
  }

  // Commit each changed file
  for (const change of fix.changes) {
    console.log(`[SOLVER] Updating ${change.path}...`);

    // Check if file exists to get its SHA (needed for updates)
    let fileSha = null;
    try {
      const existing = await gh(`/repos/${GITHUB_USERNAME}/${repo}/contents/${encodeURIComponent(change.path)}?ref=${branchName}`);
      fileSha = existing.sha;
    } catch (e) { /* new file */ }

    const body = {
      message: fix.commit_message,
      content: Buffer.from(change.content).toString('base64'),
      branch: branchName,
    };
    if (fileSha) body.sha = fileSha;

    await gh(`/repos/${GITHUB_USERNAME}/${repo}/contents/${encodeURIComponent(change.path)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  // Create PR with professional description
  console.log(`[SOLVER] Creating PR...`);
  const changeDescriptions = fix.changes.map(c => `- ${c.description || `Updated \`${c.path}\``}`).join('\n');
  const prTitle = fix.pr_title || fix.commit_message;
  const prBodyText = [
    `## Summary`,
    ``,
    fix.pr_body?.replace('#ISSUE_NUMBER', `#${issueNumber}`) || `This PR addresses the issue described in #${issueNumber}.`,
    ``,
    `## Changes`,
    ``,
    changeDescriptions,
    ``,
    `## Testing`,
    ``,
    `- Verified the changes align with the issue requirements`,
    `- Kept modifications minimal and surgical to reduce review burden`,
    ``,
    `Closes #${issueNumber}`,
    ``,
    `---`,
    `**Payout info** (if bounty applies):`,
    `- ETH/USDC (Ethereum/Base): \`${WALLET_ETH}\``,
    `- SOL/USDC (Solana): \`${WALLET_SOL}\``,
  ].join('\n');

  const pr = await gh(`/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: prTitle,
      body: prBodyText,
      head: `${GITHUB_USERNAME}:${branchName}`,
      base: defaultBranch,
    }),
  });

  return { pr_url: pr.html_url, pr_number: pr.number, branch: branchName, issueNumber };
}

// ─── Main: Auto-solve a single bounty ───────────────────
async function solveBounty(bounty) {
  const [owner, repo] = bounty.repo.split('/');
  if (!owner || !repo) throw new Error(`Invalid repo: ${bounty.repo}`);

  // Block burned bridges
  if (isBlockedRepo(bounty.repo)) {
    return { success: false, reason: 'Blocked repo' };
  }

  // Skip repos that haven't been pushed to in 6+ months
  const cached = db.prepare("SELECT value FROM settings WHERE key = ?").get(`repo_activity:${bounty.repo}`);
  if (cached) {
    try {
      const activity = JSON.parse(cached.value);
      if (activity.daysSincePush > 180) {
        return { success: false, reason: `Dead repo (${activity.daysSincePush}d inactive)` };
      }
    } catch (e) {}
  }

  // Extract issue number from URL
  const issueMatch = bounty.issue_url.match(/\/issues\/(\d+)/);
  if (!issueMatch) throw new Error(`Can't extract issue number from ${bounty.issue_url}`);
  const issueNumber = issueMatch[1];

  // ── DEDUP: Check if we already have an open PR for this issue ──
  try {
    // Only check OUR PRs — filter by our username
    const existingPRs = (await gh(`/repos/${owner}/${repo}/pulls?state=open&per_page=50`))
      .filter(pr => pr.user?.login === GITHUB_USERNAME || (pr.head?.label || '').startsWith(GITHUB_USERNAME));

    // HARD LIMIT: max 1 open PR per repo — never spam again
    if (existingPRs.length >= 1) {
      console.log(`[SOLVER] Skipping — already have ${existingPRs.length} open PR(s) on ${owner}/${repo}`);
      db.prepare("UPDATE bounties SET notes = COALESCE(notes, '') || ?, updated_at = datetime('now') WHERE id = ?")
        .run(`\n[SKIP] Repo already has open PR`, bounty.id);
      return { success: false, reason: `Already have open PR on ${owner}/${repo}` };
    }

    const alreadySubmitted = existingPRs.some(pr => {
      const ref = pr.head?.ref || '';
      const closesMatch = (pr.body || '').match(/(?:closes|fixes|resolves)\s+#(\d+)/gi) || [];
      const closesIssues = closesMatch.map(m => m.match(/#(\d+)/)?.[1]);
      return closesIssues.includes(issueNumber) || ref.includes(`issue-${issueNumber}-`);
    });
    if (alreadySubmitted) {
      console.log(`[SOLVER] Skipping — already have open PR for ${owner}/${repo}#${issueNumber}`);
      // Mark in DB so we don't keep retrying
      db.prepare("UPDATE bounties SET claimed = 1, submitted = 1, status = 'submitted', updated_at = datetime('now') WHERE id = ?").run(bounty.id);
      return { success: false, reason: 'Already have open PR for this issue' };
    }
  } catch (e) {
    // Non-fatal — continue if check fails
  }

  console.log(`[SOLVER] Analyzing: ${bounty.title} (${bounty.repo}#${issueNumber})`);

  // Check repo merge speed — only skip repos with proven slow merge history
  const mergeSpeed = await getRepoMergeSpeed(owner, repo);
  console.log(`[SOLVER] Repo ${bounty.repo} merge speed: ${mergeSpeed.speed} (avg ${mergeSpeed.avgDays}d)`);
  if (mergeSpeed.speed === 'slow' || mergeSpeed.speed === 'dead') {
    return { success: false, reason: `Slow merge repo (avg ${mergeSpeed.avgDays}d)` };
  }

  // Get repo context
  const repoContext = await getRepoContext(owner, repo, issueNumber);

  // Analyze if solvable
  const analysis = await analyzeBounty(bounty, repoContext);
  console.log(`[SOLVER] Analysis:`, JSON.stringify(analysis));

  if (!analysis.solvable) {
    console.log(`[SOLVER] Skipping — not solvable: ${analysis.reason || 'low confidence'}`);
    return { success: false, reason: analysis.reason || 'Not solvable' };
  }

  if (analysis.confidence === 'low') {
    console.log(`[SOLVER] Skipping — low confidence`);
    return { success: false, reason: 'Low confidence' };
  }

  // Skip if fix requires too many files — smaller PRs merge faster
  if ((analysis.files || []).length > 3) {
    return { success: false, reason: 'Too many files — keeping PRs small for merge rate' };
  }

  // Read the files that need changes
  const fileContents = {};
  for (const filePath of (analysis.files || []).slice(0, 3)) {
    fileContents[filePath] = await readFile(owner, repo, filePath);
  }

  // If no existing files found, this might be a new-file task — that's ok
  const hasExistingFiles = Object.values(fileContents).some(v => v);
  if (!hasExistingFiles && analysis.fix_type !== 'feature' && analysis.fix_type !== 'docs') {
    console.log(`[SOLVER] Skipping — couldn't read any target files`);
    return { success: false, reason: 'Could not read target files' };
  }

  // For new features, try to read nearby files for style context
  if (!hasExistingFiles && repoContext.tree.length > 0) {
    const relevantFiles = repoContext.tree
      .filter(f => f.match(/\.(ts|js|py|rs|go)$/))
      .slice(0, 3);
    for (const f of relevantFiles) {
      const content = await readFile(owner, repo, f);
      if (content) { fileContents[`[STYLE REF] ${f}`] = content.slice(0, 3000); break; }
    }
  }

  // Generate the fix
  console.log(`[SOLVER] Generating fix for ${analysis.files?.length || 0} files...`);
  const fix = await generateFix(bounty, repoContext, analysis, fileContents);

  if (!fix.changes || fix.changes.length === 0) {
    return { success: false, reason: 'No changes generated' };
  }

  // ── HUMANIZER: Make code indistinguishable from senior dev ──
  try {
    console.log(`[SOLVER] Humanizing code to match repo style...`);
    fix.changes = await humanizeCode(fix.changes, {
      ...repoContext,
      existingFileContents: fileContents,
    });
    console.log(`[SOLVER] Code humanized — AI tells stripped, style matched`);
  } catch (e) {
    console.error(`[SOLVER] Humanizer failed (using original): ${e.message}`);
    // Non-fatal — proceed with original code
  }

  // Fork, commit, and PR
  const result = await forkAndPR(owner, repo, issueNumber, fix);

  // Update bounty status with PR URL
  db.prepare(`
    UPDATE bounties SET
      claimed = 1, submitted = 1,
      status = 'submitted',
      notes = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(`Auto-solved. PR: ${result.pr_url}\nIssue: #${issueNumber}`, bounty.id);

  return { success: true, ...result };
}

// ─── Run auto-solver cycle ──────────────────────────────
export async function runAutoSolver() {
  const token = process.env.GITHUB_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!token || !apiKey) {
    console.log('[SOLVER] Missing GITHUB_TOKEN or ANTHROPIC_API_KEY — skipping');
    return { solved: 0, log: ['Missing required API keys'] };
  }

  const log = [];
  let solved = 0;

  // Pick top solvable bounties — 15 per cycle, max throughput
  const bounties = pickBounties(15);
  log.push(`[SOLVER] Found ${bounties.length} candidate bounties`);

  // Solve in parallel batches of 5
  const batchSize = 5;
  for (let i = 0; i < bounties.length; i += batchSize) {
    const batch = bounties.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (bounty) => {
        log.push(`[SOLVER] Attempting: $${bounty.reward} — ${bounty.title.slice(0, 50)}`);
        const result = await solveBounty(bounty);

        if (result.success) {
          solved++;
          log.push(`[SOLVER] ✓ PR submitted: ${result.pr_url}`);
          notify('bounty_solved', `Bounty auto-solved: $${bounty.reward}`,
            `PR submitted for "${bounty.title.slice(0, 50)}"\n${result.pr_url}`,
            { bountyId: bounty.id, reward: bounty.reward, pr_url: result.pr_url },
            result.pr_url);
        } else {
          log.push(`[SOLVER] ✗ Skipped: ${result.reason}`);
          db.prepare("UPDATE bounties SET notes = COALESCE(notes, '') || ?, updated_at = datetime('now') WHERE id = ?")
            .run(`\n[${new Date().toISOString().slice(0,10)}] Auto-solve skipped: ${result.reason}`, bounty.id);
        }
        return result;
      })
    );

    // Log any crashes
    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'rejected') {
        log.push(`[SOLVER] ✗ Error: ${results[j].reason?.message || 'Unknown'}`);
      }
    }

    // Brief pause between batches to respect rate limits
    if (i + batchSize < bounties.length) await new Promise(r => setTimeout(r, 1000));
  }

  log.push(`[SOLVER] Done: ${solved}/${bounties.length} bounties solved`);
  return { solved, total: bounties.length, log };
}

// ─── Blitz mode: rapid-fire easy bounties ────────────────
export async function runBlitzSolver() {
  const token = process.env.GITHUB_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!token || !apiKey) return { solved: 0, log: ['Missing API keys'] };

  const log = [];
  let solved = 0;

  // Only pick easy bounties with any reward — cast widest net
  const bounties = db.prepare(`
    SELECT * FROM bounties
    WHERE status = 'open'
      AND claimed = 0
      AND difficulty = 'easy'
      AND reward >= 10
      AND repo != ''
      AND (notes IS NULL OR notes NOT LIKE '%${new Date().toISOString().slice(0,10)}%')
    ORDER BY reward DESC
    LIMIT 10
  `).all().map(b => ({
    ...b,
    labels: JSON.parse(b.labels || '[]'),
    skills: JSON.parse(b.skills || '[]'),
  }));

  log.push(`[BLITZ] Found ${bounties.length} easy bounties`);

  // All at once — max parallelism
  const results = await Promise.allSettled(
    bounties.map(async (bounty) => {
      try {
        log.push(`[BLITZ] $${bounty.reward} — ${bounty.title.slice(0, 50)}`);
        const result = await solveBounty(bounty);
        if (result.success) {
          solved++;
          log.push(`[BLITZ] ✓ PR: ${result.pr_url}`);
          notify('bounty_solved', `Blitz solve: $${bounty.reward}`,
            `"${bounty.title.slice(0, 50)}"\n${result.pr_url}`,
            { bountyId: bounty.id, reward: bounty.reward, pr_url: result.pr_url },
            result.pr_url);
        } else {
          log.push(`[BLITZ] ✗ ${result.reason}`);
          db.prepare("UPDATE bounties SET notes = COALESCE(notes, '') || ?, updated_at = datetime('now') WHERE id = ?")
            .run(`\n[${new Date().toISOString().slice(0,10)}] Blitz skipped: ${result.reason}`, bounty.id);
        }
        return result;
      } catch (e) {
        log.push(`[BLITZ] ✗ Error: ${e.message}`);
        return { success: false, reason: e.message };
      }
    })
  );

  log.push(`[BLITZ] Done: ${solved}/${bounties.length}`);
  return { solved, total: bounties.length, log };
}

// ─── Sync open PRs back to bounties DB (survives Railway resets) ──
export async function syncSubmittedBounties() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log('[SYNC] Missing GITHUB_TOKEN — skipping');
    return 0;
  }

  let synced = 0;
  try {
    // Paginate through all open PRs by our user
    let page = 1;
    let allPRs = [];
    while (true) {
      const prs = await gh(`/search/issues?q=is:pr+is:open+author:${GITHUB_USERNAME}&per_page=100&page=${page}`);
      if (!prs.items || prs.items.length === 0) break;
      allPRs = allPRs.concat(prs.items);
      if (allPRs.length >= (prs.total_count || 0)) break;
      page++;
    }

    console.log(`[SYNC] Found ${allPRs.length} open PRs by ${GITHUB_USERNAME}`);

    for (const pr of allPRs) {
      // Extract issue number from PR body: "Closes #123" or standalone "#123"
      const body = pr.body || '';
      const issueMatch = body.match(/(?:closes|fixes|resolves)\s+#(\d+)/i) || body.match(/#(\d+)/);
      if (!issueMatch) continue;

      const issueNumber = issueMatch[1];

      // Extract owner/repo from the PR's html_url (e.g. https://github.com/owner/repo/pull/45)
      const repoMatch = pr.html_url.match(/github\.com\/([^/]+)\/([^/]+)\/pull/);
      if (!repoMatch) continue;
      const [, owner, repo] = repoMatch;

      // Find matching bounty by issue_url containing this repo and issue number
      const bounty = db.prepare(`
        SELECT id, status FROM bounties
        WHERE issue_url LIKE ? AND issue_url LIKE ?
        LIMIT 1
      `).get(`%${owner}/${repo}%`, `%/issues/${issueNumber}%`);

      if (bounty) {
        if (bounty.status === 'submitted' || bounty.status === 'completed') continue;
        db.prepare(`
          UPDATE bounties SET
            status = 'submitted',
            claimed = 1,
            submitted = 1,
            notes = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(`[SYNC] PR: ${pr.html_url}`, bounty.id);
        synced++;
        console.log(`[SYNC] Restored submitted status for bounty ${bounty.id} — PR: ${pr.html_url}`);
      } else {
        // No matching bounty in DB — create one from the PR info
        const issueUrl = `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
        const repoFull = `${owner}/${repo}`;
        // Extract reward from PR body if possible
        const rewardMatch = body.match(/\$([\d,]+)/);
        const reward = rewardMatch ? parseInt(rewardMatch[1].replace(/,/g, '')) : 0;
        const id = `sync-${owner}-${repo}-${issueNumber}`;
        try {
          db.prepare(`
            INSERT OR IGNORE INTO bounties (id, title, source, platform, repo, repo_url, issue_url, reward, currency, labels, skills, description, difficulty, roi_score, est_hours, status, claimed, submitted, notes, external_id)
            VALUES (?, ?, 'Sync', 'github', ?, ?, ?, ?, 'USD', '[]', '[]', '', 'medium', 50, 2, 'submitted', 1, 1, ?, ?)
          `).run(id, pr.title, repoFull, `https://github.com/${repoFull}`, issueUrl, reward, `[SYNC] PR: ${pr.html_url}`, `sync-${pr.number}`);
          synced++;
          console.log(`[SYNC] Created + marked submitted: ${repoFull}#${issueNumber} — PR: ${pr.html_url}`);
        } catch (e) { /* already exists */ }
      }
    }
  } catch (e) {
    console.error('[SYNC] Failed to sync submitted bounties:', e.message);
  }

  console.log(`[SYNC] Synced ${synced} bounties from open PRs`);
  return synced;
}

// ─── Check PR status for submitted bounties ─────────────
export async function checkSubmittedBounties() {
  const submitted = db.prepare("SELECT * FROM bounties WHERE status = 'submitted' AND notes LIKE '%PR:%'").all();

  for (const b of submitted) {
    const prMatch = b.notes.match(/https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!prMatch) continue;

    const [, owner, repo, prNum] = prMatch;
    try {
      const pr = await gh(`/repos/${owner}/${repo}/pulls/${prNum}`);
      if (pr.merged) {
        // Generate SnipeLink payment link
        const paymentLink = await generateBountyPaymentLink(b.id, b.reward, b.title);

        // Auto-comment on the issue claiming the bounty with payment link
        const issueMatch = b.issue_url.match(/\/issues\/(\d+)/);
        if (issueMatch) {
          try {
            await gh(`/repos/${owner}/${repo}/issues/${issueMatch[1]}/comments`, {
              method: 'POST',
              body: JSON.stringify({
                body: `## Bounty Claim\n\nHey! My PR #${prNum} has been merged resolving this issue.\n\nIf there's a bounty attached, you can send the payout here:\n\n**💳 [Pay via SnipeLink](${paymentLink})** (card, PayPal, or crypto)\n\n**Direct crypto:**\n- ETH/USDC (Ethereum/Base): \`${WALLET_ETH}\`\n- SOL/USDC (Solana): \`${WALLET_SOL}\`\n\nThanks for the opportunity!`
              }),
            });
            console.log(`[SOLVER] Posted payment claim on ${owner}/${repo}#${issueMatch[1]}`);
          } catch (e) {
            console.error(`[SOLVER] Failed to comment on issue: ${e.message}`);
          }
        }

        db.prepare("UPDATE bounties SET status = 'completed', completed = 1, notes = COALESCE(notes, '') || ?, updated_at = datetime('now') WHERE id = ?")
          .run(`\n[MERGED] Payment link: ${paymentLink}`, b.id);

        notify('bounty_merged', `PR merged! Claim posted for $${b.reward}`,
          `"${b.title.slice(0, 50)}" — payment link auto-posted on issue.\n${paymentLink}`,
          { bountyId: b.id, reward: b.reward, paymentLink, pr_url: prMatch[0] },
          b.issue_url);

      } else if (pr.state === 'open') {
        // Auto-follow-up on stale PRs (no activity for 48h)
        const updatedAt = new Date(pr.updated_at);
        const hoursStale = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60);
        const alreadyFollowedUp = (b.notes || '').includes('[FOLLOW-UP]');

        if (hoursStale >= 48 && !alreadyFollowedUp) {
          try {
            await gh(`/repos/${owner}/${repo}/pulls/${prNum}/comments`, {
              method: 'POST',
              body: JSON.stringify({
                body: `Hey! Just checking in — is there anything I should adjust in this PR? Happy to make changes if needed. Let me know! 🙏`
              }),
            });
            db.prepare("UPDATE bounties SET notes = COALESCE(notes, '') || ?, updated_at = datetime('now') WHERE id = ?")
              .run(`\n[FOLLOW-UP] Nudged at ${new Date().toISOString().slice(0,10)}`, b.id);
            console.log(`[SOLVER] Follow-up posted on ${owner}/${repo}#${prNum} (${Math.round(hoursStale)}h stale)`);
          } catch (e) {
            console.error(`[SOLVER] Follow-up failed: ${e.message}`);
          }
        }
      } else if (pr.state === 'closed') {
        db.prepare("UPDATE bounties SET status = 'open', claimed = 0, submitted = 0, notes = COALESCE(notes, '') || '\n[Rejected] PR closed without merge', updated_at = datetime('now') WHERE id = ?").run(b.id);
        notify('bounty_rejected', `PR rejected: ${b.title.slice(0, 40)}`,
          `PR #${prNum} was closed without merge. Bounty returned to open pool.`,
          { bountyId: b.id }, prMatch[0]);
      }
    } catch (e) {
      console.error(`[SOLVER] PR check failed for ${b.id}:`, e.message);
    }
  }
}

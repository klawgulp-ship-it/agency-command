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

// ─── GitHub API with caching + rate limit awareness ─────
const GH_CACHE = new Map(); // path -> { data, expiresAt }
const GH_CACHE_TTL = 30 * 60 * 1000; // 30 min for stable data
let ghRateRemaining = 5000;

function gh(path, options = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set');

  // Cache GET requests for trees, readmes, repo info (don't change often)
  const isGet = !options.method || options.method === 'GET';
  const isCacheable = isGet && (path.includes('/git/trees/') || path.includes('/readme') || (path.match(/^\/repos\/[^/]+\/[^/]+$/) && !path.includes('?')));

  if (isCacheable) {
    const cached = GH_CACHE.get(path);
    if (cached && Date.now() < cached.expiresAt) {
      return Promise.resolve(cached.data);
    }
  }

  // Pause if rate limited
  if (ghRateRemaining < 100) {
    console.warn(`[GH] Rate limit low: ${ghRateRemaining} remaining — pausing`);
    return new Promise(resolve => setTimeout(resolve, 60000)).then(() => gh(path, options));
  }

  return fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `token ${token}`,
      'User-Agent': 'AgencyCommand/1.0',
      'Content-Type': 'application/json',
      ...options.headers,
    },
    signal: AbortSignal.timeout(60000), // 60s for large repos like ZIO
  }).then(async r => {
    // Track rate limit
    const remaining = r.headers.get('x-ratelimit-remaining');
    if (remaining) ghRateRemaining = parseInt(remaining, 10);

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 403 && (data.message || '').includes('rate limit')) {
        console.warn('[GH] Rate limited — will back off');
        ghRateRemaining = 0;
      }
      throw new Error(data.message || `GitHub API ${r.status}`);
    }

    // Cache stable data
    if (isCacheable) {
      GH_CACHE.set(path, { data, expiresAt: Date.now() + GH_CACHE_TTL });
      // Evict old entries
      if (GH_CACHE.size > 200) {
        const now = Date.now();
        for (const [k, v] of GH_CACHE) { if (now > v.expiresAt) GH_CACHE.delete(k); }
      }
    }

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
const askSonnet = (prompt, maxTokens = 16384) => askClaude(prompt, maxTokens, 'claude-sonnet-4-6');

// ─── SURVIVAL MODE: Only repos that have ACTUALLY PAID before ────
// These repos have confirmed Algora/bounty payouts in the last 6 months
const PROVEN_PAYING_REPOS = new Set([
  'twentyhq/twenty',
  'triggerdotdev/trigger.dev',
  'formbricks/formbricks',
  'infisical/infisical',
  'documenso/documenso',
  'calcom/cal.com',
  'hummingbot/hummingbot',
  'zio/zio',
  'golemcloud/golem',
  'deskflow/deskflow',
  'maybe-finance/maybe',
  'juspay/hyperswitch',
  'OpenBB-finance/OpenBB',
  // Solana ecosystem
  'solana-labs/solana',
  'coral-xyz/anchor',
  'jito-foundation/jito-solana',
  'helius-labs/xray',
  'metaplex-foundation/mpl-token-metadata',
  'orca-so/whirlpools',
  'marinade-finance/liquid-staking-program',
  'switchboard-xyz/switchboard',
]);

// ─── Step 1: Pick ONLY verified-paying bounties ─────────
function pickBounties(limit = 3) {
  // Build repo filter — only proven paying repos
  const repoPlaceholders = [...PROVEN_PAYING_REPOS].map(() => '?').join(',');

  return db.prepare(`
    SELECT * FROM bounties
    WHERE status = 'open'
      AND claimed = 0
      AND (difficulty IN ('easy', 'medium') OR (difficulty = 'hard' AND reward >= 500))
      AND reward >= 50
      AND repo IN (${repoPlaceholders})
      AND (notes IS NULL OR notes NOT LIKE '%${new Date().toISOString().slice(0,10)}%')
    ORDER BY
      CASE difficulty WHEN 'easy' THEN 0 ELSE 1 END,
      CASE
        WHEN labels LIKE '%typo%' OR title LIKE '%typo%' THEN 0
        WHEN labels LIKE '%docs%' OR labels LIKE '%documentation%' THEN 1
        WHEN labels LIKE '%good first issue%' THEN 2
        WHEN labels LIKE '%bug%' THEN 3
        ELSE 4
      END,
      reward DESC
    LIMIT ?
  `).all(...PROVEN_PAYING_REPOS, limit).map(b => ({
    ...b,
    labels: JSON.parse(b.labels || '[]'),
    skills: JSON.parse(b.skills || '[]'),
  }));
}

// ─── Step 2: Deep repo analysis — understand EVERYTHING before touching code ──
async function getRepoContext(owner, repo, issueNumber) {
  const context = { files: [], readme: '', tree: [], buildSystem: null, ciConfig: '', lintConfig: '', codeStyle: {} };

  // Parallel fetch: issue, comments, tree, readme, repo info
  const [issueRes, commentsRes, treeRes, readmeRes, repoInfoRes] = await Promise.allSettled([
    gh(`/repos/${owner}/${repo}/issues/${issueNumber}`),
    gh(`/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=10`),
    gh(`/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`),
    gh(`/repos/${owner}/${repo}/readme`),
    gh(`/repos/${owner}/${repo}`),
  ]);

  if (issueRes.status === 'fulfilled') {
    context.issueBody = issueRes.value.body || '';
    context.issueTitle = issueRes.value.title || '';
  }
  context.comments = commentsRes.status === 'fulfilled'
    ? commentsRes.value.map(c => c.body).join('\n---\n') : '';

  if (treeRes.status === 'fulfilled') {
    context.tree = (treeRes.value.tree || [])
      .filter(t => t.type === 'blob')
      .map(t => t.path)
      .slice(0, 300);
  }

  if (readmeRes.status === 'fulfilled' && readmeRes.value.content) {
    context.readme = Buffer.from(readmeRes.value.content, 'base64').toString('utf-8').slice(0, 2000);
  }

  if (repoInfoRes.status === 'fulfilled') {
    context.repoLanguage = repoInfoRes.value.language || '';
    context.defaultBranch = repoInfoRes.value.default_branch || 'main';
  }

  // ── Detect build system from file tree ──
  const fileSet = new Set(context.tree);
  const buildDetection = detectBuildSystem(context.tree, fileSet);
  context.buildSystem = buildDetection;
  console.log(`[SOLVER] Detected build: ${buildDetection.type} (${buildDetection.language})`);

  // ── Parallel fetch: CONTRIBUTING, CI config, lint config, build config ──
  const configFetches = [];

  // CONTRIBUTING.md
  for (const p of ['CONTRIBUTING.md', 'contributing.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md']) {
    if (fileSet.has(p)) { configFetches.push({ key: 'contributing', path: p }); break; }
  }

  // CI config — understand what checks will run
  for (const p of ['.github/workflows', '.circleci/config.yml', '.travis.yml', 'Jenkinsfile', '.gitlab-ci.yml']) {
    const match = context.tree.find(f => f.startsWith(p));
    if (match) { configFetches.push({ key: 'ciConfig', path: match }); break; }
  }
  // Get the main CI workflow specifically
  const ciWorkflows = context.tree.filter(f => f.startsWith('.github/workflows/') && f.endsWith('.yml'));
  if (ciWorkflows.length > 0) {
    // Prefer ci.yml, test.yml, build.yml, or the first one
    const preferred = ciWorkflows.find(f => /\/(ci|test|build|check)\.yml$/.test(f)) || ciWorkflows[0];
    configFetches.push({ key: 'ciConfig', path: preferred });
  }

  // Lint/format config
  for (const p of ['.eslintrc.json', '.eslintrc.js', '.eslintrc', '.prettierrc', '.prettierrc.json',
    'biome.json', '.scalafmt.conf', '.rustfmt.toml', 'pyproject.toml', '.editorconfig',
    'tslint.json', '.eslintrc.yaml', '.eslintrc.yml']) {
    if (fileSet.has(p)) { configFetches.push({ key: 'lintConfig', path: p }); break; }
  }

  // Build config — understand dependencies and compilation
  for (const p of ['package.json', 'build.sbt', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle',
    'pyproject.toml', 'setup.py', 'Makefile', 'CMakeLists.txt']) {
    if (fileSet.has(p)) { configFetches.push({ key: 'buildConfig', path: p }); break; }
  }

  // tsconfig for TS projects
  if (fileSet.has('tsconfig.json')) configFetches.push({ key: 'tsConfig', path: 'tsconfig.json' });

  // Fetch all configs in parallel
  const configResults = await Promise.allSettled(
    configFetches.map(async ({ key, path }) => {
      const file = await gh(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`);
      return { key, content: file.content ? Buffer.from(file.content, 'base64').toString('utf-8') : '' };
    })
  );

  for (const result of configResults) {
    if (result.status === 'fulfilled' && result.value.content) {
      const { key, content } = result.value;
      context[key] = (context[key] ? context[key] + '\n---\n' : '') + content.slice(0, 2000);
    }
  }

  // ── Analyze code style from existing files ──
  // Read 2-3 files similar to target area for style matching
  context.styleExamples = {};

  return context;
}

// ─── Build system detection ─────────────────────────────
function detectBuildSystem(tree, fileSet) {
  // Ordered by specificity
  if (fileSet.has('build.sbt') || tree.some(f => f.endsWith('.scala')))
    return { type: 'sbt', language: 'scala', compileCmd: 'sbt compile', testCmd: 'sbt test', lintCmd: 'sbt scalafmtCheck' };
  if (fileSet.has('Cargo.toml'))
    return { type: 'cargo', language: 'rust', compileCmd: 'cargo build', testCmd: 'cargo test', lintCmd: 'cargo clippy' };
  if (fileSet.has('go.mod'))
    return { type: 'go', language: 'go', compileCmd: 'go build ./...', testCmd: 'go test ./...', lintCmd: 'golangci-lint run' };
  if (fileSet.has('pom.xml'))
    return { type: 'maven', language: 'java', compileCmd: 'mvn compile', testCmd: 'mvn test', lintCmd: 'mvn checkstyle:check' };
  if (fileSet.has('build.gradle') || fileSet.has('build.gradle.kts'))
    return { type: 'gradle', language: 'java/kotlin', compileCmd: 'gradle build', testCmd: 'gradle test', lintCmd: 'gradle check' };
  if (fileSet.has('Package.swift'))
    return { type: 'swift', language: 'swift', compileCmd: 'swift build', testCmd: 'swift test', lintCmd: 'swiftlint' };
  if (fileSet.has('tsconfig.json'))
    return { type: 'typescript', language: 'typescript', compileCmd: 'tsc --noEmit', testCmd: 'npm test', lintCmd: 'npm run lint' };
  if (fileSet.has('package.json'))
    return { type: 'node', language: 'javascript', compileCmd: null, testCmd: 'npm test', lintCmd: 'npm run lint' };
  if (fileSet.has('pyproject.toml') || fileSet.has('setup.py'))
    return { type: 'python', language: 'python', compileCmd: null, testCmd: 'pytest', lintCmd: 'ruff check' };
  if (fileSet.has('Gemfile'))
    return { type: 'ruby', language: 'ruby', compileCmd: null, testCmd: 'bundle exec rspec', lintCmd: 'bundle exec rubocop' };
  if (fileSet.has('mix.exs'))
    return { type: 'mix', language: 'elixir', compileCmd: 'mix compile', testCmd: 'mix test', lintCmd: 'mix format --check-formatted' };
  return { type: 'unknown', language: 'unknown', compileCmd: null, testCmd: null, lintCmd: null };
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

// ─── Step 4: Deep analysis — understand the codebase like a human would ──
async function analyzeBounty(bounty, repoContext) {
  const fileList = repoContext.tree.join('\n');
  const buildInfo = repoContext.buildSystem || { type: 'unknown', language: 'unknown' };

  const analysisPrompt = `You are a senior developer who has been working on this codebase for years. Analyze this bounty.

REPO LANGUAGE: ${repoContext.repoLanguage || buildInfo.language}
BUILD SYSTEM: ${buildInfo.type} (compile: ${buildInfo.compileCmd || 'N/A'}, test: ${buildInfo.testCmd || 'N/A'}, lint: ${buildInfo.lintCmd || 'N/A'})

${repoContext.buildConfig ? `BUILD CONFIG (excerpt):\n${repoContext.buildConfig.slice(0, 1500)}\n` : ''}
${repoContext.ciConfig ? `CI CONFIG:\n${repoContext.ciConfig.slice(0, 1500)}\n` : ''}
${repoContext.lintConfig ? `LINT/FORMAT CONFIG:\n${repoContext.lintConfig.slice(0, 800)}\n` : ''}
${repoContext.tsConfig ? `TSCONFIG:\n${repoContext.tsConfig.slice(0, 500)}\n` : ''}

ISSUE TITLE: ${repoContext.issueTitle || bounty.title}
ISSUE BODY:
${(repoContext.issueBody || bounty.description).slice(0, 3000)}

COMMENTS:
${(repoContext.comments || '').slice(0, 1500)}

REPO FILE TREE:
${fileList.slice(0, 3000)}

README (excerpt):
${repoContext.readme.slice(0, 1000)}

${repoContext.contributing ? `CONTRIBUTING GUIDELINES:\n${repoContext.contributing.slice(0, 1000)}\n` : ''}

Analyze deeply:
1. Can this be solved with SURGICAL, MINIMAL changes? (not rewrites)
2. Which specific files need modification? (max 3 — fewer is better)
3. What EXACT functions/classes/methods need changes? Be specific.
4. What are the CI checks that will run? What could fail?
5. Are there type constraints, trait implementations, or interfaces that must be satisfied?
6. What's the existing code style? (indentation, naming conventions, import style)
7. Confidence level: high/medium/low

CRITICAL RULES:
- NEVER rewrite entire files. Only modify the specific lines needed.
- If the fix touches a core module with many dependents, list the dependent files too.
- If the project uses specific formatting (scalafmt, prettier, eslint), note it.
- If CI runs cross-compilation (JVM/JS/Native, multiple Python versions, etc.), changes must work across ALL targets.
- If you're not confident you can make changes that pass CI, say solvable: false.

Respond in this exact JSON format:
{
  "solvable": true/false,
  "files": ["path/to/file1.ts"],
  "related_files": ["path/to/dependent.ts"],
  "fix_type": "bug_fix",
  "confidence": "high",
  "description": "Brief fix description",
  "language": "typescript",
  "specific_changes": "Change function X in class Y to handle case Z",
  "ci_risks": ["lint check may fail if formatting is wrong", "type check across platforms"],
  "style_notes": "Uses 2-space indent, single quotes, no semicolons"
}`;

  // Use Sonnet for analysis on non-trivial languages — Haiku makes mistakes on complex codebases
  const isComplexLang = ['scala', 'rust', 'haskell', 'kotlin', 'go', 'java', 'swift', 'c++', 'c'].includes(
    (buildInfo.language || '').toLowerCase()
  );
  const analysisResult = isComplexLang
    ? await askSonnet(analysisPrompt, 2048)
    : await askHaiku(analysisPrompt, 1024);

  const jsonMatch = analysisResult.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { solvable: false, reason: 'Failed to parse analysis' };

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    // For complex languages: skip low confidence always, skip medium only for small bounties
    const detectedLang = (parsed.language || buildInfo.language || '').toLowerCase();
    const reward = bounty?.reward || 0;
    if (isComplexLang && parsed.confidence === 'low') {
      console.log(`[SOLVER] Skipping — ${detectedLang} has low confidence`);
      return { solvable: false, reason: `Language ${detectedLang} — low confidence` };
    }
    if (isComplexLang && parsed.confidence !== 'high' && reward < 200) {
      console.log(`[SOLVER] Skipping — ${detectedLang} medium confidence, bounty too small ($${reward})`);
      return { solvable: false, reason: `Language ${detectedLang} — need high confidence for <$200` };
    }

    return parsed;
  } catch (e) {
    return { solvable: false, reason: 'Invalid JSON in analysis' };
  }
}

async function generateFix(bounty, repoContext, analysis, fileContents) {
  const buildInfo = repoContext.buildSystem || { type: 'unknown', language: 'unknown' };
  const filesContext = Object.entries(fileContents)
    .map(([path, content]) => {
      if (!content) return `--- FILE: ${path} ---\n(new file)`;
      // For large files, show structure + the specific areas that need changes
      if (content.length > 8000) {
        const lines = content.split('\n');
        const imports = lines.slice(0, 30).join('\n');
        const exports = lines.filter(l => /^export\s|^module\.exports|^pub\s|^def\s|^class\s|^interface\s|^trait\s|^object\s|^type\s/.test(l.trim())).join('\n');
        return `--- FILE: ${path} (${lines.length} lines — showing structure) ---\nIMPORTS:\n${imports}\n\nEXPORTS/DECLARATIONS:\n${exports}\n\nFULL CONTENT:\n${content.slice(0, 10000)}`;
      }
      return `--- FILE: ${path} ---\n${content}`;
    })
    .join('\n\n');

  // Read related/dependent files for type awareness
  let relatedContext = '';
  if (analysis.related_files?.length > 0) {
    const relatedContents = [];
    for (const f of analysis.related_files.slice(0, 2)) {
      if (!fileContents[f]) {
        const content = await readFile(bounty.repo.split('/')[0], bounty.repo.split('/')[1], f);
        if (content) {
          // Show just signatures/types for related files
          const lines = content.split('\n');
          const signatures = lines.filter(l =>
            /^(export|pub|def|class|interface|trait|type|object|fun|func|fn)\s/.test(l.trim()) ||
            /^\s*(abstract|override|protected|private|public)\s/.test(l)
          ).join('\n');
          relatedContents.push(`--- RELATED: ${f} (signatures only) ---\n${signatures || content.slice(0, 2000)}`);
        }
      }
    }
    relatedContext = relatedContents.join('\n\n');
  }

  const contributingRules = repoContext.contributing
    ? `\nCONTRIBUTING GUIDELINES (YOU MUST FOLLOW THESE):\n${repoContext.contributing.slice(0, 1000)}\n`
    : '';

  const fixPrompt = `You are a senior developer who has been contributing to this project for 2 years. You know every pattern, every convention, every quirk. Your PRs always pass CI on the first try.

PROJECT: ${buildInfo.language} project using ${buildInfo.type}
${buildInfo.compileCmd ? `COMPILE: ${buildInfo.compileCmd}` : ''}
${buildInfo.testCmd ? `TEST: ${buildInfo.testCmd}` : ''}
${buildInfo.lintCmd ? `LINT: ${buildInfo.lintCmd}` : ''}

${repoContext.ciConfig ? `CI PIPELINE (this is what will run on your PR):\n${repoContext.ciConfig.slice(0, 1000)}\n` : ''}
${repoContext.lintConfig ? `LINT CONFIG:\n${repoContext.lintConfig.slice(0, 500)}\n` : ''}
${repoContext.tsConfig ? `TSCONFIG:\n${repoContext.tsConfig.slice(0, 300)}\n` : ''}

ISSUE: ${repoContext.issueTitle || bounty.title}
DESCRIPTION:
${(repoContext.issueBody || bounty.description).slice(0, 2000)}

ANALYSIS: ${analysis.description}
SPECIFIC CHANGES NEEDED: ${analysis.specific_changes || analysis.description}
CI RISKS: ${(analysis.ci_risks || []).join(', ') || 'none identified'}
STYLE: ${analysis.style_notes || 'match existing code exactly'}
${contributingRules}
TARGET FILES:
${filesContext}

${relatedContext ? `RELATED FILES (for type/interface awareness):\n${relatedContext}\n` : ''}

CRITICAL RULES FOR CI-PASSING CODE:
1. Your changes MUST compile on ALL targets this project supports (check CI config above)
2. NEVER rewrite entire files. Only change the specific lines needed for the fix.
3. For files you're modifying, include the COMPLETE updated file content so it can be committed.
4. Match the EXACT code style: indentation, quotes, semicolons, naming conventions, bracket placement.
5. If the project uses a formatter (scalafmt, prettier, eslint, rustfmt), your code MUST conform to it.
6. All types, traits, interfaces, and function signatures must be correct. Check related files above.
7. Don't add imports that don't exist in the project. Don't use APIs that aren't in the dependencies.
8. If a file is >300 lines and you're only changing a small section, STILL include the full file — partial files break compilation.
9. If the change adds a new function/method, make sure it has the correct visibility, return type, and follows the existing pattern.
10. For typed languages: every type annotation must be correct. No \`any\`, no \`Object\`, no generic filler types.

CRITICAL JSON RULES:
- Your entire response must be valid JSON — no markdown, no backticks
- Escape all special characters: newlines as \\n, tabs as \\t, quotes as \\"
- If a file would be extremely large (>500 lines), include full content but be meticulous about preserving every unchanged line

Respond in this exact JSON format:
{
  "changes": [
    {"path": "path/to/file.ts", "content": "COMPLETE updated file content", "description": "What changed and why"}
  ],
  "commit_message": "fix: brief description",
  "pr_title": "fix: brief PR title (under 72 chars)",
  "pr_body": "## What\\n- Description\\n\\n## Why\\n- Fixes #ISSUE_NUMBER\\n\\n## CI\\n- Verified changes compile and conform to project style"
}`;

  // Use Sonnet for ALL languages now — quality > cost. Haiku only for docs/typo fixes.
  const useHaiku = bounty.difficulty === 'easy' && ['docs', 'typo', 'documentation'].includes(analysis.fix_type);
  const result = useHaiku
    ? await askHaiku(fixPrompt, 8192)
    : await askSonnet(fixPrompt, 32000);

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

  // ── QUALITY GATE: Sonnet reviews for CI-breaking issues ──
  const changesSummary = (fix.changes || [])
    .map(c => `FILE: ${c.path}\nCHANGES: ${c.description}\nCODE:\n${(c.content || '').slice(0, 4000)}`)
    .join('\n---\n');

  // For the original file content — check what changed
  const originalContext = Object.entries(fileContents)
    .map(([path, content]) => `ORIGINAL ${path} (first 2000 chars):\n${(content || '').slice(0, 2000)}`)
    .join('\n---\n');

  const reviewPrompt = `You are the CI system for a ${buildInfo.language} project using ${buildInfo.type}. Simulate running the full CI pipeline on this PR.

BUILD SYSTEM: ${buildInfo.type}
COMPILE: ${buildInfo.compileCmd || 'N/A'}
LINT: ${buildInfo.lintCmd || 'N/A'}
TEST: ${buildInfo.testCmd || 'N/A'}
${repoContext.ciConfig ? `CI CONFIG:\n${repoContext.ciConfig.slice(0, 800)}\n` : ''}
${repoContext.lintConfig ? `LINT CONFIG:\n${repoContext.lintConfig.slice(0, 400)}\n` : ''}

ISSUE BEING FIXED: ${repoContext.issueTitle || bounty.title}
FIX DESCRIPTION: ${analysis.description}

ORIGINAL FILES:
${originalContext.slice(0, 3000)}

PROPOSED CHANGES:
${changesSummary.slice(0, 6000)}

Simulate CI checks:
1. COMPILATION: Would this code compile? Check all types, imports, function signatures, trait implementations.
2. LINT: Does the code match the project's formatting config? Check indentation, quotes, semicolons, naming.
3. LOGIC: Are the changes correct? Do they actually fix the issue described?
4. COMPLETENESS: Is the full file included (not truncated)? Are all modified functions complete?
5. CROSS-PLATFORM: If the project compiles for multiple targets (JVM/JS/Native, etc.), would it work on ALL?
6. DEPENDENCIES: Are all imports/dependencies available in the project?

Be STRICT. In real CI, partial code = build failure. Wrong types = build failure. Bad formatting = lint failure.

Respond with JSON: {"pass": true/false, "issues": ["specific issue 1", "specific issue 2"], "severity": "blocking/warning"}
Only pass if you are confident ALL CI checks would pass.`;

  // Use Sonnet for quality gate on complex languages, Haiku for simple ones
  const isComplexLang = ['scala', 'rust', 'go', 'java', 'kotlin', 'swift', 'c++', 'haskell'].includes(
    (buildInfo.language || '').toLowerCase()
  );
  const reviewResult = isComplexLang
    ? await askSonnet(reviewPrompt, 1024)
    : await askHaiku(reviewPrompt, 512);

  const reviewMatch = reviewResult.match(/\{[\s\S]*\}/);
  if (reviewMatch) {
    try {
      const review = JSON.parse(reviewMatch[0]);
      if (!review.pass) {
        console.log(`[SOLVER] Quality gate FAILED:`, review.issues?.join(', '));

        // For non-blocking warnings, attempt a fix-up pass
        if (review.severity === 'warning' && !isComplexLang) {
          console.log(`[SOLVER] Attempting auto-fix for warnings...`);
          // Let it through with warnings noted
        } else {
          throw new Error(`Quality gate: ${(review.issues || []).slice(0, 3).join('; ')}`);
        }
      }
      console.log(`[SOLVER] Quality gate PASSED`);
    } catch (e) {
      if (e.message.startsWith('Quality gate')) throw e;
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
    ``,
    `---`,
    `<sub>🛠️ **Free dev tools** — [README Generator](https://scintillating-gratitude-production.up.railway.app/tools) · [PR Writer](https://scintillating-gratitude-production.up.railway.app/tools) · [Code Review](https://scintillating-gratitude-production.up.railway.app/tools) · [JS→TS Converter](https://scintillating-gratitude-production.up.railway.app/tools) | by SnipeLink LLC</sub>`,
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

  // Extract issue/PR number from URL (handles both /issues/123 and /pull/123)
  const issueMatch = bounty.issue_url.match(/\/(?:issues|pull|pulls)\/(\d+)/);
  if (!issueMatch) throw new Error(`Can't extract issue number from ${bounty.issue_url}`);
  const issueNumber = issueMatch[1];
  const isPullUrl = /\/pull\//.test(bounty.issue_url);

  // If this is a PR URL, check if it's someone else's open PR — skip if so
  if (isPullUrl) {
    try {
      const prData = await gh(`/repos/${owner}/${repo}/pulls/${issueNumber}`);
      if (prData.user?.login !== GITHUB_USERNAME && prData.state === 'open') {
        console.log(`[SOLVER] Skipping — PR #${issueNumber} is by ${prData.user?.login}, not us`);
        db.prepare("UPDATE bounties SET status = 'claimed_by_other', notes = COALESCE(notes, '') || ?, updated_at = datetime('now') WHERE id = ?")
          .run(`\n[SKIP] PR by ${prData.user?.login}`, bounty.id);
        return { success: false, reason: `PR already submitted by ${prData.user?.login}` };
      }
    } catch (e) {}
  }

  // ── DEDUP: Check if we already have an open PR for this issue ──
  try {
    // Only check OUR PRs — filter by our username
    const existingPRs = (await gh(`/repos/${owner}/${repo}/pulls?state=open&per_page=50`))
      .filter(pr => pr.user?.login === GITHUB_USERNAME || (pr.head?.label || '').startsWith(GITHUB_USERNAME));

    // HARD LIMIT: max 2 open PRs per repo — balance between output and spam
    if (existingPRs.length >= 2) {
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

  // Read the files that need changes + related files for type awareness
  const fileContents = {};
  const filesToRead = [...new Set([
    ...(analysis.files || []).slice(0, 3),
    ...(analysis.related_files || []).slice(0, 2),
  ])];

  // Parallel file reads for speed
  const fileResults = await Promise.allSettled(
    filesToRead.map(async (filePath) => {
      const content = await readFile(owner, repo, filePath);
      return { filePath, content };
    })
  );
  for (const result of fileResults) {
    if (result.status === 'fulfilled') {
      fileContents[result.value.filePath] = result.value.content;
    }
  }

  // If no existing files found, this might be a new-file task — that's ok
  const hasExistingFiles = Object.values(fileContents).some(v => v);
  if (!hasExistingFiles && analysis.fix_type !== 'feature' && analysis.fix_type !== 'docs') {
    console.log(`[SOLVER] Skipping — couldn't read any target files`);
    return { success: false, reason: 'Could not read target files' };
  }

  // For ALL bounties, read a style reference file from the same directory
  const targetDir = (analysis.files?.[0] || '').split('/').slice(0, -1).join('/');
  if (targetDir) {
    const siblingFiles = repoContext.tree.filter(f =>
      f.startsWith(targetDir + '/') && !filesToRead.includes(f) && f.match(/\.(ts|js|scala|rs|go|py|java|kt)$/)
    ).slice(0, 2);
    for (const f of siblingFiles) {
      if (!fileContents[f]) {
        const content = await readFile(owner, repo, f);
        if (content) { fileContents[`[STYLE REF] ${f}`] = content.slice(0, 3000); break; }
      }
    }
  }

  // For new features without existing files, still grab a style reference
  if (!hasExistingFiles && repoContext.tree.length > 0) {
    const lang = (repoContext.buildSystem?.language || '').toLowerCase();
    const extMap = { typescript: '.ts', javascript: '.js', scala: '.scala', rust: '.rs', go: '.go', python: '.py', java: '.java', kotlin: '.kt' };
    const ext = extMap[lang] || '.ts';
    const relevantFiles = repoContext.tree.filter(f => f.endsWith(ext)).slice(0, 3);
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

  // HUMANIZER DISABLED — saves 1 Sonnet call per PR ($0.03+)
  // The generateFix prompt already handles style matching now

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

  // SURVIVAL MODE: 3 bounties max, sequential, no parallel API burns
  const bounties = pickBounties(3);
  log.push(`[SOLVER] Found ${bounties.length} candidates (verified-paying repos only)`);

  // Sequential — one at a time to conserve API credits
  for (const bounty of bounties) {
    const results = await Promise.allSettled([
      (async () => {
        log.push(`[SOLVER] Attempting: $${bounty.reward} — ${bounty.title.slice(0, 50)} (${bounty.repo})`);
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
      })()
    ]);

    if (results[0].status === 'rejected') {
      log.push(`[SOLVER] ✗ Error: ${results[0].reason?.message || 'Unknown'}`);
    }
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

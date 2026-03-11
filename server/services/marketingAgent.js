import db from '../db/connection.js';
import { notify } from './notifications.js';
import { randomUUID } from 'crypto';

// ─── Constants ────────────────────────────────────────────
const GITHUB_USERNAME = 'klawgulp-ship-it';
const TOOLS_URL = 'https://scintillating-gratitude-production.up.railway.app/tools';
const PORTFOLIO_URL = 'https://klawgulp-ship-it.github.io';
const API_BASE = 'https://scintillating-gratitude-production.up.railway.app';
const MAX_ACTIONS_PER_CYCLE = 10;
const MAX_ISSUE_COMMENTS_PER_DAY = 8;
const MAX_DISCUSSION_ANSWERS_PER_CYCLE = 4;

// ─── DB Setup ─────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS marketing_actions (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    action_type TEXT NOT NULL,
    target_url TEXT DEFAULT '',
    content_preview TEXT DEFAULT '',
    status TEXT DEFAULT 'posted',
    clicks INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── GitHub Helper ────────────────────────────────────────
function gh(path, options = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set');
  return fetch(`https://api.github.com${path}`, {
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

// ─── Claude Helper (Haiku — cheap) ───────────────────────
async function askClaude(prompt, maxTokens = 512) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Claude API ${res.status}`);
  return data.content?.[0]?.text ?? '';
}

// ─── Tracking Helpers ─────────────────────────────────────
const logAction = db.prepare(`
  INSERT INTO marketing_actions (id, channel, action_type, target_url, content_preview, status)
  VALUES (?, ?, ?, ?, ?, ?)
`);

function trackAction(channel, actionType, targetUrl, preview, status = 'posted') {
  const id = randomUUID();
  logAction.run(id, channel, actionType, targetUrl, preview.slice(0, 500), status);
  return id;
}

function todayIssueCommentCount() {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM marketing_actions
    WHERE channel = 'github_issues' AND action_type = 'comment'
      AND created_at >= date('now')
  `).get();
  return row?.cnt ?? 0;
}

function alreadyCommentedOn(url) {
  const row = db.prepare(`
    SELECT 1 FROM marketing_actions WHERE target_url = ? AND action_type = 'comment' LIMIT 1
  `).get(url);
  return !!row;
}

// ─── 1. GitHub Profile README ─────────────────────────────
async function updateProfileReadme() {
  try {
    // Fetch recent contributions for stats
    const events = await gh(`/users/${GITHUB_USERNAME}/events/public?per_page=30`);
    const prCount = events.filter(e => e.type === 'PullRequestEvent').length;
    const pushCount = events.filter(e => e.type === 'PushEvent').length;
    const issueCount = events.filter(e => e.type === 'IssuesEvent' || e.type === 'IssueCommentEvent').length;

    const readme = `# Hey, I'm the dev behind SnipeLink LLC

Building free developer tools and shipping code daily.

## Free Developer Tools

| Tool | Description |
|------|-------------|
| [README Generator](${TOOLS_URL}) | AI-powered README generator — paste your repo, get a professional README |
| [JS to TS Converter](${TOOLS_URL}) | Convert JavaScript to TypeScript instantly |
| [Code Reviewer](${TOOLS_URL}) | AI code review with actionable suggestions |
| [Landing Page Generator](${TOOLS_URL}) | Generate clean landing pages from a description |

**[Browse All Tools](${TOOLS_URL})** — 100% free, no sign-up required.

## Recent Activity
- ${prCount} pull requests
- ${pushCount} pushes
- ${issueCount} issue interactions

_Last 30 days of public activity._

## Links
- [Portfolio](${PORTFOLIO_URL})
- [Dev Tools](${TOOLS_URL})

---
*SnipeLink LLC — Developer tools that save you time.*
`;

    // Get current file SHA for update
    const current = await gh(`/repos/${GITHUB_USERNAME}/${GITHUB_USERNAME}/contents/README.md`);
    const sha = current.sha;

    await gh(`/repos/${GITHUB_USERNAME}/${GITHUB_USERNAME}/contents/README.md`, {
      method: 'PUT',
      body: JSON.stringify({
        message: 'Update profile README with latest stats',
        content: Buffer.from(readme).toString('base64'),
        sha,
      }),
    });

    trackAction('github_profile', 'readme_update', `https://github.com/${GITHUB_USERNAME}`, 'Updated profile README with tools + stats');
    return { success: true, action: 'readme_update' };
  } catch (err) {
    console.error('[marketing] Profile README update failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ─── 2. GitHub Issue Helpers ──────────────────────────────
const ISSUE_SEARCH_QUERIES = [
  '"how to write README" OR "generate README" OR "need README template"',
  '"convert javascript to typescript" OR "js to ts"',
  '"code review" OR "review my code" OR "need code review"',
  '"landing page template" OR "landing page generator"',
  // Solana ecosystem
  '"anchor idl" OR "anchor types" OR "anchor typescript"',
  '"solana address" OR "validate wallet" OR "base58 solana"',
  '"spl token" OR "token supply" OR "tokenomics calculator"',
  '"solana transaction" OR "decode transaction" OR "transaction parser" language:rust',
  '"solana keypair" OR "generate keypair" OR "ed25519 solana"',
];

async function helpOnIssues() {
  const remaining = MAX_ISSUE_COMMENTS_PER_DAY - todayIssueCommentCount();
  if (remaining <= 0) {
    console.log('[marketing] Daily issue comment limit reached');
    return [];
  }

  const results = [];
  let commented = 0;

  for (const query of ISSUE_SEARCH_QUERIES) {
    if (commented >= remaining || commented >= 3) break;

    try {
      const searchResult = await gh(`/search/issues?q=${encodeURIComponent(query + ' type:issue state:open')}&sort=created&order=desc&per_page=5`);
      const issues = searchResult.items ?? [];

      for (const issue of issues) {
        if (commented >= remaining || commented >= 3) break;
        if (alreadyCommentedOn(issue.html_url)) continue;

        // Check if issue already has many comments (well-answered)
        if (issue.comments > 5) continue;

        // Check we haven't already commented via GitHub API
        const comments = await gh(`/repos/${issue.repository_url.split('/repos/')[1]}/issues/${issue.number}/comments?per_page=50`);
        const alreadyThere = comments.some(c => c.user?.login === GITHUB_USERNAME);
        if (alreadyThere) {
          trackAction('github_issues', 'skip_duplicate', issue.html_url, 'Already commented');
          continue;
        }

        // Generate a genuinely helpful comment with Claude
        const toolContext = detectToolContext(query);
        const prompt = `You are a helpful developer. Someone posted a GitHub issue titled "${issue.title}".

Issue body (truncated): ${(issue.body ?? '').slice(0, 800)}

Write a genuinely helpful response that answers their question. Be specific and provide real advice/code snippets.

At the end, naturally mention this free tool as an additional resource (not the focus):
- Tool: ${toolContext.name}
- URL: ${toolContext.url}
- What it does: ${toolContext.desc}

Requirements:
- Be helpful FIRST. The tool mention should be a brief aside at the end, like "You might also find [tool](url) useful for this."
- Don't be salesy. Don't use exclamation marks excessively.
- Keep it under 200 words.
- Vary your style — don't start with "Great question" every time.
- Write in plain markdown.`;

        const comment = await askClaude(prompt, 400);
        if (!comment || comment.length < 50) continue;

        // Post the comment
        const repoPath = issue.repository_url.split('/repos/')[1];
        await gh(`/repos/${repoPath}/issues/${issue.number}/comments`, {
          method: 'POST',
          body: JSON.stringify({ body: comment }),
        });

        trackAction('github_issues', 'comment', issue.html_url, comment.slice(0, 500));
        results.push({ issue: issue.html_url, comment: comment.slice(0, 200) });
        commented++;

        // Rate limit courtesy — 2s between comments
        await sleep(2000);
      }

      // Rate limit between search queries
      await sleep(1000);
    } catch (err) {
      console.error(`[marketing] Issue search failed for query:`, err.message);
    }
  }

  return results;
}

function detectToolContext(query) {
  if (query.includes('README')) {
    return { name: 'README Generator', url: TOOLS_URL, desc: 'AI-powered README generator that analyzes repos' };
  }
  if (query.includes('typescript') || query.includes('js to ts')) {
    return { name: 'JS-to-TS Converter', url: TOOLS_URL, desc: 'Converts JavaScript to TypeScript with proper types' };
  }
  if (query.includes('code review')) {
    return { name: 'AI Code Reviewer', url: TOOLS_URL, desc: 'AI-powered code review with actionable suggestions' };
  }
  if (query.includes('landing page')) {
    return { name: 'Landing Page Generator', url: TOOLS_URL, desc: 'Generate clean landing pages from a description' };
  }
  if (query.includes('anchor') || query.includes('idl')) {
    return { name: 'Anchor IDL Parser', url: `${TOOLS_URL}/anchor-idl-parser`, desc: 'Parse Anchor IDL and generate TypeScript types instantly' };
  }
  if (query.includes('solana address') || query.includes('validate wallet') || query.includes('base58')) {
    return { name: 'Solana Address Validator', url: `${TOOLS_URL}/solana-address-validator`, desc: 'Validate Solana wallet addresses and detect known programs' };
  }
  if (query.includes('spl token') || query.includes('tokenomics') || query.includes('token supply')) {
    return { name: 'SPL Token Calculator', url: `${TOOLS_URL}/spl-token-calculator`, desc: 'Plan SPL token economics — supply distribution and vesting' };
  }
  if (query.includes('solana transaction') || query.includes('decode transaction')) {
    return { name: 'Solana Transaction Decoder', url: `${TOOLS_URL}/solana-tx-decoder`, desc: 'Decode base64 Solana transactions and extract instruction data' };
  }
  if (query.includes('keypair') || query.includes('ed25519')) {
    return { name: 'Solana Keypair Generator', url: `${TOOLS_URL}/keypair-generator`, desc: 'Generate Solana keypairs for development and testing' };
  }
  return { name: 'Dev Tools', url: TOOLS_URL, desc: 'Free AI-powered developer utilities — 22+ tools including Solana dev tools' };
}

// ─── 3. GitHub Discussions ────────────────────────────────
const DISCUSSION_QUERIES = [
  'README generator help',
  'convert JavaScript TypeScript',
  'code review tool',
  'landing page builder',
  'solana developer tools',
  'anchor idl typescript',
  'spl token tools',
];

async function answerDiscussions() {
  const results = [];
  let answered = 0;

  for (const query of DISCUSSION_QUERIES) {
    if (answered >= MAX_DISCUSSION_ANSWERS_PER_CYCLE) break;

    try {
      // GitHub Discussions are searched via the general search API with type:discussions
      const searchResult = await gh(`/search/issues?q=${encodeURIComponent(query + ' type:discussions state:open')}&sort=created&order=desc&per_page=3`);
      const discussions = searchResult.items ?? [];

      for (const disc of discussions) {
        if (answered >= MAX_DISCUSSION_ANSWERS_PER_CYCLE) break;
        if (alreadyCommentedOn(disc.html_url)) continue;
        if (disc.comments > 5) continue;

        const toolContext = detectToolContext(query);
        const prompt = `You are a helpful developer answering a GitHub Discussion titled "${disc.title}".

Discussion body (truncated): ${(disc.body ?? '').slice(0, 800)}

Write a helpful answer. At the end, briefly mention this free tool as an extra resource:
- Tool: ${toolContext.name} — ${toolContext.url}

Keep it under 150 words. Be genuinely helpful. Don't be pushy about the tool.`;

        const answer = await askClaude(prompt, 300);
        if (!answer || answer.length < 40) continue;

        const repoPath = disc.repository_url?.split('/repos/')[1];
        if (!repoPath) continue;

        await gh(`/repos/${repoPath}/issues/${disc.number}/comments`, {
          method: 'POST',
          body: JSON.stringify({ body: answer }),
        });

        trackAction('github_discussions', 'answer', disc.html_url, answer.slice(0, 500));
        results.push({ discussion: disc.html_url, answer: answer.slice(0, 200) });
        answered++;

        await sleep(2000);
      }

      await sleep(1000);
    } catch (err) {
      console.error(`[marketing] Discussion search failed:`, err.message);
    }
  }

  return results;
}

// ─── 4. PR Description Footer ─────────────────────────────
export function getToolsFooter() {
  return `\n---\n*Built with [Dev Tools](${TOOLS_URL}) by SnipeLink LLC*`;
}

export function enhancePRDescriptions(prBody = '') {
  const footer = getToolsFooter();
  if (prBody.includes('Dev Tools') && prBody.includes(TOOLS_URL)) return prBody;
  return prBody + footer;
}

// ─── 5. Dev.to Auto-Publisher ─────────────────────────────
// Publishes real articles to Dev.to automatically (free API)
async function publishToDevTo() {
  const devtoKey = process.env.DEVTO_API_KEY;
  if (!devtoKey) return { published: 0, reason: 'no_api_key' };

  // Max 1 article per day
  const lastPost = db.prepare(
    "SELECT created_at FROM marketing_actions WHERE channel = 'devto' AND action_type = 'publish' ORDER BY created_at DESC LIMIT 1"
  ).get();
  if (lastPost) {
    const hoursSince = (Date.now() - new Date(lastPost.created_at).getTime()) / (1000 * 60 * 60);
    if (hoursSince < 24) return { published: 0, reason: 'daily_limit' };
  }

  const topics = [
    { title: 'I Built a Free README Generator That Actually Works', tag: 'readme', tags: ['webdev', 'productivity', 'opensource', 'javascript'] },
    { title: 'Stop Converting JS to TypeScript by Hand', tag: 'typescript', tags: ['typescript', 'javascript', 'webdev', 'tutorial'] },
    { title: 'Free AI Code Review Tool for Solo Devs', tag: 'codereview', tags: ['programming', 'webdev', 'productivity', 'ai'] },
    { title: 'I Built 6 Free Dev Tools — Here\'s What I Learned', tag: 'tools', tags: ['webdev', 'javascript', 'productivity', 'showdev'] },
    { title: 'How I Automated My Freelance Pipeline with AI', tag: 'freelance', tags: ['career', 'programming', 'ai', 'productivity'] },
    { title: 'Generate Landing Pages in 30 Seconds — No Framework Needed', tag: 'landing', tags: ['webdev', 'html', 'css', 'showdev'] },
    // Solana ecosystem articles
    { title: 'Free Solana Dev Tools Every Builder Needs', tag: 'solana-tools', tags: ['solana', 'blockchain', 'webdev', 'showdev'] },
    { title: 'I Built an Anchor IDL to TypeScript Generator', tag: 'anchor-idl', tags: ['solana', 'typescript', 'blockchain', 'tutorial'] },
    { title: 'How to Validate Solana Addresses Without an RPC Call', tag: 'solana-validate', tags: ['solana', 'blockchain', 'tutorial', 'javascript'] },
    { title: 'Planning Token Economics for Your SPL Token Launch', tag: 'tokenomics', tags: ['solana', 'blockchain', 'crypto', 'tutorial'] },
  ];

  // Pick topic we haven't published yet
  const published = db.prepare(
    "SELECT content_preview FROM marketing_actions WHERE channel = 'devto' AND action_type = 'publish'"
  ).all().map(r => r.content_preview);
  const unpublished = topics.filter(t => !published.some(p => p.includes(t.tag)));
  if (unpublished.length === 0) return { published: 0, reason: 'all_published' };

  const topic = unpublished[Math.floor(Math.random() * unpublished.length)];

  const prompt = `Write a Dev.to article with this title: "${topic.title}"

The article should:
- Be 400-600 words
- Be practical and code-focused
- Include code snippets where relevant
- Mention the free tool at ${TOOLS_URL} naturally (not salesy)
- End with a call to action to try the tool
- Use markdown formatting
- Sound like a real developer sharing their work, not marketing copy
- Include a "---" section at the end with "Built by SnipeLink LLC"

Do NOT include frontmatter. Just the article body in markdown.`;

  try {
    const body = await askClaude(prompt, 1200);
    if (!body || body.length < 200) return { published: 0, reason: 'generation_failed' };

    const res = await fetch('https://dev.to/api/articles', {
      method: 'POST',
      headers: {
        'api-key': devtoKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        article: {
          title: topic.title,
          published: true,
          body_markdown: body,
          tags: topic.tags,
          canonical_url: TOOLS_URL,
        },
      }),
      signal: AbortSignal.timeout(30000),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Dev.to API ${res.status}`);

    trackAction('devto', 'publish', data.url || TOOLS_URL, topic.tag);
    return { published: 1, url: data.url, title: topic.title };
  } catch (err) {
    console.error('[marketing] Dev.to publish failed:', err.message);
    return { published: 0, error: err.message };
  }
}

// ─── 6. Reddit Agent ──────────────────────────────────────
// Posts helpful answers on dev subreddits (via API or scraping)
async function redditOutreach() {
  // Reddit requires OAuth — check for credentials
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const username = process.env.REDDIT_USERNAME;
  const password = process.env.REDDIT_PASSWORD;
  if (!clientId || !clientSecret || !username || !password) return { actions: 0, reason: 'no_credentials' };

  // Max 2 Reddit actions per day
  const todayReddit = db.prepare(
    "SELECT COUNT(*) as cnt FROM marketing_actions WHERE channel = 'reddit' AND created_at >= date('now')"
  ).get()?.cnt || 0;
  if (todayReddit >= 2) return { actions: 0, reason: 'daily_limit' };

  try {
    // Get OAuth token
    const tokenRes = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'AgencyCommand/1.0',
      },
      body: `grant_type=password&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
      signal: AbortSignal.timeout(15000),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('Reddit auth failed');

    const redditApi = (path, opts = {}) => fetch(`https://oauth.reddit.com${path}`, {
      ...opts,
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'User-Agent': 'AgencyCommand/1.0',
        ...(opts.headers || {}),
      },
      signal: AbortSignal.timeout(15000),
    }).then(r => r.json());

    // Search relevant subreddits for questions we can answer
    const subreddits = ['webdev', 'learnprogramming', 'javascript', 'typescript', 'node'];
    const searchTerms = ['README generator', 'convert javascript to typescript', 'code review tool', 'landing page generator'];
    let actions = 0;

    for (const sub of subreddits) {
      if (actions >= 2) break;
      const term = searchTerms[Math.floor(Math.random() * searchTerms.length)];

      try {
        const results = await redditApi(`/r/${sub}/search?q=${encodeURIComponent(term)}&sort=new&t=week&limit=5&restrict_sr=true`);
        const posts = results?.data?.children || [];

        for (const post of posts) {
          if (actions >= 2) break;
          const p = post.data;
          if (alreadyCommentedOn(`https://reddit.com${p.permalink}`)) continue;
          if (p.num_comments > 20) continue; // Already well-answered

          const prompt = `Write a helpful Reddit comment for r/${sub}. The post title is: "${p.title}"
Post body: ${(p.selftext || '').slice(0, 500)}

Write a genuinely helpful response with practical advice. At the very end, casually mention: "I also built a free tool for this if you want to try it: ${TOOLS_URL}"

Keep it under 150 words. Sound like a real Redditor, not a marketer. Use casual tone.`;

          const comment = await askClaude(prompt, 300);
          if (!comment || comment.length < 40) continue;

          await redditApi(`/api/comment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `thing_id=${p.name}&text=${encodeURIComponent(comment)}`,
          });

          trackAction('reddit', 'comment', `https://reddit.com${p.permalink}`, comment.slice(0, 500));
          actions++;
          await sleep(3000); // Reddit rate limits
        }
      } catch (e) { /* skip subreddit */ }
    }

    return { actions };
  } catch (err) {
    console.error('[marketing] Reddit outreach failed:', err.message);
    return { actions: 0, error: err.message };
  }
}

// ─── 7. Stack Overflow Monitor ────────────────────────────
// Monitors SO for questions we can answer with tool links
async function stackOverflowMonitor() {
  // SO API is free, no auth needed for reads
  // We can't auto-post without SO credentials, but we can generate ready-to-post answers

  const soQueries = [
    'generate+readme+automatically',
    'convert+javascript+typescript+tool',
    'automated+code+review',
    'generate+landing+page+html',
  ];

  const results = [];

  for (const query of soQueries.slice(0, 2)) { // Max 2 queries per cycle
    try {
      const res = await fetch(
        `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=creation&q=${query}&site=stackoverflow&pagesize=3&filter=withbody`,
        { signal: AbortSignal.timeout(15000) }
      );
      const data = await res.json();
      if (!data.items) continue;

      for (const q of data.items) {
        if (alreadyCommentedOn(q.link)) continue;
        if (q.answer_count > 5) continue;

        const toolCtx = detectToolContext(query.replace(/\+/g, ' '));
        const prompt = `Write a Stack Overflow answer for: "${q.title}"

Question: ${(q.body || '').replace(/<[^>]+>/g, '').slice(0, 600)}

Write a complete, helpful answer with code examples. At the end, mention:
"You might also find this free ${toolCtx.name} useful: ${toolCtx.url}"

Keep it professional. Use code blocks. Under 300 words.`;

        const answer = await askClaude(prompt, 600);
        if (!answer || answer.length < 100) continue;

        // Store as draft — SO requires manual posting or authenticated API
        trackAction('stackoverflow', 'draft_answer', q.link, answer.slice(0, 500), 'draft');
        results.push({ question: q.link, title: q.title, answer: answer.slice(0, 200) });
      }

      await sleep(1000);
    } catch (e) {
      console.error('[marketing] SO monitor failed:', e.message);
    }
  }

  return results;
}

// ─── 8. GitHub Stars Outreach ─────────────────────────────
// Star repos that use similar tools → they see our profile → discover tools
async function githubStarOutreach() {
  if (!process.env.GITHUB_TOKEN) return { starred: 0 };

  // Max 10 stars per cycle
  const todayStars = db.prepare(
    "SELECT COUNT(*) as cnt FROM marketing_actions WHERE channel = 'github_stars' AND created_at >= date('now')"
  ).get()?.cnt || 0;
  if (todayStars >= 10) return { starred: 0, reason: 'daily_limit' };

  const searchQueries = [
    'readme generator',
    'typescript converter',
    'code review tool',
    'developer tools',
    'landing page generator',
    'solana anchor template',
    'solana dapp typescript',
    'spl token creator',
  ];

  let starred = 0;
  const query = searchQueries[Math.floor(Math.random() * searchQueries.length)];

  try {
    const results = await gh(`/search/repositories?q=${encodeURIComponent(query)}&sort=updated&per_page=10`);
    for (const repo of (results.items || [])) {
      if (starred >= 5) break;
      if (repo.owner.login === GITHUB_USERNAME) continue;
      if (alreadyCommentedOn(repo.html_url)) continue;

      try {
        await gh(`/user/starred/${repo.full_name}`, { method: 'PUT', headers: { 'Content-Length': '0' } });
        trackAction('github_stars', 'star', repo.html_url, repo.full_name);
        starred++;
        await sleep(500);
      } catch (e) { /* already starred or rate limited */ }
    }
  } catch (e) {
    console.error('[marketing] Star outreach failed:', e.message);
  }

  return { starred };
}

// ─── 9. NPM Package Publishing ────────────────────────────
// Publish lightweight npm packages that link back to our tools
async function npmPackageMarketing() {
  // Generate npm package ideas that wrap our API
  // These are legitimate packages that call our tools endpoint
  const todayNpm = db.prepare(
    "SELECT COUNT(*) as cnt FROM marketing_actions WHERE channel = 'npm' AND created_at >= date('now')"
  ).get()?.cnt || 0;
  if (todayNpm >= 1) return { packages: 0, reason: 'daily_limit' };

  const packages = [
    { name: '@snipelink/readme-gen', desc: 'Generate professional READMEs from your codebase', tool: 'readme-generator' },
    { name: '@snipelink/js-to-ts', desc: 'Convert JavaScript to TypeScript with proper types', tool: 'convert-to-typescript' },
    { name: '@snipelink/code-review', desc: 'AI-powered code review CLI', tool: 'code-review' },
    { name: '@snipelink/api-docs', desc: 'Generate API documentation from code', tool: 'api-docs' },
  ];

  // Generate package.json and index.js for one unpublished package
  const unpublished = packages.filter(p =>
    !db.prepare("SELECT 1 FROM marketing_actions WHERE channel = 'npm' AND content_preview LIKE ?").get(`%${p.name}%`)
  );

  if (unpublished.length === 0) return { packages: 0, reason: 'all_published' };
  const pkg = unpublished[0];

  const packageContent = `// ${pkg.desc}
// Free preview at: ${TOOLS_URL}
// Full docs: ${PORTFOLIO_URL}

const TOOL_API = '${API_BASE}/api/tools/${pkg.tool}';

async function generate(input) {
  const res = await fetch(TOOL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return res.json();
}

module.exports = { generate };
module.exports.default = generate;
`;

  // Store as draft — actual npm publish needs npm credentials on the server
  trackAction('npm', 'draft_package', TOOLS_URL, `${pkg.name}: ${pkg.desc}`, 'draft');
  return { packages: 1, drafted: pkg.name };
}

// ─── 10. Hacker News Monitor ──────────────────────────────
// Monitor HN for relevant "Show HN" or "Ask HN" posts
async function hackerNewsMonitor() {
  const todayHN = db.prepare(
    "SELECT COUNT(*) as cnt FROM marketing_actions WHERE channel = 'hackernews' AND created_at >= date('now')"
  ).get()?.cnt || 0;
  if (todayHN >= 2) return { drafted: 0, reason: 'daily_limit' };

  try {
    // HN Algolia API — free, no auth
    const queries = ['developer tools', 'readme generator', 'typescript converter'];
    const query = queries[Math.floor(Math.random() * queries.length)];

    const res = await fetch(
      `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=5`,
      { signal: AbortSignal.timeout(15000) }
    );
    const data = await res.json();
    const results = [];

    for (const hit of (data.hits || [])) {
      if (alreadyCommentedOn(`https://news.ycombinator.com/item?id=${hit.objectID}`)) continue;

      const prompt = `Write a brief, insightful Hacker News comment for a post titled: "${hit.title}"

Be thoughtful and add genuine value. If relevant, casually mention you built similar tools at ${TOOLS_URL}.
Sound like a real HN commenter — technical, concise, slightly opinionated. Under 100 words.`;

      const comment = await askClaude(prompt, 200);
      if (!comment || comment.length < 30) continue;

      // HN doesn't have a public write API — store as draft
      trackAction('hackernews', 'draft_comment', `https://news.ycombinator.com/item?id=${hit.objectID}`, comment.slice(0, 500), 'draft');
      results.push({ url: `https://news.ycombinator.com/item?id=${hit.objectID}`, title: hit.title });

      if (results.length >= 2) break;
    }

    return { drafted: results.length, items: results };
  } catch (e) {
    console.error('[marketing] HN monitor failed:', e.message);
    return { drafted: 0, error: e.message };
  }
}

// ─── 11. GitHub Trending Piggyback ────────────────────────
// Find trending repos and open useful issues/PRs with tool links
async function trendingRepoPiggyback() {
  if (!process.env.GITHUB_TOKEN) return { actions: 0 };

  const todayTrending = db.prepare(
    "SELECT COUNT(*) as cnt FROM marketing_actions WHERE channel = 'github_trending' AND created_at >= date('now')"
  ).get()?.cnt || 0;
  if (todayTrending >= 2) return { actions: 0, reason: 'daily_limit' };

  let actions = 0;

  try {
    // Find repos created recently with high stars (trending signal)
    const results = await gh(`/search/repositories?q=created:>2026-03-04+stars:>50&sort=stars&per_page=10`);

    for (const repo of (results.items || [])) {
      if (actions >= 2) break;
      if (alreadyCommentedOn(repo.html_url)) continue;

      // Check if repo is missing a README or has a bare one
      let readme;
      try {
        readme = await gh(`/repos/${repo.full_name}/readme`);
        const content = Buffer.from(readme.content || '', 'base64').toString();
        if (content.length > 500) continue; // Already has a good README
      } catch (e) {
        // No README — perfect target
      }

      // Open a helpful issue offering to improve their README
      const issueBody = `Hey! Congrats on the project — noticed the README could use some love.

I built a free tool that generates professional READMEs from codebases: ${TOOLS_URL}

It analyzes your code structure and generates:
- Feature descriptions
- Install instructions
- Usage examples
- API docs (if applicable)

Happy to submit a PR with an improved README if you're interested! Just let me know.`;

      try {
        await gh(`/repos/${repo.full_name}/issues`, {
          method: 'POST',
          body: JSON.stringify({
            title: 'Improve README documentation',
            body: issueBody,
          }),
        });
        trackAction('github_trending', 'issue', repo.html_url, `Offered README improvement to ${repo.full_name}`);
        actions++;
        await sleep(2000);
      } catch (e) { /* no permission to open issues */ }
    }
  } catch (e) {
    console.error('[marketing] Trending piggyback failed:', e.message);
  }

  return { actions };
}

// ─── 11. Solana Ecosystem Outreach ────────────────────────
// Comment on Solana dev issues, star Solana repos, promote tools in Solana community
async function solanaEcosystemOutreach() {
  let actions = 0;

  // Star Solana ecosystem repos for visibility
  const solanaQueries = [
    'solana anchor program',
    'spl token typescript',
    'solana dapp template',
    'solana rust smart contract',
    'metaplex nft',
  ];
  const query = solanaQueries[Math.floor(Math.random() * solanaQueries.length)];

  try {
    const results = await gh(`/search/repositories?q=${encodeURIComponent(query)}&sort=updated&per_page=8`);
    for (const repo of (results.items || [])) {
      if (actions >= 3) break;
      if (repo.owner.login === GITHUB_USERNAME) continue;
      if (alreadyCommentedOn(repo.html_url)) continue;

      try {
        await gh(`/user/starred/${repo.full_name}`, { method: 'PUT', headers: { 'Content-Length': '0' } });
        trackAction('solana_outreach', 'star', repo.html_url, repo.full_name);
        actions++;
        await sleep(500);
      } catch (e) { /* already starred */ }
    }
  } catch (e) {
    console.error('[marketing] Solana star outreach failed:', e.message);
  }

  // Comment on Solana-related issues where our tools help
  const solanaIssueQueries = [
    '"anchor idl" "typescript" type:issue state:open',
    '"spl token" "tokenomics" type:issue state:open',
    '"solana" "validate address" type:issue state:open',
    '"solana" "keypair" "generate" type:issue state:open',
  ];
  const issueQuery = solanaIssueQueries[Math.floor(Math.random() * solanaIssueQueries.length)];

  try {
    const searchResult = await gh(`/search/issues?q=${encodeURIComponent(issueQuery)}&sort=created&order=desc&per_page=3`);
    for (const issue of (searchResult.items || [])) {
      if (actions >= 5) break;
      if (alreadyCommentedOn(issue.html_url)) continue;
      if (issue.comments > 5) continue;

      const repoPath = issue.repository_url.split('/repos/')[1];
      const comments = await gh(`/repos/${repoPath}/issues/${issue.number}/comments?per_page=50`);
      if (comments.some(c => c.user?.login === GITHUB_USERNAME)) continue;

      const toolCtx = detectToolContext(issueQuery);
      const prompt = `You are a Solana developer helping on a GitHub issue. The issue is: "${issue.title}"

Issue body: ${(issue.body ?? '').slice(0, 800)}

Write a genuinely helpful response with real technical advice for Solana development.

At the end, briefly mention this free tool: ${toolCtx.name} at ${toolCtx.url} — ${toolCtx.desc}

Keep it under 150 words. Be helpful first, tool mention is a brief aside. Sound like a real Solana dev.`;

      const comment = await askClaude(prompt, 300);
      if (!comment || comment.length < 50) continue;

      await gh(`/repos/${repoPath}/issues/${issue.number}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: comment }),
      });

      trackAction('solana_outreach', 'comment', issue.html_url, comment.slice(0, 500));
      actions++;
      await sleep(2000);
    }
  } catch (e) {
    console.error('[marketing] Solana issue outreach failed:', e.message);
  }

  return { actions };
}

// ─── Main Entry Point ─────────────────────────────────────
export async function runMarketingAgent() {
  console.log('[marketing] Starting full marketing cycle across all platforms...');
  const summary = {};

  // Phase 1: GitHub actions (our main platform — has API keys)
  const [profile, issues, discussions, stars, trending] = await Promise.allSettled([
    updateProfileReadme(),
    helpOnIssues(),
    answerDiscussions(),
    githubStarOutreach(),
    trendingRepoPiggyback(),
  ]);
  summary.profile = profile.status === 'fulfilled' ? profile.value : { error: profile.reason?.message };
  summary.issues = issues.status === 'fulfilled' ? issues.value : [];
  summary.discussions = discussions.status === 'fulfilled' ? discussions.value : [];
  summary.stars = stars.status === 'fulfilled' ? stars.value : { starred: 0 };
  summary.trending = trending.status === 'fulfilled' ? trending.value : { actions: 0 };

  // Phase 2: External platforms + Solana outreach (parallel — each has own rate limits)
  const [devto, reddit, stackoverflow, hackernews, npm, solana] = await Promise.allSettled([
    publishToDevTo(),
    redditOutreach(),
    stackOverflowMonitor(),
    hackerNewsMonitor(),
    npmPackageMarketing(),
    solanaEcosystemOutreach(),
  ]);
  summary.devto = devto.status === 'fulfilled' ? devto.value : { error: devto.reason?.message };
  summary.reddit = reddit.status === 'fulfilled' ? reddit.value : { actions: 0 };
  summary.stackoverflow = stackoverflow.status === 'fulfilled' ? stackoverflow.value : [];
  summary.hackernews = hackernews.status === 'fulfilled' ? hackernews.value : { drafted: 0 };
  summary.npm = npm.status === 'fulfilled' ? npm.value : { packages: 0 };
  summary.solana = solana.status === 'fulfilled' ? solana.value : { actions: 0 };

  // Count total actions
  const totalActions =
    (summary.profile?.success ? 1 : 0) +
    (summary.issues?.length || 0) +
    (summary.discussions?.length || 0) +
    (summary.stars?.starred || 0) +
    (summary.trending?.actions || 0) +
    (summary.devto?.published || 0) +
    (summary.reddit?.actions || 0) +
    (summary.stackoverflow?.length || 0) +
    (summary.hackernews?.drafted || 0) +
    (summary.npm?.packages || 0) +
    (summary.solana?.actions || 0);

  const logParts = [
    `Profile: ${summary.profile?.success ? 'updated' : 'skipped'}`,
    `GitHub issues: ${summary.issues?.length || 0}`,
    `Discussions: ${summary.discussions?.length || 0}`,
    `Stars: ${summary.stars?.starred || 0}`,
    `Trending: ${summary.trending?.actions || 0}`,
    `Dev.to: ${summary.devto?.published || 0}`,
    `Reddit: ${summary.reddit?.actions || 0}`,
    `SO drafts: ${summary.stackoverflow?.length || 0}`,
    `HN drafts: ${summary.hackernews?.drafted || 0}`,
    `NPM: ${summary.npm?.packages || 0}`,
    `Solana: ${summary.solana?.actions || 0}`,
  ];

  await notify(
    'marketing',
    `Marketing cycle: ${totalActions} actions across all platforms`,
    logParts.join('\n')
  ).catch(() => {});

  console.log(`[marketing] Cycle complete: ${totalActions} total actions`);
  logParts.forEach(l => console.log(`  ${l}`));

  return summary;
}

// ─── Stats ────────────────────────────────────────────────
export function getMarketingStats() {
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM marketing_actions`).get();
  const byChannel = db.prepare(`
    SELECT channel, COUNT(*) as cnt FROM marketing_actions GROUP BY channel
  `).all();
  const totalClicks = db.prepare(`SELECT COALESCE(SUM(clicks), 0) as cnt FROM marketing_actions`).get();
  const todayActions = db.prepare(`
    SELECT COUNT(*) as cnt FROM marketing_actions WHERE created_at >= date('now')
  `).get();
  const recentDrafts = db.prepare(`
    SELECT * FROM marketing_actions WHERE status = 'draft' ORDER BY created_at DESC LIMIT 10
  `).all();

  return {
    totalActions: total?.cnt ?? 0,
    totalClicks: totalClicks?.cnt ?? 0,
    todayActions: todayActions?.cnt ?? 0,
    byChannel: byChannel.reduce((acc, r) => { acc[r.channel] = r.cnt; return acc; }, {}),
    recentDrafts,
  };
}

// ─── Utility ──────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

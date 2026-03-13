import db from '../db/connection.js';
import { notify } from './notifications.js';
import { trackSpend } from './analyticsTracker.js';
import { randomUUID } from 'crypto';

// ═══════════════════════════════════════════════════════════
// DATA AGENT — The Brain
// Monitors all agents, analyzes performance, kills broken ones,
// adjusts strategies based on data, drives traffic decisions
// ═══════════════════════════════════════════════════════════

// ─── Schema ──────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_health (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    status TEXT NOT NULL,
    actions INTEGER DEFAULT 0,
    errors TEXT DEFAULT '',
    duration_ms INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agent_config (
    agent TEXT PRIMARY KEY,
    enabled INTEGER DEFAULT 1,
    disabled_reason TEXT DEFAULT '',
    disabled_at TEXT DEFAULT '',
    settings TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS performance_metrics (
    id TEXT PRIMARY KEY,
    metric TEXT NOT NULL,
    platform TEXT NOT NULL,
    value REAL NOT NULL,
    period TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Initialize agent configs if not exist
const AGENTS = [
  'x-poster', 'x-reply-guy', 'x-hype-man', 'x-engager',
  'youtube', 'giveaway', 'marketing', 'bounty-solver',
  'social-reddit', 'social-discord', 'social-telegram',
  'social-bluesky', 'social-nostr', 'social-mastodon',
];

for (const agent of AGENTS) {
  db.prepare(`INSERT OR IGNORE INTO agent_config (agent) VALUES (?)`).run(agent);
}

// ─── Agent Health Tracking ───────────────────────────────

export function reportHealth(agent, status, actions = 0, errors = '', durationMs = 0) {
  try {
    db.prepare(`INSERT INTO agent_health (id, agent, status, actions, errors, duration_ms) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), agent, status, actions, typeof errors === 'string' ? errors : JSON.stringify(errors), durationMs);
  } catch (e) { console.error('[DATA-AGENT] Health report failed:', e.message); }
}

export function isAgentEnabled(agent) {
  const row = db.prepare(`SELECT enabled FROM agent_config WHERE agent = ?`).get(agent);
  return row ? row.enabled === 1 : true;
}

export function disableAgent(agent, reason) {
  db.prepare(`UPDATE agent_config SET enabled = 0, disabled_reason = ?, disabled_at = datetime('now') WHERE agent = ?`)
    .run(reason, agent);
  console.log(`[DATA-AGENT] DISABLED ${agent}: ${reason}`);
}

export function enableAgent(agent) {
  db.prepare(`UPDATE agent_config SET enabled = 1, disabled_reason = '', disabled_at = '' WHERE agent = ?`)
    .run(agent);
  console.log(`[DATA-AGENT] ENABLED ${agent}`);
}

// ─── API Health Check ────────────────────────────────────

async function checkAnthropicCredits() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, reason: 'No API key' };

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) return { ok: true };

    const data = await res.json().catch(() => ({}));
    const msg = data?.error?.message || `HTTP ${res.status}`;

    if (msg.includes('credit balance is too low') || msg.includes('billing')) {
      return { ok: false, reason: 'Credits depleted', code: 'NO_CREDITS' };
    }
    if (res.status === 429) {
      return { ok: false, reason: 'Rate limited', code: 'RATE_LIMITED' };
    }
    return { ok: false, reason: msg };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function checkXApi() {
  if (!process.env.X_API_KEY || !process.env.X_ACCESS_TOKEN) {
    return { ok: false, reason: 'No X credentials' };
  }

  try {
    const OAuth = (await import('oauth-1.0a')).default;
    const { createHmac } = await import('crypto');
    const oauth = new OAuth({
      consumer: { key: process.env.X_API_KEY, secret: process.env.X_API_SECRET },
      signature_method: 'HMAC-SHA1',
      hash_function(baseString, key) { return createHmac('sha1', key).update(baseString).digest('base64'); },
    });
    const token = { key: process.env.X_ACCESS_TOKEN, secret: process.env.X_ACCESS_SECRET };
    const url = 'https://api.twitter.com/2/users/me';
    const authHeader = oauth.toHeader(oauth.authorize({ url, method: 'GET' }, token));

    const res = await fetch(url, { headers: { ...authHeader }, signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      return { ok: true, username: data.data?.username };
    }

    // Check rate limit headers
    const remaining = res.headers.get('x-rate-limit-remaining');
    const reset = res.headers.get('x-rate-limit-reset');
    if (remaining === '0') {
      const resetDate = new Date(parseInt(reset) * 1000);
      return { ok: false, reason: `Rate limited until ${resetDate.toISOString()}`, code: 'RATE_LIMITED' };
    }
    return { ok: false, reason: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ─── Performance Analysis ────────────────────────────────

function getAgentPerformance(agent, hours = 24) {
  const rows = db.prepare(`
    SELECT status, COUNT(*) as runs, SUM(actions) as total_actions, AVG(actions) as avg_actions,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count
    FROM agent_health
    WHERE agent = ? AND created_at > datetime('now', '-${hours} hours')
    GROUP BY status
  `).all(agent);

  const totalRuns = rows.reduce((s, r) => s + r.runs, 0);
  const totalActions = rows.reduce((s, r) => s + (r.total_actions || 0), 0);
  const errorCount = rows.reduce((s, r) => s + (r.error_count || 0), 0);

  return {
    agent,
    totalRuns,
    totalActions,
    avgActionsPerRun: totalRuns > 0 ? (totalActions / totalRuns).toFixed(1) : '0',
    errorRate: totalRuns > 0 ? ((errorCount / totalRuns) * 100).toFixed(0) + '%' : 'N/A',
    healthy: errorCount < totalRuns * 0.5, // Less than 50% error rate
  };
}

function getXContentPerformance() {
  // Analyze which types of X content perform best
  const posts = db.prepare(`
    SELECT action_type, COUNT(*) as count,
           content
    FROM social_posts
    WHERE platform = 'x' AND created_at > datetime('now', '-7 days')
    GROUP BY action_type
    ORDER BY count DESC
  `).all();

  // Count posts by type today
  const todayByType = db.prepare(`
    SELECT action_type, COUNT(*) as count
    FROM social_posts
    WHERE platform = 'x' AND created_at > date('now')
    GROUP BY action_type
  `).all();

  return { weeklyByType: posts, todayByType };
}

function getPlatformStats() {
  // How each platform is performing
  const stats = db.prepare(`
    SELECT platform, COUNT(*) as total_posts,
           SUM(CASE WHEN created_at > date('now') THEN 1 ELSE 0 END) as today,
           SUM(CASE WHEN created_at > datetime('now', '-7 days') THEN 1 ELSE 0 END) as week
    FROM social_posts
    GROUP BY platform
    ORDER BY week DESC
  `).all();

  return stats;
}

function getSpendAnalysis() {
  // What are we spending API credits on?
  const spend = db.prepare(`
    SELECT source, SUM(amount_usd) as total, COUNT(*) as calls
    FROM pnl_tracker
    WHERE type = 'spend' AND created_at > datetime('now', '-24 hours')
    GROUP BY source
    ORDER BY total DESC
  `).all();

  const totalToday = db.prepare(`
    SELECT COALESCE(SUM(amount_usd), 0) as total FROM pnl_tracker
    WHERE type = 'spend' AND created_at > date('now')
  `).get().total;

  return { breakdown: spend, totalToday };
}

// ─── Smart Decisions ─────────────────────────────────────

async function makeDecisions() {
  const decisions = [];

  // 1. Check if Anthropic API is working
  const anthropic = await checkAnthropicCredits();
  if (!anthropic.ok) {
    if (anthropic.code === 'NO_CREDITS') {
      // Disable all agents that depend on Claude for content generation
      const claudeAgents = ['marketing', 'bounty-solver'];
      for (const agent of claudeAgents) {
        if (isAgentEnabled(agent)) {
          disableAgent(agent, 'Anthropic API credits depleted — wasting cycles');
          decisions.push(`DISABLED ${agent}: API credits out, was burning compute for nothing`);
        }
      }
      // X agents can still work with queued content + hype replies
      decisions.push('NOTE: X agents using queued content + pre-written hype (no Claude needed)');
    }
  } else {
    // API is back! Re-enable agents
    const claudeAgents = ['marketing', 'bounty-solver'];
    for (const agent of claudeAgents) {
      const config = db.prepare(`SELECT * FROM agent_config WHERE agent = ?`).get(agent);
      if (config && !config.enabled && config.disabled_reason?.includes('credit')) {
        enableAgent(agent);
        decisions.push(`RE-ENABLED ${agent}: Anthropic API credits restored`);
      }
    }
  }

  // 2. Check X API health
  const xApi = await checkXApi();
  if (!xApi.ok && xApi.code === 'RATE_LIMITED') {
    const xAgents = ['x-poster', 'x-reply-guy', 'x-hype-man', 'x-engager'];
    for (const agent of xAgents) {
      if (isAgentEnabled(agent)) {
        disableAgent(agent, `X API rate limited: ${xApi.reason}`);
        decisions.push(`DISABLED ${agent}: X API rate limited`);
      }
    }
  } else if (xApi.ok) {
    // Re-enable if previously disabled for rate limiting
    const xAgents = ['x-poster', 'x-reply-guy', 'x-hype-man', 'x-engager'];
    for (const agent of xAgents) {
      const config = db.prepare(`SELECT * FROM agent_config WHERE agent = ?`).get(agent);
      if (config && !config.enabled && config.disabled_reason?.includes('rate limit')) {
        enableAgent(agent);
        decisions.push(`RE-ENABLED ${agent}: X API accessible again`);
      }
    }
  }

  // 3. Check agent error rates — auto-disable agents with >80% failure in last 6h
  for (const agent of AGENTS) {
    const perf = getAgentPerformance(agent, 6);
    if (perf.totalRuns >= 3 && parseInt(perf.errorRate) > 80) {
      if (isAgentEnabled(agent)) {
        const recentErrors = db.prepare(`
          SELECT errors FROM agent_health WHERE agent = ? AND status = 'error'
          ORDER BY created_at DESC LIMIT 1
        `).get(agent);
        const reason = `${perf.errorRate} error rate in 6h. Last: ${(recentErrors?.errors || 'unknown').slice(0, 100)}`;
        disableAgent(agent, reason);
        decisions.push(`DISABLED ${agent}: ${reason}`);
      }
    }
  }

  // 4. Analyze X content — what types get the most traction?
  const xPerf = getXContentPerformance();
  if (xPerf.todayByType.length > 0) {
    const typeMap = {};
    for (const t of xPerf.todayByType) typeMap[t.action_type] = t.count;
    decisions.push(`X activity today: ${JSON.stringify(typeMap)}`);
  }

  // 5. Check platform distribution — are we neglecting any platform?
  const platforms = getPlatformStats();
  const activePlatforms = platforms.filter(p => p.today > 0).map(p => p.platform);
  const deadPlatforms = platforms.filter(p => p.week > 0 && p.today === 0).map(p => p.platform);
  if (deadPlatforms.length > 0) {
    decisions.push(`ALERT: Platforms active this week but quiet today: ${deadPlatforms.join(', ')}`);
  }

  // 6. Spend efficiency — flag any agent burning >$0.05/day with 0 results
  const spend = getSpendAnalysis();
  for (const item of spend.breakdown) {
    if (item.total > 0.05 && item.calls > 10) {
      // Check if this source produced any results
      const agentName = item.source.replace('social-agent-haiku', 'social').replace('-haiku', '');
      decisions.push(`SPEND ALERT: ${item.source} spent $${item.total.toFixed(3)} on ${item.calls} calls today`);
    }
  }

  return decisions;
}

// ─── Daily Report ────────────────────────────────────────

function generateDailyReport() {
  const platformStats = getPlatformStats();
  const xPerf = getXContentPerformance();
  const spend = getSpendAnalysis();

  const agentPerfs = AGENTS.map(a => getAgentPerformance(a, 24));
  const configs = db.prepare(`SELECT * FROM agent_config`).all();

  const enabledCount = configs.filter(c => c.enabled).length;
  const disabledList = configs.filter(c => !c.enabled).map(c => `${c.agent}: ${c.disabled_reason}`);

  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      totalAgents: AGENTS.length,
      enabled: enabledCount,
      disabled: configs.length - enabledCount,
    },
    platformActivity: platformStats,
    xBreakdown: xPerf.todayByType,
    agentPerformance: agentPerfs.filter(p => p.totalRuns > 0),
    disabledAgents: disabledList,
    spend: {
      today: `$${spend.totalToday.toFixed(3)}`,
      breakdown: spend.breakdown,
    },
  };

  return report;
}

// ─── Main Run ────────────────────────────────────────────

export async function runDataAgent() {
  console.log('[DATA-AGENT] Running analysis cycle...');
  const startTime = Date.now();

  try {
    // Make smart decisions based on current state
    const decisions = await makeDecisions();
    const report = generateDailyReport();

    const duration = Date.now() - startTime;

    // Log decisions
    if (decisions.length > 0) {
      console.log('[DATA-AGENT] Decisions:');
      for (const d of decisions) console.log(`  → ${d}`);
    }

    // Log summary
    console.log(`[DATA-AGENT] Status: ${report.summary.enabled}/${report.summary.totalAgents} agents active | Spend: ${report.spend.today}`);
    if (report.disabledAgents.length > 0) {
      console.log(`[DATA-AGENT] Disabled: ${report.disabledAgents.join(' | ')}`);
    }

    // Platform activity summary
    const platSummary = report.platformActivity.map(p => `${p.platform}:${p.today}`).join(' ');
    console.log(`[DATA-AGENT] Platform activity today: ${platSummary}`);

    reportHealth('data-agent', 'ok', decisions.length, '', duration);

    return { decisions, report, duration };
  } catch (e) {
    console.error('[DATA-AGENT] Analysis failed:', e.message);
    reportHealth('data-agent', 'error', 0, e.message, Date.now() - startTime);
    return { decisions: [], report: null, error: e.message };
  }
}

// ─── API exports for dashboard ───────────────────────────

export function getAgentStatus() {
  const configs = db.prepare(`SELECT * FROM agent_config`).all();
  const perfs = AGENTS.map(a => ({
    ...getAgentPerformance(a, 24),
    config: configs.find(c => c.agent === a) || { enabled: 1 },
  }));
  return perfs;
}

export function getDailyReportData() {
  return generateDailyReport();
}

export { isAgentEnabled as checkAgent };

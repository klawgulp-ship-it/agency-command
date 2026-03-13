import db from '../db/connection.js';
import { trackSpend } from './analyticsTracker.js';
import { randomUUID } from 'crypto';

// ─── DB Setup ─────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS giveaways (
    id TEXT PRIMARY KEY,
    tweet_id TEXT,
    format TEXT,
    amount TEXT,
    status TEXT DEFAULT 'active',
    entries INTEGER DEFAULT 0,
    winner_address TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    ends_at TEXT
  );
  CREATE TABLE IF NOT EXISTS giveaway_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    giveaway_id TEXT NOT NULL,
    tweet_id TEXT,
    username TEXT,
    sol_address TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Viral Trigger Words ──────────────────────────────────
// These words/phrases trigger curiosity, FOMO, and engagement on crypto Twitter
const POWER_WORDS = [
  'FREE', 'AIRDROP', 'GIVEAWAY', 'DROPPING', 'SENDING',
  'FIRST 100', 'FIRST 500', 'NEXT 24H', 'RIGHT NOW',
  'NO CATCH', 'FREE MONEY', 'CLAIMING', 'LIVE NOW',
  'MASSIVE', 'HUGE', 'INSANE', 'JUST LAUNCHED',
];

const URGENCY_PHRASES = [
  'Ends in 24h',
  'First come first served',
  'Only 100 spots',
  'Going fast',
  'Last chance',
  'Closing soon',
  'Limited supply',
  'While supplies last',
];

const CTA_PHRASES = [
  'Drop your SOL address',
  'Drop SOL address below',
  'Comment your SOL wallet',
  'Leave your SOL address',
  'Reply with your SOL address',
  'Post your SOL wallet below',
];

// ─── Giveaway Tweet Formats ──────────────────────────────
// Rotating formats that exploit engagement triggers
const GIVEAWAY_FORMATS = [
  {
    name: 'classic_viral',
    template: () => {
      const amount = randomAmount();
      return `$SLK GIVEAWAY\n\nGiving away ${amount} $SLK to 3 winners\n\nTo enter:\n1. Follow @snipelink\n2. Like + RT\n3. Tag 2 friends who need free crypto\n4. Drop your SOL address\n\nWinners picked in 24h\n\nsnipelink.com`;
    },
  },
  {
    name: 'dev_community',
    template: () => {
      const amount = randomAmount();
      return `Devs deserve free tools AND free tokens\n\n${amount} $SLK giveaway\n\nHow to enter:\n1. Follow @snipelink\n2. RT this post\n3. Tag a dev friend\n4. Reply with your SOL address\n\n3 winners in 24h. Building the dev payment layer on Solana\n\nsnipelink.com`;
    },
  },
  {
    name: 'engagement_quiz',
    template: () => {
      const amount = randomAmount();
      const questions = [
        'What do you use to accept payments for your projects?',
        'What Solana tool would you build if you had unlimited time?',
        'What is the biggest problem with crypto payments right now?',
      ];
      const q = pick(questions);
      return `$SLK GIVEAWAY + a question\n\n${q}\n\nBest answer wins ${amount} $SLK\n\nRules:\n- Follow @snipelink\n- RT\n- Reply with your answer + SOL address\n- Tag 2 friends\n\n3 winners in 24h\n\nsnipelink.com`;
    },
  },
  {
    name: 'milestone_celebration',
    template: () => {
      const amount = randomAmount();
      return `Celebrating our growing community with a ${amount} $SLK giveaway\n\nTo enter:\n1. Follow @snipelink\n2. Like + RT\n3. Tag 2 friends\n4. Drop SOL address\n\nPicking 3 winners in 24h\n\nFree crypto payments for devs: snipelink.com`;
    },
  },
  {
    name: 'simple_drop',
    template: () => {
      const amount = randomAmount();
      return `FREE $SLK\n\nSending ${amount} $SLK to 3 random followers\n\nAll you need to do:\n- Follow + RT\n- Tag a friend\n- Drop your SOL address\n\nWinners in 24h. No catch.\n\nsnipelink.com`;
    },
  },
  {
    name: 'builder_giveaway',
    template: () => {
      const amount = randomAmount();
      return `Builders get rewarded\n\n${amount} $SLK giveaway for the Solana community\n\n1. Follow @snipelink\n2. RT + Like\n3. Tag 2 devs or builders\n4. Reply with SOL address\n\n3 winners announced in 24h\n\nBuilding crypto payment infra at snipelink.com`;
    },
  },
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomAmount() {
  const amounts = ['1,000', '5,000', '10,000', '25,000', '50,000', '100,000'];
  return pick(amounts);
}

// ─── X/Twitter API Helpers ────────────────────────────────
async function signTwitterRequest(method, url, params = {}) {
  const { default: OAuth } = await import('oauth-1.0a');
  const { createHmac } = await import('crypto');

  const oauth = new OAuth({
    consumer: { key: process.env.X_API_KEY, secret: process.env.X_API_SECRET },
    signature_method: 'HMAC-SHA1',
    hash_function(baseString, key) {
      return createHmac('sha1', key).update(baseString).digest('base64');
    },
  });

  const token = { key: process.env.X_ACCESS_TOKEN, secret: process.env.X_ACCESS_SECRET };
  return oauth.toHeader(oauth.authorize({ url, method, data: params }, token));
}

async function postTweet(text, replyTo = null) {
  const url = 'https://api.twitter.com/2/tweets';
  const body = { text };
  if (replyTo) body.reply = { in_reply_to_tweet_id: replyTo };

  const authHeader = await signTwitterRequest('POST', url);
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function searchTweets(query, maxResults = 20) {
  const url = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=${maxResults}&tweet.fields=author_id,public_metrics,created_at`;
  const authHeader = await signTwitterRequest('GET', url);
  const res = await fetch(url, { headers: authHeader });
  return res.json();
}

async function getTweetReplies(tweetId) {
  const url = `https://api.twitter.com/2/tweets/search/recent?query=conversation_id:${tweetId}&max_results=100&tweet.fields=author_id,text`;
  const authHeader = await signTwitterRequest('GET', url);
  const res = await fetch(url, { headers: authHeader });
  return res.json();
}

// ─── SOL Address Extraction ──────────────────────────────
function extractSolAddress(text) {
  // Solana addresses are base58, 32-44 chars
  const match = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  return match ? match[0] : null;
}

// ─── Run Giveaway Post ───────────────────────────────────
async function postGiveaway() {
  if (!process.env.X_API_KEY || !process.env.X_ACCESS_TOKEN) {
    return { error: 'X credentials not set' };
  }

  // Check if we already have an active giveaway
  const active = db.prepare("SELECT * FROM giveaways WHERE status = 'active' AND ends_at > datetime('now')").get();
  if (active) {
    return { status: 'active_giveaway_exists', tweet_id: active.tweet_id };
  }

  // Check daily limit — max 2 giveaways per day
  const todayCount = db.prepare("SELECT COUNT(*) as c FROM giveaways WHERE created_at > datetime('now', '-1 day')").get().c;
  if (todayCount >= 2) {
    return { status: 'daily_limit', count: todayCount };
  }

  // Pick random format
  const format = pick(GIVEAWAY_FORMATS);
  const tweetText = format.template();

  try {
    const result = await postTweet(tweetText);
    if (!result.data?.id) {
      return { error: 'Tweet failed', details: result };
    }

    const id = randomUUID();
    const endsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h from now

    db.prepare(
      'INSERT INTO giveaways (id, tweet_id, format, amount, status, ends_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, result.data.id, format.name, tweetText.match(/[\d,]+\s*\$SLK/)?.[0] || 'variable', 'active', endsAt);

    console.log(`[Giveaway] Posted: ${format.name} — tweet ${result.data.id}`);
    trackSpend('giveaway-slk', 0.60); // Track token cost

    return { status: 'posted', tweet_id: result.data.id, format: format.name };
  } catch (e) {
    return { error: e.message };
  }
}

// ─── Collect Entries from Replies ─────────────────────────
async function collectEntries() {
  const active = db.prepare("SELECT * FROM giveaways WHERE status = 'active'").all();
  let totalEntries = 0;

  for (const giveaway of active) {
    try {
      const replies = await getTweetReplies(giveaway.tweet_id);
      if (!replies.data) continue;

      for (const reply of replies.data) {
        const solAddress = extractSolAddress(reply.text);
        if (!solAddress) continue;

        // Check if already entered
        const existing = db.prepare(
          'SELECT id FROM giveaway_entries WHERE giveaway_id = ? AND sol_address = ?'
        ).get(giveaway.id, solAddress);
        if (existing) continue;

        db.prepare(
          'INSERT INTO giveaway_entries (giveaway_id, tweet_id, username, sol_address) VALUES (?, ?, ?, ?)'
        ).run(giveaway.id, reply.id, reply.author_id, solAddress);

        totalEntries++;
      }

      // Update entry count
      const count = db.prepare('SELECT COUNT(*) as c FROM giveaway_entries WHERE giveaway_id = ?').get(giveaway.id).c;
      db.prepare('UPDATE giveaways SET entries = ? WHERE id = ?').run(count, giveaway.id);

    } catch (e) {
      console.log(`[Giveaway] Entry collection failed for ${giveaway.tweet_id}:`, e.message?.slice(0, 100));
    }
  }

  return totalEntries;
}

// ─── Close Expired Giveaways ─────────────────────────────
async function closeExpiredGiveaways() {
  const expired = db.prepare("SELECT * FROM giveaways WHERE status = 'active' AND ends_at <= datetime('now')").all();
  const results = [];

  for (const giveaway of expired) {
    const entries = db.prepare('SELECT * FROM giveaway_entries WHERE giveaway_id = ?').all(giveaway.id);

    if (entries.length === 0) {
      db.prepare("UPDATE giveaways SET status = 'closed_no_entries' WHERE id = ?").run(giveaway.id);
      results.push({ id: giveaway.id, status: 'no_entries' });
      continue;
    }

    // Pick 3 random winners (cost is ~$0.60 for 3 winners = great ROI)
    const winnerCount = Math.min(entries.length, 3);
    const shuffled = entries.sort(() => Math.random() - 0.5);
    const winners = shuffled.slice(0, winnerCount);

    const winnerAddresses = winners.map(w => w.sol_address);
    db.prepare("UPDATE giveaways SET status = 'pending_send', winner_address = ? WHERE id = ?")
      .run(JSON.stringify(winnerAddresses), giveaway.id);

    // Post winner announcement on X (truncated addresses for public tweet)
    const winnerText = `$SLK Giveaway — ${winners.length} WINNERS!\n\n${winners.map(w => w.sol_address.slice(0, 6) + '...' + w.sol_address.slice(-4)).join('\n')}\n\nTokens will be sent manually. Follow @snipelink for the next one\n\nsnipelink.com`;

    try {
      await postTweet(winnerText, giveaway.tweet_id);
    } catch (e) {
      console.log('[Giveaway] Winner announcement failed:', e.message?.slice(0, 100));
    }

    // Log FULL addresses to console so you can send manually
    console.log(`\n[Giveaway] ====== WINNERS — SEND TOKENS MANUALLY ======`);
    console.log(`[Giveaway] Giveaway ID: ${giveaway.id}`);
    console.log(`[Giveaway] Tweet: https://x.com/snipelink/status/${giveaway.tweet_id}`);
    console.log(`[Giveaway] Total entries: ${entries.length}`);
    for (let i = 0; i < winners.length; i++) {
      console.log(`[Giveaway] Winner ${i + 1}: ${winners[i].sol_address}`);
    }
    console.log(`[Giveaway] ============================================\n`);

    results.push({
      id: giveaway.id,
      entries: entries.length,
      winners: winnerAddresses,
    });

    console.log(`[Giveaway] Closed ${giveaway.id}: ${entries.length} entries, ${winners.length} winners — CHECK LOGS FOR FULL ADDRESSES`);
  }

  return results;
}

// ─── Engagement Reply Bot ─────────────────────────────────
// Reply to trending crypto/solana tweets with subtle $SLK mentions
async function engageTrendingCrypto() {
  if (!process.env.X_API_KEY) return 0;

  // Quality-filtered queries — block spam/scam/NSFW
  const BLOCK = '-pig -pigs -findom -finsub -cashslave -paypig -slave -tribute -goddess -mistress -domme -nsfw -porn -xxx -onlyfans -scam -rug -honeypot';
  const queries = [
    `"solana airdrop" developer -is:retweet lang:en ${BLOCK}`,
    `"solana ecosystem" building -is:retweet lang:en ${BLOCK}`,
    `"solana token" launch developer -is:retweet lang:en ${BLOCK}`,
    `$SOL developer tools -is:retweet lang:en ${BLOCK}`,
    `"crypto community" solana builder -is:retweet lang:en ${BLOCK}`,
    `"solana project" building -is:retweet lang:en ${BLOCK}`,
  ];

  const query = pick(queries);
  let engaged = 0;

  try {
    const tweets = await searchTweets(query, 10);
    if (!tweets.data) return 0;

    // Extra safety filter
    const BLOCK_REGEX = /pay\s*pig|findom|finsub|cash\s*slave|tribute|goddess|mistress|nsfw|porn|onlyfans|rug\s*pull|honeypot|send\s*me\s*money/i;

    // Like relevant tweets (replies are blocked by X for small accounts)
    const targets = tweets.data
      .filter(t => (t.public_metrics?.like_count > 3) && !BLOCK_REGEX.test(t.text))
      .slice(0, 5);

    const userId = process.env.X_ACCESS_TOKEN.split('-')[0];
    for (const tw of targets) {
      try {
        const likeUrl = `https://api.twitter.com/2/users/${userId}/likes`;
        const likeAuth = await signTwitterRequest('POST', likeUrl);
        await fetch(likeUrl, {
          method: 'POST',
          headers: { ...likeAuth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tweet_id: tw.id }),
        });
        engaged++;
        await new Promise(r => setTimeout(r, 1000));
      } catch (e) {}
    }

    // Retweet only if 20+ likes (higher bar = less chance of trash)
    const top = targets[0];
    if (top && (top.public_metrics?.like_count || 0) > 20) {
      try {
        console.log(`[Giveaway] RT candidate: "${top.text?.slice(0, 80)}..." (${top.public_metrics?.like_count} likes)`);
        const rtUrl = `https://api.twitter.com/2/users/${userId}/retweets`;
        const rtAuth = await signTwitterRequest('POST', rtUrl);
        await fetch(rtUrl, {
          method: 'POST',
          headers: { ...rtAuth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tweet_id: top.id }),
        });
        engaged++;
      } catch (e) {}
    }
  } catch (e) {
    console.log('[Giveaway] Trending engagement failed:', e.message?.slice(0, 100));
  }

  return engaged;
}

// ─── Main Runner ──────────────────────────────────────────
export async function runGiveawayAgent() {
  const result = { giveaway: null, entries: 0, closed: [], engaged: 0, errors: [] };

  try {
    // 1. Close any expired giveaways and announce winners
    result.closed = await closeExpiredGiveaways();
  } catch (e) { result.errors.push(`Close: ${e.message}`); }

  try {
    // 2. Collect entries from active giveaways
    result.entries = await collectEntries();
  } catch (e) { result.errors.push(`Entries: ${e.message}`); }

  try {
    // 3. Post new giveaway if none active
    result.giveaway = await postGiveaway();
  } catch (e) { result.errors.push(`Post: ${e.message}`); }

  try {
    // 4. Engage with trending crypto tweets
    result.engaged = await engageTrendingCrypto();
  } catch (e) { result.errors.push(`Engage: ${e.message}`); }

  console.log(`[Giveaway] Done — posted: ${result.giveaway?.status || 'none'}, entries: ${result.entries}, closed: ${result.closed.length}, engaged: ${result.engaged}`);
  return result;
}

// ─── Stats ────────────────────────────────────────────────
export function getGiveawayStats() {
  const total = db.prepare('SELECT COUNT(*) as c FROM giveaways').get().c;
  const active = db.prepare("SELECT COUNT(*) as c FROM giveaways WHERE status = 'active'").get().c;
  const totalEntries = db.prepare('SELECT SUM(entries) as s FROM giveaways').get().s || 0;
  const recent = db.prepare('SELECT * FROM giveaways ORDER BY created_at DESC LIMIT 5').all();
  return { total, active, totalEntries, recent };
}

// ─── Pending Winners (full addresses for manual sending) ──
export function getPendingWinners() {
  const pending = db.prepare("SELECT * FROM giveaways WHERE status = 'pending_send' ORDER BY created_at DESC").all();
  return pending.map(g => ({
    id: g.id,
    tweet_id: g.tweet_id,
    tweet_url: `https://x.com/snipelink/status/${g.tweet_id}`,
    amount: g.amount,
    entries: g.entries,
    winners: JSON.parse(g.winner_address || '[]'),
    created_at: g.created_at,
    ends_at: g.ends_at,
  }));
}

// ─── Mark giveaway as sent after you send tokens ──────────
export function markGiveawaySent(giveawayId) {
  db.prepare("UPDATE giveaways SET status = 'sent' WHERE id = ?").run(giveawayId);
}

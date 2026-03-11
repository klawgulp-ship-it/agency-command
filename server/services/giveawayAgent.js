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
    name: 'classic_drop',
    template: () => {
      const amount = randomAmount();
      const cta = pick(CTA_PHRASES);
      const urgency = pick(URGENCY_PHRASES);
      return `$SLK GIVEAWAY\n\nSending ${amount} $SLK to everyone who:\n\n1. Follow @snipelink\n2. RT this tweet\n3. ${cta}\n\n${urgency}\n\nsnipelink.com`;
    },
  },
  {
    name: 'airdrop_hype',
    template: () => {
      const amount = randomAmount();
      return `FREE $SLK AIRDROP\n\n${amount} $SLK dropping to random wallets\n\nHow to claim:\n- Follow + RT\n- Drop your SOL address\n- Tag 2 friends\n\nFirst 500 entries only\n\nsnipelink.com`;
    },
  },
  {
    name: 'mystery_amount',
    template: () => {
      return `I'm sending $SLK to EVERY person who replies\n\nNo catch. No strings.\n\nJust drop your SOL address and RT\n\nWhy? Because $SLK is about to go crazy and I want you in early\n\nsnipelink.com`;
    },
  },
  {
    name: 'engagement_bait',
    template: () => {
      const amount = randomAmount();
      return `MASSIVE $SLK GIVEAWAY\n\nGiving away ${amount} $SLK RIGHT NOW\n\nRules:\n1. Like + RT (I'm checking)\n2. Follow @snipelink\n3. Reply with SOL address\n\nPicking winners in 24h\n\nsnipelink.com`;
    },
  },
  {
    name: 'fomo_trigger',
    template: () => {
      const amount = randomAmount();
      return `Last time I did this, people made 10x\n\nSending ${amount} $SLK FREE\n\nAll you have to do:\n- RT this\n- Drop SOL address\n- Follow\n\nNot gonna last. $SLK is just getting started\n\nsnipelink.com`;
    },
  },
  {
    name: 'question_hook',
    template: () => {
      return `Want free crypto?\n\nI'm airdropping $SLK to my followers\n\nJust:\n1. Follow @snipelink\n2. RT\n3. Drop your SOL address below\n\nThat's literally it. Free $SLK sent to your wallet\n\nsnipelink.com`;
    },
  },
  {
    name: 'thread_giveaway',
    template: () => {
      const amount = randomAmount();
      return `$SLK is the next 100x Solana token\n\nAnd I'm giving away ${amount} $SLK to prove it\n\nDrop your SOL address + RT\n\nI'll send tokens within 24h. No cap.\n\nsnipelink.com`;
    },
  },
  {
    name: 'community_build',
    template: () => {
      return `Building the $SLK community one wallet at a time\n\nFREE tokens for anyone who:\n\n- Follows @snipelink\n- RTs this\n- Drops their SOL address\n\nWe're early. This is how you get in before everyone else\n\nsnipelink.com`;
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

    // Pick random winner(s) — up to 10
    const winnerCount = Math.min(entries.length, 10);
    const shuffled = entries.sort(() => Math.random() - 0.5);
    const winners = shuffled.slice(0, winnerCount);

    const winnerAddresses = winners.map(w => w.sol_address);
    db.prepare("UPDATE giveaways SET status = 'closed', winner_address = ? WHERE id = ?")
      .run(JSON.stringify(winnerAddresses), giveaway.id);

    // Post winner announcement
    const winnerText = winners.length === 1
      ? `$SLK Giveaway Winner!\n\nCongrats! Tokens being sent to:\n${winners[0].sol_address.slice(0, 8)}...${winners[0].sol_address.slice(-4)}\n\nFollow @snipelink for the next drop\n\nsnipelink.com`
      : `$SLK Giveaway — ${winners.length} WINNERS!\n\n${winners.map(w => w.sol_address.slice(0, 6) + '...' + w.sol_address.slice(-4)).join('\n')}\n\nTokens incoming. Follow @snipelink for the next one\n\nsnipelink.com`;

    try {
      await postTweet(winnerText, giveaway.tweet_id);
    } catch (e) {
      console.log('[Giveaway] Winner announcement failed:', e.message?.slice(0, 100));
    }

    results.push({
      id: giveaway.id,
      entries: entries.length,
      winners: winnerAddresses,
    });

    console.log(`[Giveaway] Closed ${giveaway.id}: ${entries.length} entries, ${winners.length} winners`);
  }

  return results;
}

// ─── Engagement Reply Bot ─────────────────────────────────
// Reply to trending crypto/solana tweets with subtle $SLK mentions
async function engageTrendingCrypto() {
  if (!process.env.X_API_KEY) return 0;

  const queries = [
    'solana airdrop',
    'free crypto giveaway',
    'SOL giveaway',
    'solana token launch',
    '$SOL free',
    'crypto community',
    'solana ecosystem',
    'meme coin solana',
  ];

  const query = pick(queries);
  let engaged = 0;

  try {
    const tweets = await searchTweets(query, 10);
    if (!tweets.data) return 0;

    // Reply to 2-3 relevant tweets
    const targets = tweets.data
      .filter(t => t.public_metrics?.like_count > 5) // Only engage with active tweets
      .slice(0, 2);

    const replies = [
      'Check out $SLK on Solana — doing giveaways every day. Follow @snipelink',
      '$SLK is doing daily airdrops. Just drop your SOL address on our latest post @snipelink',
      'If you like free tokens check @snipelink — $SLK giveaways running now',
      'Following. Also check out $SLK — running giveaways for the Solana community @snipelink',
    ];

    for (const tweet of targets) {
      try {
        await postTweet(pick(replies), tweet.id);
        engaged++;
        await new Promise(r => setTimeout(r, 5000)); // Rate limit
      } catch (e) {
        console.log('[Giveaway] Engagement reply failed:', e.message?.slice(0, 100));
      }
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

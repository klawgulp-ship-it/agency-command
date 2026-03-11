import db from '../db/connection.js';
import { notify } from './notifications.js';
import { randomUUID } from 'crypto';

// ─── Constants ────────────────────────────────────────────
const SNIPELINK_URL = 'https://snipelink.com';
const TOOLS_URL = 'https://scintillating-gratitude-production.up.railway.app/tools';
const NPM_PACKAGES = ['snipelink-review', 'snipelink-ts', 'snipelink-readme'];
const MAX_POSTS_PER_PLATFORM = 3;

// ─── DB Setup ─────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS social_posts (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    action_type TEXT NOT NULL,
    target TEXT DEFAULT '',
    content TEXT DEFAULT '',
    status TEXT DEFAULT 'posted',
    engagement INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Claude Helper (Haiku — $0.001/call) ──────────────────
async function askClaude(prompt, maxTokens = 400) {
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
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Claude API ${res.status}`);
  return data.content?.[0]?.text ?? '';
}

function trackPost(platform, actionType, target, content, status = 'posted') {
  try {
    db.prepare(`INSERT INTO social_posts (id, platform, action_type, target, content, status) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), platform, actionType, target, content.slice(0, 500), status);
  } catch (e) { /* ignore duplicate */ }
}

function getPostCountToday(platform) {
  const row = db.prepare(`SELECT COUNT(*) as c FROM social_posts WHERE platform = ? AND created_at > datetime('now', '-1 day') AND status = 'posted'`).get(platform);
  return row?.c || 0;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Content Topics ────────────────────────────────────────
const TOPICS = [
  'crypto payment links for developers',
  'accept SOL and USDC payments on your website',
  'free npm tools for code review and TypeScript analysis',
  'embeddable payment badges for GitHub READMEs',
  'building payment infrastructure for Solana ecosystem',
  'open source bounty payments with crypto',
  'developer tools that actually save time',
  'why crypto payments are better for freelancers',
  'self-hosted payment links vs Stripe',
  'Solana payment integration for web apps',
  'automated code review with AI',
  'TypeScript migration tools for legacy codebases',
];

// ═══════════════════════════════════════════════════════════
// REDDIT — r/solana, r/cryptocurrency, r/webdev, r/node
// ═══════════════════════════════════════════════════════════

async function getRedditToken() {
  const { REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD } = process.env;
  if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET) return null;

  const auth = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'SnipeLinkBot/1.0',
    },
    body: `grant_type=password&username=${REDDIT_USERNAME}&password=${REDDIT_PASSWORD}`,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  return data.access_token || null;
}

async function redditApi(token, path, options = {}) {
  return fetch(`https://oauth.reddit.com${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'SnipeLinkBot/1.0',
      'Content-Type': 'application/x-www-form-urlencoded',
      ...options.headers,
    },
    signal: AbortSignal.timeout(15000),
  }).then(r => r.json());
}

const SUBREDDITS = [
  { name: 'solana', topics: ['crypto payments', 'Solana ecosystem', 'USDC payments', 'bounty payments'] },
  { name: 'cryptocurrency', topics: ['crypto payment tools', 'accept crypto on website', 'freelancer crypto payments'] },
  { name: 'webdev', topics: ['payment integration', 'npm tools', 'code review tools', 'developer tools'] },
  { name: 'node', topics: ['npm packages', 'TypeScript tools', 'Node.js code review'] },
  { name: 'javascript', topics: ['TypeScript migration', 'code analysis', 'npm packages'] },
  { name: 'SolanaDev', topics: ['payment infrastructure', 'SOL payment links', 'Solana web3'] },
];

async function runReddit() {
  const results = { comments: 0, posts: 0, errors: [] };
  const token = await getRedditToken();
  if (!token) { results.errors.push('No Reddit credentials'); return results; }

  const todayCount = getPostCountToday('reddit');
  if (todayCount >= 6) { results.errors.push('Daily limit reached'); return results; }

  for (const sub of SUBREDDITS.slice(0, 3)) {
    try {
      // Find recent posts matching our topics
      const topic = sub.topics[Math.floor(Math.random() * sub.topics.length)];
      const data = await redditApi(token, `/r/${sub.name}/search?q=${encodeURIComponent(topic)}&sort=new&t=day&limit=5&restrict_sr=true`);

      const posts = data?.data?.children || [];
      if (posts.length === 0) continue;

      // Pick a post to comment on
      const post = posts[Math.floor(Math.random() * Math.min(posts.length, 3))];
      const postTitle = post.data.title;
      const postBody = (post.data.selftext || '').slice(0, 300);

      // Generate helpful comment with subtle tool mention
      const comment = await askClaude(`You're a helpful developer in r/${sub.name}. Write a short, genuinely helpful Reddit comment (2-4 sentences) replying to this post:

Title: ${postTitle}
${postBody ? `Body: ${postBody}` : ''}

Be helpful first. If naturally relevant, mention one of these tools (don't force it):
- snipelink.com — free payment links that accept SOL/USDC + PayPal
- npm packages: snipelink-review (AI code review), snipelink-ts (TS migration), snipelink-readme (README generator)

Rules:
- Sound like a real developer, not marketing
- Don't start with "Great question!" or similar
- Be concise and valuable
- Only mention a tool if it's genuinely relevant to the post
- No emojis`);

      if (!comment || comment.length < 20) continue;

      // Post comment
      const commentRes = await redditApi(token, '/api/comment', {
        method: 'POST',
        body: `thing_id=${post.data.name}&text=${encodeURIComponent(comment)}`,
      });

      if (commentRes?.json?.data) {
        results.comments++;
        trackPost('reddit', 'comment', `r/${sub.name}: ${postTitle.slice(0, 80)}`, comment);
      }

      await sleep(3000); // Reddit rate limit
    } catch (e) {
      results.errors.push(`r/${sub.name}: ${e.message}`);
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════
// DISCORD — Webhook posts to servers
// ═══════════════════════════════════════════════════════════

async function runDiscord() {
  const results = { posts: 0, errors: [] };
  const webhooks = (process.env.DISCORD_WEBHOOKS || '').split(',').filter(Boolean);
  if (webhooks.length === 0) { results.errors.push('No DISCORD_WEBHOOKS set'); return results; }

  const todayCount = getPostCountToday('discord');
  if (todayCount >= 4) { results.errors.push('Daily limit reached'); return results; }

  const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
  const content = await askClaude(`Write a short Discord message (2-3 sentences) for a dev/crypto community about: ${topic}

Include one of these if relevant:
- snipelink.com — free crypto payment links (SOL/USDC + PayPal)
- npm i snipelink-review — AI code review CLI tool
- GitHub badge: snipelink.com/api/embed/badge/@username/slug

Rules:
- Sound casual and helpful, like a dev sharing something cool
- No marketing speak
- Keep it under 280 chars if possible
- No emojis unless natural`);

  if (!content || content.length < 20) return results;

  for (const webhook of webhooks.slice(0, MAX_POSTS_PER_PLATFORM)) {
    try {
      const res = await fetch(webhook.trim(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'SnipeLink',
          content,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok || res.status === 204) {
        results.posts++;
        trackPost('discord', 'message', webhook.slice(0, 60), content);
      }
      await sleep(1000);
    } catch (e) {
      results.errors.push(`Discord webhook: ${e.message}`);
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════
// TELEGRAM — Bot API for channels/groups
// ═══════════════════════════════════════════════════════════

async function telegramApi(method, params = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  });
  return res.json();
}

async function runTelegram() {
  const results = { messages: 0, errors: [] };
  if (!process.env.TELEGRAM_BOT_TOKEN) { results.errors.push('No TELEGRAM_BOT_TOKEN'); return results; }

  const channels = (process.env.TELEGRAM_CHANNELS || '').split(',').filter(Boolean);
  if (channels.length === 0) { results.errors.push('No TELEGRAM_CHANNELS set'); return results; }

  const todayCount = getPostCountToday('telegram');
  if (todayCount >= 4) { results.errors.push('Daily limit reached'); return results; }

  const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
  const message = await askClaude(`Write a short Telegram message (3-5 sentences) for a crypto/dev channel about: ${topic}

Include these naturally:
- snipelink.com — free payment links for SOL/USDC + PayPal
- Embeddable badges for GitHub repos
- npm tools: snipelink-review, snipelink-ts, snipelink-readme

Rules:
- Telegram-style: concise, informative, slightly casual
- Can use minimal markdown (bold with *, links with []())
- Focus on value, not hype
- Keep under 500 chars`);

  if (!message || message.length < 20) return results;

  for (const chatId of channels.slice(0, MAX_POSTS_PER_PLATFORM)) {
    try {
      const res = await telegramApi('sendMessage', {
        chat_id: chatId.trim(),
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
      });
      if (res.ok) {
        results.messages++;
        trackPost('telegram', 'message', `chat:${chatId.trim()}`, message);
      } else {
        results.errors.push(`Telegram ${chatId}: ${res.description || 'failed'}`);
      }
      await sleep(1000);
    } catch (e) {
      results.errors.push(`Telegram: ${e.message}`);
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════
// BLUESKY — AT Protocol (free, growing dev community)
// ═══════════════════════════════════════════════════════════

async function getBlueskySession() {
  const { BLUESKY_HANDLE, BLUESKY_APP_PASSWORD } = process.env;
  if (!BLUESKY_HANDLE || !BLUESKY_APP_PASSWORD) return null;

  const res = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: BLUESKY_HANDLE, password: BLUESKY_APP_PASSWORD }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  return res.json();
}

async function runBluesky() {
  const results = { posts: 0, errors: [] };
  const session = await getBlueskySession();
  if (!session) { results.errors.push('No Bluesky credentials'); return results; }

  const todayCount = getPostCountToday('bluesky');
  if (todayCount >= 4) { results.errors.push('Daily limit reached'); return results; }

  const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
  const post = await askClaude(`Write a short Bluesky post (under 300 chars) for the dev community about: ${topic}

Mention snipelink.com if relevant — free crypto payment links for developers.
Rules:
- Sound like a real dev, not a brand
- Concise, one thought
- No hashtags (Bluesky doesn't use them much)
- No emojis unless natural`);

  if (!post || post.length < 10 || post.length > 300) return results;

  try {
    // Detect URLs in post and create facets for them
    const facets = [];
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    let match;
    const encoder = new TextEncoder();
    while ((match = urlRegex.exec(post)) !== null) {
      const beforeUrl = post.slice(0, match.index);
      const byteStart = encoder.encode(beforeUrl).length;
      const byteEnd = byteStart + encoder.encode(match[0]).length;
      facets.push({
        index: { byteStart, byteEnd },
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: match[0] }],
      });
    }

    const res = await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.accessJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        repo: session.did,
        collection: 'app.bsky.feed.post',
        record: {
          $type: 'app.bsky.feed.post',
          text: post,
          facets: facets.length > 0 ? facets : undefined,
          createdAt: new Date().toISOString(),
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      results.posts++;
      trackPost('bluesky', 'post', 'feed', post);
    } else {
      const err = await res.json().catch(() => ({}));
      results.errors.push(`Bluesky post: ${err.message || res.status}`);
    }
  } catch (e) {
    results.errors.push(`Bluesky: ${e.message}`);
  }

  return results;
}

// ═══════════════════════════════════════════════════════════
// NOSTR — Decentralized protocol (crypto community, zero signup)
// ═══════════════════════════════════════════════════════════

async function runNostr() {
  const results = { posts: 0, errors: [] };
  const skHex = process.env.NOSTR_PRIVATE_KEY;
  if (!skHex) { results.errors.push('No NOSTR_PRIVATE_KEY'); return results; }

  const todayCount = getPostCountToday('nostr');
  if (todayCount >= 6) { results.errors.push('Daily limit reached'); return results; }

  try {
    const { getPublicKey, finalizeEvent } = await import('nostr-tools/pure');
    const WebSocket = (await import('ws')).default;

    const sk = Uint8Array.from(skHex.match(/.{2}/g).map(b => parseInt(b, 16)));
    const pk = getPublicKey(sk);

    const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
    const content = await askClaude(`Write a short Nostr post (under 280 chars) for the crypto/dev community about: ${topic}

Mention snipelink.com if relevant — free payment links for SOL/USDC/PayPal.
Rules:
- Sound like a real person in crypto, not a brand
- Nostr is like Twitter — short, punchy, opinionated
- No hashtags in text (use tags instead)
- No emojis unless natural
- One clear thought`);

    if (!content || content.length < 10) return results;

    const event = finalizeEvent({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['t', 'solana'], ['t', 'crypto'], ['t', 'devtools']],
      content,
    }, sk);

    const relays = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social', 'wss://relay.nostr.band'];

    const publishPromises = relays.map(url => new Promise((resolve) => {
      try {
        const ws = new WebSocket(url);
        const timeout = setTimeout(() => { try { ws.close(); } catch (e) {} resolve(false); }, 6000);
        ws.on('open', () => {
          ws.send(JSON.stringify(['EVENT', event]));
          setTimeout(() => {
            clearTimeout(timeout);
            try { ws.close(); } catch (e) {}
            resolve(true);
          }, 1500);
        });
        ws.on('error', () => { clearTimeout(timeout); resolve(false); });
      } catch (e) { resolve(false); }
    }));

    const published = (await Promise.all(publishPromises)).filter(Boolean).length;
    if (published > 0) {
      results.posts++;
      trackPost('nostr', 'post', `${published} relays`, content);
    }
  } catch (e) {
    results.errors.push(`Nostr: ${e.message}`);
  }

  return results;
}

// ═══════════════════════════════════════════════════════════
// MASTODON — Fediverse (dev/OSS community)
// ═══════════════════════════════════════════════════════════

async function runMastodon() {
  const results = { posts: 0, errors: [] };
  const token = process.env.MASTODON_ACCESS_TOKEN;
  const instance = process.env.MASTODON_INSTANCE || 'mastodon.social';
  if (!token) { results.errors.push('No MASTODON_ACCESS_TOKEN'); return results; }

  const todayCount = getPostCountToday('mastodon');
  if (todayCount >= 4) { results.errors.push('Daily limit reached'); return results; }

  const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
  const status = await askClaude(`Write a short Mastodon post (under 500 chars) for the dev/OSS community about: ${topic}

Mention snipelink.com if relevant — free payment links for developers.
Rules:
- Mastodon is like a chill dev community
- Can use hashtags: #Solana #WebDev #OpenSource #DevTools
- Sound helpful and genuine
- One clear thought with a link`);

  if (!status || status.length < 10) return results;

  try {
    const res = await fetch(`https://${instance}/api/v1/statuses`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status, visibility: 'public' }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      results.posts++;
      trackPost('mastodon', 'post', instance, status);
    } else {
      const err = await res.json().catch(() => ({}));
      results.errors.push(`Mastodon: ${err.error || res.status}`);
    }
  } catch (e) {
    results.errors.push(`Mastodon: ${e.message}`);
  }

  return results;
}

// ═══════════════════════════════════════════════════════════
// MAIN — Run all platforms in parallel
// ═══════════════════════════════════════════════════════════

export async function runSocialAgent() {
  console.log('[SOCIAL] Starting multi-platform social agent...');
  const startTime = Date.now();

  const [reddit, discord, telegram, bluesky, nostr, mastodon] = await Promise.allSettled([
    runReddit(),
    runDiscord(),
    runTelegram(),
    runBluesky(),
    runNostr(),
    runMastodon(),
  ]);

  const settled = { reddit, discord, telegram, bluesky, nostr, mastodon };
  const results = { duration: Date.now() - startTime };
  for (const [k, v] of Object.entries(settled)) {
    results[k] = v.status === 'fulfilled' ? v.value : { errors: [v.reason?.message] };
  }

  const totalActions = (results.reddit.comments || 0) + (results.reddit.posts || 0) +
    (results.discord.posts || 0) + (results.telegram.messages || 0) +
    (results.bluesky.posts || 0) + (results.nostr.posts || 0) + (results.mastodon.posts || 0);

  console.log(`[SOCIAL] Done in ${results.duration}ms: ${totalActions} actions`);
  console.log(`[SOCIAL] Reddit: ${results.reddit.comments || 0} | Discord: ${results.discord.posts || 0} | Telegram: ${results.telegram.messages || 0} | Bluesky: ${results.bluesky.posts || 0} | Nostr: ${results.nostr.posts || 0} | Mastodon: ${results.mastodon.posts || 0}`);

  if (totalActions > 0) {
    notify('social', `Social agent: ${totalActions} posts across platforms`, JSON.stringify(results));
  }

  return results;
}

// ─── Stats Export ─────────────────────────────────────────
export function getSocialStats() {
  const today = db.prepare(`SELECT platform, COUNT(*) as count FROM social_posts WHERE created_at > datetime('now', '-1 day') GROUP BY platform`).all();
  const total = db.prepare(`SELECT platform, COUNT(*) as count FROM social_posts GROUP BY platform`).all();
  return { today, total };
}

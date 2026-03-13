import db from '../db/connection.js';
import { notify } from './notifications.js';
import { trackSpend } from './analyticsTracker.js';
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  // Count only actual content posts since midnight UTC — NOT engagement actions
  const row = db.prepare(`SELECT COUNT(*) as c FROM social_posts WHERE platform = ? AND created_at > date('now') AND status = 'posted' AND action_type NOT IN ('engagement', 'like', 'follow', 'retweet')`).get(platform);
  return row?.c || 0;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Content Queue (saves API credits) ────────────────────
function getQueuedContent(platform) {
  try {
    const queuePath = join(__dirname, '../data/content-queue.json');
    const queue = JSON.parse(readFileSync(queuePath, 'utf8'));
    const items = queue[platform] || [];
    if (items.length === 0) return null;
    // Pop first item and save
    const item = items.shift();
    queue[platform] = items;
    writeFileSync(queuePath, JSON.stringify(queue, null, 2));
    return item;
  } catch (e) { return null; }
}

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
- No emojis
- If linking to snipelink.com, append ?utm_source=reddit&utm_medium=social to the URL`);

      if (comment) trackSpend('social-agent-haiku', 0.001);
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
- No emojis unless natural
- If linking to snipelink.com, append ?utm_source=discord&utm_medium=social to the URL`);

  if (content) trackSpend('social-agent-haiku', 0.001);
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
- Keep under 500 chars
- If linking to snipelink.com, append ?utm_source=telegram&utm_medium=social to the URL`);

  trackSpend('social-agent-haiku', 0.001);
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
- No emojis unless natural
- If linking to snipelink.com, append ?utm_source=bluesky&utm_medium=social to the URL`);

  if (post) trackSpend('social-agent-haiku', 0.001);
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

    // Try queued content first (free), fall back to Claude ($0.001)
    const queued = getQueuedContent('nostr');
    let content, postTags;
    if (queued) {
      content = queued.content;
      postTags = (queued.tags || []).map(t => ['t', t]);
    } else {
      const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
      content = await askClaude(`Write a short Nostr post (under 280 chars) for the crypto/dev community about: ${topic}

Mention snipelink.com if relevant — free payment links for SOL/USDC/PayPal.
Rules:
- Sound like a real person in crypto, not a brand
- Nostr is like Twitter — short, punchy, opinionated
- No hashtags in text (use tags instead)
- No emojis unless natural
- One clear thought
- If linking to snipelink.com, append ?utm_source=nostr&utm_medium=social to the URL`);
      trackSpend('social-agent-haiku', 0.001);
      postTags = [['t', 'solana'], ['t', 'crypto'], ['t', 'devtools']];
    }

    if (!content || content.length < 10) return results;

    const event = finalizeEvent({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: postTags || [['t', 'solana'], ['t', 'crypto'], ['t', 'devtools']],
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

  // Try queued content first (free), fall back to Claude
  const queued = getQueuedContent('mastodon');
  let status;
  if (queued) {
    status = queued.content;
  } else {
    const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
    status = await askClaude(`Write a short Mastodon post (under 500 chars) for the dev/OSS community about: ${topic}

Mention snipelink.com if relevant — free payment links for developers.
Rules:
- Mastodon is like a chill dev community
- Can use hashtags: #Solana #WebDev #OpenSource #DevTools
- Sound helpful and genuine
- One clear thought with a link
- If linking to snipelink.com, append ?utm_source=mastodon&utm_medium=social to the URL`);
    trackSpend('social-agent-haiku', 0.001);
  }

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
// X (TWITTER) — Biggest reach platform
// ═══════════════════════════════════════════════════════════

async function signTwitterRequest(method, url, params = {}) {
  const OAuth = (await import('oauth-1.0a')).default;
  const { createHmac } = await import('crypto');

  const oauth = new OAuth({
    consumer: { key: process.env.X_API_KEY, secret: process.env.X_API_SECRET },
    signature_method: 'HMAC-SHA1',
    hash_function(baseString, key) {
      return createHmac('sha1', key).update(baseString).digest('base64');
    },
  });

  const token = { key: process.env.X_ACCESS_TOKEN, secret: process.env.X_ACCESS_SECRET };
  const authHeader = oauth.toHeader(oauth.authorize({ url, method, data: params }, token));
  return authHeader;
}

async function postTweet(text, replyTo = null) {
  const url = 'https://api.twitter.com/2/tweets';
  const authHeader = await signTwitterRequest('POST', url);
  const body = { text };
  if (replyTo) body.reply = { in_reply_to_tweet_id: replyTo };

  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  return res.json();
}

async function searchTweets(query, maxResults = 10) {
  const searchUrl = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=${maxResults}&tweet.fields=public_metrics,author_id,conversation_id&expansions=author_id`;
  const authHeader = await signTwitterRequest('GET', searchUrl);
  const res = await fetch(searchUrl, { headers: { ...authHeader }, signal: AbortSignal.timeout(10000) });
  return res.json();
}

// ─── Viral tweet styles that get engagement ────────────────
const VIRAL_FORMATS = [
  // Hot takes get quote tweets + replies
  { style: 'hot_take', prompt: `Write a controversial but defensible hot take tweet (under 280 chars) about one of these topics. Pick the spiciest angle:
- "Stripe is overengineered for 90% of devs"
- "Crypto payments will replace PayPal within 5 years"
- "Most developer tools are solutions looking for problems"
- "The best code review tool is a free CLI, not a $50/seat SaaS"
- "Solana is eating Ethereum's lunch on payments"
- "Open source devs deserve to get paid, but donation buttons don't work"
Rules: Be opinionated. Take a side. Make people want to reply and argue. Under 280 chars. No emojis. Sound like a real developer with strong opinions, NOT a brand.` },

  // Threads get saved + shared
  { style: 'thread_hook', prompt: `Write a compelling thread hook tweet (under 280 chars) that makes people want to read more. Topics:
- "I built a payment platform that accepts SOL and USDC. Here's what I learned about crypto payments:"
- "3 free npm tools that replaced paid SaaS in my workflow:"
- "Why I stopped using Stripe and built my own payment links:"
- "The economics of open source bounties — how devs actually get paid:"
Rules: End with something that makes people want to click "Show thread". Create curiosity. Under 280 chars. No emojis.` },

  // Value tweets get bookmarked
  { style: 'value_bomb', prompt: `Write a high-value tweet (under 280 chars) sharing a useful tip that developers will bookmark. Topics:
- A quick way to accept crypto payments on any website
- A free CLI command that does AI code review instantly
- How to add a payment badge to your GitHub README in 1 line
- A TypeScript migration trick using a free npm tool
Rules: Provide immediate actionable value. Include the actual command or URL. Under 280 chars. No fluff.` },

  // Engagement bait (questions)
  { style: 'question', prompt: `Write a tweet (under 280 chars) asking a genuine question that crypto/dev people will want to answer:
- "What's your biggest pain point accepting payments as a freelance dev?"
- "Do you accept crypto for freelance work? Why or why not?"
- "What's the one npm package you can't live without?"
- "Stripe vs crypto payments for indie devs — which do you prefer?"
Rules: Ask a real question. Make it easy to reply. People love sharing their opinion. Under 280 chars. No emojis.` },
];

async function runX() {
  const results = { tweets: 0, threads: 0, errors: [] };
  if (!process.env.X_API_KEY || !process.env.X_ACCESS_TOKEN) {
    console.log('[X] Skipping — no credentials');
    results.errors.push('No X/Twitter credentials');
    return results;
  }

  const todayCount = getPostCountToday('x');
  console.log(`[X] Today's tweet count: ${todayCount}/24`);
  if (todayCount >= 24) { results.errors.push('Daily limit reached'); return results; }

  // Always use queued content first — it's pre-written and clean
  const queued = getQueuedContent('x');
  let tweetText;

  if (queued) {
    tweetText = queued.content;
    console.log(`[X] Using queued content (${tweetText.length} chars)`);
  } else {
    // Queue empty — generate with Claude as fallback
    const formatIdx = todayCount % VIRAL_FORMATS.length;
    const format = VIRAL_FORMATS[formatIdx];
    console.log(`[X] Queue empty, generating with Claude (${format.style})`);
    tweetText = await askClaude(format.prompt + '\n\nIMPORTANT: Return ONLY the tweet text. No quotes, no labels, no options, no explanations. Just the raw tweet.');
    if (tweetText) {
      trackSpend('social-agent-haiku', 0.001);
      // Strip any quotes or labels Claude might add
      tweetText = tweetText.replace(/^["']|["']$/g, '').replace(/^(Tweet|Option|Here)[:\s]*/i, '').trim();
    }
    console.log(`[X] Claude generated ${tweetText?.length || 0} chars`);
  }

  if (!tweetText || tweetText.length < 10) {
    console.log(`[X] No tweet text`);
    return results;
  }

  // Truncate if over 280
  if (tweetText.length > 280) tweetText = tweetText.slice(0, 277) + '...';

  try {
    const data = await postTweet(tweetText);
    if (data.data?.id) {
      results.tweets++;
      trackPost('x', queued ? 'queued' : 'generated', `tweet:${data.data.id}`, tweetText);
      console.log(`[X] Posted tweet: ${data.data.id}`);

      // Self-reply boosts algorithmic reach — algorithm sees author engagement as quality signal
      try {
        const selfReplies = [
          'Try it free: snipelink.com',
          'Zero monthly fees. Zero middlemen. snipelink.com',
          'Accept SOL, USDC, or PayPal with one link: snipelink.com',
          'Built for developers who hate payment processor fees.',
          'No signup needed. Just create a payment link and share it.',
        ];
        const selfReply = selfReplies[Math.floor(Math.random() * selfReplies.length)];
        await sleep(3000);
        await postTweet(selfReply, data.data.id);
        console.log(`[X] Self-replied for reach boost`);
      } catch (e) { /* self-reply is optional, don't fail the run */ }
    } else {
      console.log(`[X] Post failed: ${JSON.stringify(data).slice(0, 150)}`);
      results.errors.push(`X post: ${data.detail || data.title || JSON.stringify(data).slice(0, 100)}`);
    }
  } catch (e) {
    console.log(`[X] Post error: ${e.message}`);
    results.errors.push(`X: ${e.message}`);
  }

  return results;
}

// ═══════════════════════════════════════════════════════════
// X REPLY GUY — Finds convos and drops fire replies with personality
// Runs independently on its own schedule for constant presence
// ═══════════════════════════════════════════════════════════

const BLOCK_WORDS = '-pig -pigs -findom -finsub -cashslave -paypig -slave -tribute -goddess -mistress -domme -nsfw -porn -xxx -onlyfans -scam -rug -rugged -honeypot';
const BLOCK_REGEX = /pay\s*pig|findom|finsub|cash\s*slave|tribute|goddess|mistress|domme|nsfw|porn|onlyfans|rug\s*pull|honeypot|send\s*me\s*money/i;

// Hype phrases the reply guy uses — keeps it natural by rotating
const HYPE_REPLIES = [
  '⚡ this is the way',
  'LFGG!! 🔥',
  '⚡⚡⚡',
  'this is so fire 🔥',
  'LFG!! been waiting for this',
  '⚡ building different',
  'absolute W 🔥',
  'this right here ⚡',
  'WAGMI 🔥⚡',
  'someone had to say it ⚡',
  'facts ⚡🔥',
  'the future is being built right now ⚡',
  'dev energy ⚡⚡',
  'shipping > talking. LFGG',
  '🔥🔥 love to see it',
];

// Reply guy search queries — broader than engagement to find conversations to jump into
const REPLY_GUY_QUERIES = [
  `"solana" "building" -is:retweet lang:en ${BLOCK_WORDS}`,
  `"crypto payments" -is:retweet lang:en ${BLOCK_WORDS}`,
  `"web3 developer" -is:retweet lang:en ${BLOCK_WORDS}`,
  `"freelance dev" -is:retweet lang:en ${BLOCK_WORDS}`,
  `"shipping code" -is:retweet lang:en ${BLOCK_WORDS}`,
  `"launched" "project" developer -is:retweet lang:en ${BLOCK_WORDS}`,
  `"payment link" OR "payment page" -is:retweet lang:en ${BLOCK_WORDS}`,
  `"open source" contributor -is:retweet lang:en ${BLOCK_WORDS}`,
  `"just deployed" OR "just shipped" -is:retweet lang:en ${BLOCK_WORDS}`,
  `"accept crypto" OR "crypto checkout" -is:retweet lang:en ${BLOCK_WORDS}`,
  `"indie hacker" building -is:retweet lang:en ${BLOCK_WORDS}`,
  `"solana ecosystem" -is:retweet lang:en ${BLOCK_WORDS}`,
  `"USDC" developer -is:retweet lang:en ${BLOCK_WORDS}`,
  `"stripe alternative" -is:retweet lang:en ${BLOCK_WORDS}`,
  `"devtools" OR "dev tool" launched -is:retweet lang:en ${BLOCK_WORDS}`,
  `"npm package" published -is:retweet lang:en ${BLOCK_WORDS}`,
];

export async function runXReplyGuy() {
  const results = { replies: 0, hypeReplies: 0, errors: [] };
  if (!process.env.X_API_KEY || !process.env.X_ACCESS_TOKEN) {
    results.errors.push('No X credentials');
    return results;
  }

  console.log('[X-REPLY-GUY] Hunting for conversations...');

  try {
    // Pick 2 random queries to search
    const shuffled = [...REPLY_GUY_QUERIES].sort(() => Math.random() - 0.5);
    const searchQueries = shuffled.slice(0, 2);

    for (const query of searchQueries) {
      try {
        const searchData = await searchTweets(query, 10);
        let tweets = searchData.data || [];
        console.log(`[X-REPLY-GUY] Search "${query.slice(0, 30)}..." returned ${tweets.length} tweets${searchData.errors ? ' (errors: ' + JSON.stringify(searchData.errors).slice(0, 100) + ')' : ''}`);
        tweets = tweets.filter(t => !BLOCK_REGEX.test(t.text));

        // Sort by engagement — reply to tweets people are actually reading
        tweets.sort((a, b) => (b.public_metrics?.like_count || 0) - (a.public_metrics?.like_count || 0));

        // Check we haven't already replied to these tweets
        const repliedTo = db.prepare(`SELECT target FROM social_posts WHERE platform = 'x' AND action_type IN ('reply', 'hype-reply') AND created_at > datetime('now', '-7 days')`).all().map(r => r.target);

        for (const tw of tweets.slice(0, 5)) {
          if (repliedTo.includes(`reply:${tw.id}`)) continue;

          const likes = tw.public_metrics?.like_count || 0;

          // Higher engagement tweets (3+ likes) — try Claude for thoughtful reply, fall back to hype
          if (likes >= 3) {
            try {
              const replyText = await askClaude(`Someone tweeted: "${tw.text.slice(0, 200)}"

Write a short, genuine reply (under 240 chars) that:
- Adds value or shares a real take
- Sounds like an excited developer, not a brand
- Can use ⚡ or 🔥 naturally
- If they're talking about payments/crypto/freelance, casually mention snipelink.com
- If not payment-related, just be a genuinely engaged dev
- Never start with "Great point!" or "This is so true!"
- Can say LFGG, LFG, or "building different" if it fits
- Be natural, not cringe

IMPORTANT: Return ONLY the reply text. No quotes, no labels.`);

              if (replyText && !replyText.includes('SKIP') && replyText.length > 5 && replyText.length <= 280) {
                trackSpend('social-agent-haiku', 0.001);
                const data = await postTweet(replyText, tw.id);
                if (data.data?.id) {
                  results.replies++;
                  trackPost('x', 'reply', `reply:${tw.id}`, replyText);
                  console.log(`[X-REPLY-GUY] Replied to ${tw.id} (${likes} likes): ${replyText.slice(0, 60)}...`);
                }
                await sleep(2000);
                continue;
              }
            } catch (e) {
              // Claude failed (likely credits out) — fall through to hype reply
              console.log(`[X-REPLY-GUY] Claude failed, using hype reply instead`);
            }
          }

          // Any tweet we find — drop a quick hype reply (no Claude needed, zero cost)
          try {
            const hype = HYPE_REPLIES[Math.floor(Math.random() * HYPE_REPLIES.length)];
            const data = await postTweet(hype, tw.id);
            if (data.data?.id) {
              results.hypeReplies++;
              trackPost('x', 'hype-reply', `reply:${tw.id}`, hype);
              console.log(`[X-REPLY-GUY] Hype replied to ${tw.id}: ${hype}`);
            }
            await sleep(1500);
          } catch (e) { console.log(`[X-REPLY-GUY] Hype reply failed: ${e.message?.slice(0, 80)}`); }
        }

        await sleep(2000); // Pace between searches
      } catch (e) {
        results.errors.push(`Reply search: ${e.message?.slice(0, 80)}`);
      }
    }
  } catch (e) {
    results.errors.push(`X reply guy: ${e.message}`);
  }

  console.log(`[X-REPLY-GUY] Done: ${results.replies} thoughtful + ${results.hypeReplies} hype replies`);
  return results;
}

// ═══════════════════════════════════════════════════════════
// X HYPE MAN — Replies to own tweets, mentions, boosts energy
// Keeps the thread alive and signals engagement to algorithm
// ═══════════════════════════════════════════════════════════

export async function runXHypeMan() {
  const results = { selfReplies: 0, mentionReplies: 0, errors: [] };
  if (!process.env.X_API_KEY || !process.env.X_ACCESS_TOKEN) {
    results.errors.push('No X credentials');
    return results;
  }

  const userId = process.env.X_ACCESS_TOKEN.split('-')[0];
  console.log('[X-HYPE-MAN] Boosting threads and handling mentions...');

  try {
    // 1. Find our recent tweets and add follow-up replies to keep threads alive
    const recentTweets = db.prepare(`
      SELECT target, content FROM social_posts
      WHERE platform = 'x' AND action_type IN ('queued', 'generated')
      AND created_at > datetime('now', '-12 hours')
      ORDER BY created_at DESC LIMIT 5
    `).all();

    const alreadyHyped = db.prepare(`
      SELECT target FROM social_posts
      WHERE platform = 'x' AND action_type = 'self-hype'
      AND created_at > datetime('now', '-12 hours')
    `).all().map(r => r.target);

    for (const tweet of recentTweets) {
      const tweetId = tweet.target?.replace('tweet:', '');
      if (!tweetId || alreadyHyped.includes(`hype:${tweetId}`)) continue;

      // Add a value-add follow-up to our own tweet
      const followUps = [
        '⚡ Drop your SOL address if you want to test it out',
        'Zero fees. Zero middlemen. Just payments. snipelink.com ⚡',
        'Been building this for months. Finally feels right 🔥',
        'DMs open if you want to collab ⚡',
        'More shipping this week. Stay locked in 🔥',
        'The grind never stops ⚡⚡ snipelink.com',
        'LFGG!! This is just the beginning 🔥',
        'Devs supporting devs. That\'s the whole mission ⚡',
        'If you\'re building on Solana, you need this. snipelink.com',
        'Every feature ships free. No paywalls. No BS. ⚡',
      ];
      const followUp = followUps[Math.floor(Math.random() * followUps.length)];

      try {
        const data = await postTweet(followUp, tweetId);
        if (data.data?.id) {
          results.selfReplies++;
          trackPost('x', 'self-hype', `hype:${tweetId}`, followUp);
          console.log(`[X-HYPE-MAN] Thread boost on ${tweetId}: ${followUp.slice(0, 50)}`);
        }
        await sleep(2000);
      } catch (e) {}
    }

    // 2. Check mentions and reply with energy
    try {
      const mentionsUrl = `https://api.twitter.com/2/users/${userId}/mentions?max_results=10&tweet.fields=public_metrics,author_id,conversation_id`;
      const mentionsAuth = await signTwitterRequest('GET', mentionsUrl);
      const mentionsRes = await fetch(mentionsUrl, {
        headers: { ...mentionsAuth },
        signal: AbortSignal.timeout(10000),
      });
      const mentionsData = await mentionsRes.json();
      const mentions = (mentionsData.data || []).filter(t => !BLOCK_REGEX.test(t.text));

      const repliedMentions = db.prepare(`
        SELECT target FROM social_posts
        WHERE platform = 'x' AND action_type = 'mention-reply'
        AND created_at > datetime('now', '-7 days')
      `).all().map(r => r.target);

      for (const mention of mentions.slice(0, 3)) {
        if (repliedMentions.includes(`mention:${mention.id}`)) continue;
        if (mention.author_id === userId) continue; // Don't reply to ourselves

        try {
          const replyText = await askClaude(`Someone mentioned us in a tweet: "${mention.text.slice(0, 200)}"

Write a short, energetic reply (under 200 chars) that:
- Thanks them or engages with what they said
- Uses ⚡ or 🔥 emoji naturally
- Can say things like "LFGG", "appreciate you", "building different"
- Mentions snipelink.com if they're asking about the product
- Sounds like a real person, not corporate
- Never says "Thank you for your support" or anything cringe

IMPORTANT: Return ONLY the reply text.`);

          if (replyText && replyText.length > 3 && replyText.length <= 280) {
            trackSpend('social-agent-haiku', 0.001);
            const data = await postTweet(replyText, mention.id);
            if (data.data?.id) {
              results.mentionReplies++;
              trackPost('x', 'mention-reply', `mention:${mention.id}`, replyText);
              console.log(`[X-HYPE-MAN] Replied to mention ${mention.id}: ${replyText.slice(0, 50)}`);
            }
            await sleep(2000);
          }
        } catch (e) {}
      }
    } catch (e) {
      results.errors.push(`Mentions: ${e.message?.slice(0, 80)}`);
    }
  } catch (e) {
    results.errors.push(`X hype man: ${e.message}`);
  }

  console.log(`[X-HYPE-MAN] Done: ${results.selfReplies} thread boosts + ${results.mentionReplies} mention replies`);
  return results;
}

// ═══════════════════════════════════════════════════════════
// X ENGAGER — Likes, RTs, quote tweets (the original engagement agent)
// ═══════════════════════════════════════════════════════════

async function runXEngagement() {
  const results = { likes: 0, replies: 0, retweets: 0, errors: [] };
  if (!process.env.X_API_KEY || !process.env.X_ACCESS_TOKEN) return results;

  const userId = process.env.X_ACCESS_TOKEN.split('-')[0];
  console.log('[X-ENGAGER] Running likes, RTs, quote tweets...');

  try {
    const queries = [
      `"solana developer" -is:retweet lang:en ${BLOCK_WORDS}`,
      `"building on solana" -is:retweet lang:en ${BLOCK_WORDS}`,
      `"USDC payments" developer -is:retweet lang:en ${BLOCK_WORDS}`,
      `"open source" developer tools -is:retweet lang:en ${BLOCK_WORDS}`,
      `"npm package" typescript -is:retweet lang:en ${BLOCK_WORDS}`,
      `"code review" developer -is:retweet lang:en ${BLOCK_WORDS}`,
      `"freelance developer" crypto -is:retweet lang:en ${BLOCK_WORDS}`,
      `solana ecosystem project -is:retweet lang:en ${BLOCK_WORDS}`,
      `"stripe fees" developer -is:retweet lang:en ${BLOCK_WORDS}`,
      `"crypto payments" freelance -is:retweet lang:en ${BLOCK_WORDS}`,
      `"payment link" solana -is:retweet lang:en ${BLOCK_WORDS}`,
      `"accept crypto" developer -is:retweet lang:en ${BLOCK_WORDS}`,
      `"coinbase commerce" -is:retweet lang:en ${BLOCK_WORDS}`,
      `"payment processing" fees developer -is:retweet lang:en ${BLOCK_WORDS}`,
    ];
    const query = queries[Math.floor(Math.random() * queries.length)];
    const searchData = await searchTweets(query, 10);
    let tweets = searchData.data || [];

    tweets = tweets.filter(t => !BLOCK_REGEX.test(t.text));
    tweets.sort((a, b) => (b.public_metrics?.like_count || 0) - (a.public_metrics?.like_count || 0));

    // Like quality tweets
    for (const tw of tweets.slice(0, 8)) {
      try {
        const likeUrl = `https://api.twitter.com/2/users/${userId}/likes`;
        const likeAuth = await signTwitterRequest('POST', likeUrl);
        await fetch(likeUrl, {
          method: 'POST',
          headers: { ...likeAuth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tweet_id: tw.id }),
          signal: AbortSignal.timeout(5000),
        });
        results.likes++;
        await sleep(500);
      } catch (e) {}
    }

    // Retweet — use Claude to verify it's actually good content before retweeting
    const rtCandidate = tweets.find(t => (t.public_metrics?.like_count || 0) > 20);
    if (rtCandidate) {
      try {
        const check = await askClaude(`Should a professional dev/crypto brand retweet this? Reply ONLY "yes" or "no".\n\nTweet: "${rtCandidate.text.slice(0, 250)}"\n\nSay "no" if it's: spam, scam, NSFW, fetish, begging, low quality, controversial, offensive, or not related to tech/crypto/dev.`);
        if (check && check.toLowerCase().trim().startsWith('yes')) {
          trackSpend('social-agent-haiku', 0.001);
          const rtUrl = `https://api.twitter.com/2/users/${userId}/retweets`;
          const rtAuth = await signTwitterRequest('POST', rtUrl);
          const rtRes = await fetch(rtUrl, {
            method: 'POST',
            headers: { ...rtAuth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ tweet_id: rtCandidate.id }),
            signal: AbortSignal.timeout(5000),
          });
          if (rtRes.ok) {
            results.retweets++;
            console.log(`[X-ENGAGER] Retweeted: "${rtCandidate.text.slice(0, 80)}..."`);
          }
        } else {
          console.log(`[X-ENGAGER] Skipped RT (failed quality check): "${rtCandidate.text.slice(0, 80)}..."`);
        }
      } catch (e) {}
    }

    // Quote tweet — also screen with Claude first
    const quotable = tweets.find(t => (t.public_metrics?.like_count || 0) > 10 && t.id !== rtCandidate?.id);
    if (quotable) {
      try {
        const quoteText = await askClaude(`A developer tweeted: "${quotable.text.slice(0, 200)}"\n\nWrite a quote tweet (under 250 chars) that adds a genuine dev perspective. Can use ⚡ or 🔥 if it fits. Mention snipelink.com only if relevant. Sound like a real developer. If the original tweet is spam, scam, NSFW, or low quality, respond with just "SKIP".`);
        if (quoteText && !quoteText.includes('SKIP') && quoteText.length > 10 && quoteText.length <= 280) {
          trackSpend('social-agent-haiku', 0.001);
          const qtUrl = 'https://api.twitter.com/2/tweets';
          const qtAuth = await signTwitterRequest('POST', qtUrl);
          const qtRes = await fetch(qtUrl, {
            method: 'POST',
            headers: { ...qtAuth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: quoteText, quote_tweet_id: quotable.id }),
            signal: AbortSignal.timeout(10000),
          });
          const qtData = await qtRes.json();
          if (qtData.data?.id) {
            results.replies++;
            trackPost('x', 'quote-tweet', `quote:${quotable.id}`, quoteText);
          }
        }
      } catch (e) {
        results.errors.push(`Quote: ${e.message?.slice(0, 80)}`);
      }
    }
  } catch (e) {
    results.errors.push(`X engagement: ${e.message}`);
  }

  return results;
}

// ═══════════════════════════════════════════════════════════
// NOSTR ENGAGEMENT — Like & follow relevant crypto/dev accounts
// ═══════════════════════════════════════════════════════════

async function runNostrEngagement() {
  const results = { likes: 0, follows: 0, errors: [] };
  const skHex = process.env.NOSTR_PRIVATE_KEY;
  if (!skHex) return results;

  try {
    const { getPublicKey, finalizeEvent } = await import('nostr-tools/pure');
    const WebSocket = (await import('ws')).default;
    const sk = Uint8Array.from(skHex.match(/.{2}/g).map(b => parseInt(b, 16)));

    const ws = new WebSocket('wss://relay.damus.io');
    const events = [];

    await new Promise((resolve) => {
      const timeout = setTimeout(() => { resolve(); }, 8000);
      ws.on('open', () => {
        ws.send(JSON.stringify(['REQ', 'search', { kinds: [1], search: 'solana payment', limit: 10, since: Math.floor(Date.now()/1000) - 86400 }]));
      });
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg[0] === 'EVENT' && msg[2]) events.push(msg[2]);
          if (msg[0] === 'EOSE') { clearTimeout(timeout); resolve(); }
        } catch(e) {}
      });
      ws.on('error', () => { clearTimeout(timeout); resolve(); });
    });

    // Like up to 5 relevant posts
    for (const event of events.slice(0, 5)) {
      const reaction = finalizeEvent({
        kind: 7,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['e', event.id], ['p', event.pubkey]],
        content: '+',
      }, sk);
      ws.send(JSON.stringify(['EVENT', reaction]));
      results.likes++;
      await new Promise(r => setTimeout(r, 500));
    }

    // Follow authors of relevant posts
    const newFollows = events.slice(0, 5).map(e => ['p', e.pubkey]);
    if (newFollows.length > 0) {
      const contactList = finalizeEvent({
        kind: 3,
        created_at: Math.floor(Date.now() / 1000),
        tags: newFollows,
        content: '',
      }, sk);
      ws.send(JSON.stringify(['EVENT', contactList]));
      results.follows = newFollows.length;
    }

    setTimeout(() => { try { ws.close(); } catch(e) {} }, 2000);
    trackPost('nostr', 'engagement', 'relay.damus.io', `Liked ${results.likes}, followed ${results.follows}`);
  } catch(e) {
    results.errors.push('Nostr engagement: ' + e.message);
  }

  return results;
}

// ═══════════════════════════════════════════════════════════
// MASTODON ENGAGEMENT — Favourite & follow relevant accounts
// ═══════════════════════════════════════════════════════════

async function runMastodonEngagement() {
  const results = { favourites: 0, follows: 0, errors: [] };
  const token = process.env.MASTODON_ACCESS_TOKEN;
  const instance = process.env.MASTODON_INSTANCE || 'mastodon.social';
  if (!token) return results;

  try {
    const searches = ['solana payments', 'crypto developer tools', 'payment links'];
    const query = searches[Math.floor(Math.random() * searches.length)];

    const searchRes = await fetch(`https://${instance}/api/v2/search?q=${encodeURIComponent(query)}&type=statuses&limit=5`, {
      headers: { 'Authorization': 'Bearer ' + token },
      signal: AbortSignal.timeout(10000),
    });
    const searchData = await searchRes.json();
    const statuses = searchData.statuses || [];

    for (const status of statuses.slice(0, 3)) {
      await fetch(`https://${instance}/api/v1/statuses/${status.id}/favourite`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
        signal: AbortSignal.timeout(5000),
      });
      results.favourites++;

      await fetch(`https://${instance}/api/v1/accounts/${status.account.id}/follow`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
        signal: AbortSignal.timeout(5000),
      });
      results.follows++;

      await new Promise(r => setTimeout(r, 1000));
    }

    if (results.favourites > 0) {
      trackPost('mastodon', 'engagement', instance, `Favourited ${results.favourites}, followed ${results.follows}`);
    }
  } catch(e) {
    results.errors.push('Mastodon engagement: ' + e.message);
  }

  return results;
}

// ═══════════════════════════════════════════════════════════
// BLUESKY ENGAGEMENT — Like relevant crypto/dev posts
// ═══════════════════════════════════════════════════════════

async function runBlueskyEngagement() {
  const results = { likes: 0, errors: [] };
  const session = await getBlueskySession();
  if (!session) return results;

  try {
    const searches = ['crypto payments', 'solana', 'payment links developer'];
    const query = searches[Math.floor(Math.random() * searches.length)];

    const searchRes = await fetch(`https://bsky.social/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=5`, {
      headers: { 'Authorization': `Bearer ${session.accessJwt}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!searchRes.ok) {
      results.errors.push(`Bluesky search: ${searchRes.status}`);
      return results;
    }

    const searchData = await searchRes.json();
    const posts = searchData.posts || [];

    for (const post of posts.slice(0, 3)) {
      try {
        await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.accessJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            repo: session.did,
            collection: 'app.bsky.feed.like',
            record: {
              $type: 'app.bsky.feed.like',
              subject: { uri: post.uri, cid: post.cid },
              createdAt: new Date().toISOString(),
            },
          }),
          signal: AbortSignal.timeout(5000),
        });
        results.likes++;
        await sleep(500);
      } catch (e) {
        results.errors.push(`Bluesky like: ${e.message}`);
      }
    }

    if (results.likes > 0) {
      trackPost('bluesky', 'engagement', 'feed', `Liked ${results.likes} posts`);
    }
  } catch (e) {
    results.errors.push(`Bluesky engagement: ${e.message}`);
  }

  return results;
}

// ═══════════════════════════════════════════════════════════
// MAIN — Run all platforms in parallel
// ═══════════════════════════════════════════════════════════

export async function runSocialAgent() {
  console.log('[SOCIAL] Starting multi-platform social agent...');
  const startTime = Date.now();

  const [reddit, discord, telegram, bluesky, nostr, mastodon, x, nostrEngage, mastodonEngage, blueskyEngage] = await Promise.allSettled([
    runReddit(),
    runDiscord(),
    runTelegram(),
    runBluesky(),
    runNostr(),
    runMastodon(),
    runX(),
    runNostrEngagement(),
    runMastodonEngagement(),
    runBlueskyEngagement(),
  ]);

  const settled = { reddit, discord, telegram, bluesky, nostr, mastodon, x, nostrEngage, mastodonEngage, blueskyEngage };
  const results = { duration: Date.now() - startTime };
  for (const [k, v] of Object.entries(settled)) {
    results[k] = v.status === 'fulfilled' ? v.value : { errors: [v.reason?.message] };
  }

  const totalActions = (results.reddit.comments || 0) + (results.reddit.posts || 0) +
    (results.discord.posts || 0) + (results.telegram.messages || 0) +
    (results.bluesky.posts || 0) + (results.nostr.posts || 0) + (results.mastodon.posts || 0) +
    (results.x?.tweets || 0) +
    (results.nostrEngage.likes || 0) + (results.nostrEngage.follows || 0) +
    (results.mastodonEngage.favourites || 0) + (results.mastodonEngage.follows || 0) +
    (results.blueskyEngage.likes || 0);

  console.log(`[SOCIAL] Done in ${results.duration}ms: ${totalActions} actions`);
  console.log(`[SOCIAL] Reddit: ${results.reddit.comments || 0} | Discord: ${results.discord.posts || 0} | Telegram: ${results.telegram.messages || 0} | Bluesky: ${results.bluesky.posts || 0} | Nostr: ${results.nostr.posts || 0} | Mastodon: ${results.mastodon.posts || 0} | X: ${results.x?.tweets || 0}`);
  console.log(`[SOCIAL] Engagement — Nostr: ${results.nostrEngage.likes || 0} likes/${results.nostrEngage.follows || 0} follows | Mastodon: ${results.mastodonEngage.favourites || 0} favs/${results.mastodonEngage.follows || 0} follows | Bluesky: ${results.blueskyEngage.likes || 0} likes`);

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

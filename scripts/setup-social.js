#!/usr/bin/env node

/**
 * Social Platform Auto-Setup
 * Creates accounts/bots/apps and sets Railway env vars automatically.
 *
 * Usage: node scripts/setup-social.js [platform]
 *   Platforms: bluesky, telegram, reddit, discord, all
 */

import { execSync } from 'child_process';
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => { rl.question(q, r); });

function setRailwayVar(key, value) {
  try {
    execSync(`railway variables --set "${key}=${value}"`, { stdio: 'pipe' });
    console.log(`  ✓ Set ${key} on Railway`);
    return true;
  } catch (e) {
    console.log(`  ✗ Failed to set ${key}: ${e.message}`);
    console.log(`    Run manually: railway variables --set "${key}=${value}"`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// BLUESKY — Fully automated account + app password creation
// ═══════════════════════════════════════════════════════════

async function setupBluesky() {
  console.log('\n═══ BLUESKY SETUP ═══');

  const hasAccount = await ask('Do you have a Bluesky account? (y/n): ');

  let handle, password;

  if (hasAccount.toLowerCase() === 'n') {
    console.log('\nCreating Bluesky account...');
    const email = await ask('Email: ');
    handle = await ask('Handle (e.g. snipelink.bsky.social): ');
    if (!handle.includes('.')) handle += '.bsky.social';
    password = await ask('Password: ');
    const inviteCode = await ask('Invite code (press enter to skip): ');

    const body = { email, handle, password };
    if (inviteCode) body.inviteCode = inviteCode;

    const res = await fetch('https://bsky.social/xrpc/com.atproto.server.createAccount', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      console.log(`  ✗ Account creation failed: ${data.message || JSON.stringify(data)}`);
      console.log('  → Create manually at https://bsky.app then re-run this script');
      return false;
    }
    console.log(`  ✓ Account created: ${data.handle}`);
  } else {
    handle = await ask('Bluesky handle (e.g. snipelink.bsky.social): ');
    if (!handle.includes('.')) handle += '.bsky.social';
    password = await ask('Bluesky password: ');
  }

  // Login to create session
  console.log('Logging in...');
  const loginRes = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: handle, password }),
  });
  const session = await loginRes.json();
  if (!loginRes.ok) {
    console.log(`  ✗ Login failed: ${session.message}`);
    return false;
  }
  console.log(`  ✓ Logged in as ${session.handle}`);

  // Create app password
  console.log('Creating app password...');
  const appRes = await fetch('https://bsky.social/xrpc/com.atproto.server.createAppPassword', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.accessJwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: `agency-command-${Date.now()}` }),
  });
  const appData = await appRes.json();
  if (!appRes.ok) {
    console.log(`  ✗ App password failed: ${appData.message}`);
    console.log('  → Go to Settings > App Passwords > Create manually');
    // Still set handle
    setRailwayVar('BLUESKY_HANDLE', handle);
    return false;
  }
  console.log(`  ✓ App password created: ${appData.name}`);

  setRailwayVar('BLUESKY_HANDLE', handle);
  setRailwayVar('BLUESKY_APP_PASSWORD', appData.password);

  // Post intro
  const introPost = `Building payment infrastructure for developers. Accept SOL, USDC, and PayPal with a single link.\n\nsnipelink.com`;
  const postRes = await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
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
        text: introPost,
        createdAt: new Date().toISOString(),
      },
    }),
  });
  if (postRes.ok) console.log('  ✓ Intro post published!');

  console.log('\n✓ Bluesky fully configured and posting!');
  return true;
}

// ═══════════════════════════════════════════════════════════
// TELEGRAM — Create bot via BotFather interaction
// ═══════════════════════════════════════════════════════════

async function setupTelegram() {
  console.log('\n═══ TELEGRAM SETUP ═══');

  const hasBot = await ask('Do you have a Telegram bot token? (y/n): ');

  let botToken;
  if (hasBot.toLowerCase() === 'y') {
    botToken = await ask('Bot token: ');
  } else {
    console.log('\nTo create a Telegram bot:');
    console.log('  1. Open Telegram and message @BotFather');
    console.log('  2. Send: /newbot');
    console.log('  3. Name: SnipeLink Bot');
    console.log('  4. Username: snipelink_bot (or snipelink_dev_bot if taken)');
    console.log('  5. Copy the token BotFather gives you\n');
    botToken = await ask('Paste bot token here: ');
  }

  if (!botToken || botToken.length < 20) {
    console.log('  ✗ Invalid token');
    return false;
  }

  // Verify token works
  const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
  const me = await meRes.json();
  if (!me.ok) {
    console.log(`  ✗ Invalid token: ${me.description}`);
    return false;
  }
  console.log(`  ✓ Bot verified: @${me.result.username}`);

  setRailwayVar('TELEGRAM_BOT_TOKEN', botToken);

  // Create channel or use existing
  const channelAction = await ask('Do you have a Telegram channel? Enter chat ID or @channel_name (or "skip"): ');
  if (channelAction && channelAction !== 'skip') {
    setRailwayVar('TELEGRAM_CHANNELS', channelAction);

    // Test sending
    const testRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: channelAction,
        text: '🚀 SnipeLink Social Agent is live! Posting crypto payment tips and dev tools here.\n\nsnipelink.com',
        parse_mode: 'Markdown',
      }),
    });
    const testData = await testRes.json();
    if (testData.ok) {
      console.log('  ✓ Test message sent!');
    } else {
      console.log(`  ✗ Message failed: ${testData.description}`);
      console.log('  → Make sure the bot is an admin in the channel');
    }
  }

  console.log('\n✓ Telegram configured!');
  return true;
}

// ═══════════════════════════════════════════════════════════
// REDDIT — App creation guide + auto-set vars
// ═══════════════════════════════════════════════════════════

async function setupReddit() {
  console.log('\n═══ REDDIT SETUP ═══');

  const hasApp = await ask('Do you have a Reddit API app? (y/n): ');

  if (hasApp.toLowerCase() === 'n') {
    console.log('\nCreating a Reddit app (takes 1 minute):');
    console.log('  1. Go to: https://www.reddit.com/prefs/apps');
    console.log('  2. Scroll down → "create another app"');
    console.log('  3. Name: SnipeLinkBot');
    console.log('  4. Type: script');
    console.log('  5. Redirect URI: http://localhost');
    console.log('  6. Click "create app"');
    console.log('  7. The client ID is the string under the app name');
    console.log('  8. The secret is labeled "secret"\n');
  }

  const clientId = await ask('Reddit Client ID: ');
  const clientSecret = await ask('Reddit Client Secret: ');
  const username = await ask('Reddit Username: ');
  const password = await ask('Reddit Password: ');

  if (!clientId || !clientSecret || !username || !password) {
    console.log('  ✗ All fields required');
    return false;
  }

  // Verify credentials
  console.log('Verifying credentials...');
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tokenRes = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'SnipeLinkBot/1.0',
    },
    body: `grant_type=password&username=${username}&password=${password}`,
  });
  const tokenData = await tokenRes.json();

  if (tokenData.access_token) {
    console.log('  ✓ Reddit credentials verified!');
    setRailwayVar('REDDIT_CLIENT_ID', clientId);
    setRailwayVar('REDDIT_CLIENT_SECRET', clientSecret);
    setRailwayVar('REDDIT_USERNAME', username);
    setRailwayVar('REDDIT_PASSWORD', password);
    console.log('\n✓ Reddit configured! Posting to r/solana, r/webdev, r/cryptocurrency');
    return true;
  } else {
    console.log(`  ✗ Auth failed: ${tokenData.error || JSON.stringify(tokenData)}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// DISCORD — Webhook setup
// ═══════════════════════════════════════════════════════════

async function setupDiscord() {
  console.log('\n═══ DISCORD SETUP ═══');
  console.log('\nTo create a Discord webhook:');
  console.log('  1. Open Discord → go to your server');
  console.log('  2. Channel Settings → Integrations → Webhooks');
  console.log('  3. "New Webhook" → Name: SnipeLink');
  console.log('  4. Copy Webhook URL\n');
  console.log('You can add multiple webhooks (comma-separated) for different servers.\n');

  const webhooks = await ask('Webhook URL(s): ');
  if (!webhooks || !webhooks.includes('discord.com')) {
    console.log('  ✗ Invalid webhook URL');
    return false;
  }

  setRailwayVar('DISCORD_WEBHOOKS', webhooks);

  // Test webhook
  const firstWebhook = webhooks.split(',')[0].trim();
  const testRes = await fetch(firstWebhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'SnipeLink',
      content: 'SnipeLink social agent connected! Will share crypto payment tips and dev tools here.\n\nhttps://snipelink.com',
    }),
  });
  if (testRes.ok || testRes.status === 204) {
    console.log('  ✓ Test message sent!');
  }

  console.log('\n✓ Discord configured!');
  return true;
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

const platform = process.argv[2] || 'all';
const platforms = {
  bluesky: setupBluesky,
  telegram: setupTelegram,
  reddit: setupReddit,
  discord: setupDiscord,
};

console.log('╔══════════════════════════════════════════╗');
console.log('║  Agency Command — Social Platform Setup  ║');
console.log('║  Auto-creates accounts, bots, and keys   ║');
console.log('╚══════════════════════════════════════════╝\n');

try {
  if (platform === 'all') {
    const results = {};
    for (const [name, setup] of Object.entries(platforms)) {
      results[name] = await setup();
    }
    console.log('\n═══ SUMMARY ═══');
    for (const [name, ok] of Object.entries(results)) {
      console.log(`  ${ok ? '✓' : '✗'} ${name}`);
    }
  } else if (platforms[platform]) {
    await platforms[platform]();
  } else {
    console.log(`Unknown platform: ${platform}`);
    console.log('Usage: node scripts/setup-social.js [bluesky|telegram|reddit|discord|all]');
  }
} catch (e) {
  console.error('Setup error:', e.message);
}

rl.close();

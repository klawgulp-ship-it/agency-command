import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import WebSocket from 'ws';

const SK_HEX = '605eb98221b052f404da18886731501c7bad6c341593a05ad5ed570d86d16cca';
const secretKey = Uint8Array.from(SK_HEX.match(/.{2}/g).map(b => parseInt(b, 16)));
const pubkey = getPublicKey(secretKey);

console.log(`Publishing as: ${pubkey}`);

const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social',
];

const now = Math.floor(Date.now() / 1000);

const posts = [
  {
    content: `dev tip: if you're building a dApp and still forcing users through tradfi checkout flows, you're doing it wrong. accept USDC/SOL natively — snipelink.com has a dead simple API for it. one POST and you're live`,
    tags: [['t', 'devtools'], ['t', 'crypto'], ['t', 'webdev'], ['t', 'payments']],
  },
  {
    content: `been evaluating payment processors for crypto projects:\n\n- stripe: no native crypto, heavy KYC\n- coinbase commerce: clunky, slow settlements\n- snipelink: paypal + solana/USDC, instant API, no bloat\n\nguess which one i actually ship with`,
    tags: [['t', 'payments'], ['t', 'fintech'], ['t', 'crypto']],
  },
  {
    content: `just started using snipelink-review on our PRs — it's an npm package that runs AI code review on your diffs. catches security issues before they hit main. free tier is generous too. worth a look if you're shipping fast`,
    tags: [['t', 'devtools'], ['t', 'opensource'], ['t', 'npm'], ['t', 'ai']],
  },
  {
    content: `solana ecosystem keeps shipping while CT argues about memecoins. compressed NFTs, token extensions, Firedancer on testnet. building payment infra on it (snipelink.com) and the throughput is unreal — sub-second USDC settlements`,
    tags: [['t', 'solana'], ['t', 'crypto'], ['t', 'defi'], ['t', 'web3']],
  },
  {
    content: `hot take: open source bounty payments are broken. maintainers shouldn't need to invoice through 3 platforms. we built SnipeLink badges for GitHub — solver merges PR, gets a payment link automatically. no friction, just pay`,
    tags: [['t', 'opensource'], ['t', 'github'], ['t', 'bounties'], ['t', 'crypto']],
  },
];

function publishToRelay(relayUrl, event) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve({ relay: relayUrl, ok: false, reason: 'timeout' });
    }, 10000);

    const ws = new WebSocket(relayUrl);

    ws.on('open', () => {
      ws.send(JSON.stringify(['EVENT', event]));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[0] === 'OK') {
          clearTimeout(timeout);
          ws.close();
          resolve({ relay: relayUrl, ok: msg[2], reason: msg[3] || '' });
        }
      } catch {}
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ relay: relayUrl, ok: false, reason: err.message });
    });
  });
}

async function main() {
  const results = [];

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const event = finalizeEvent({
      kind: 1,
      created_at: now - (posts.length - 1 - i) * 300, // 5 min apart, oldest first
      content: post.content,
      tags: post.tags,
    }, secretKey);

    console.log(`\n--- Post ${i + 1} ---`);
    console.log(`Content: ${post.content.slice(0, 80)}...`);
    console.log(`Event ID: ${event.id}`);
    console.log(`Timestamp: ${new Date(event.created_at * 1000).toISOString()}`);

    const relayResults = await Promise.all(
      RELAYS.map((r) => publishToRelay(r, event))
    );

    for (const r of relayResults) {
      console.log(`  ${r.relay}: ${r.ok ? 'OK' : 'FAIL'} ${r.reason}`);
      results.push({ post: i + 1, ...r });
    }
  }

  // Summary
  const successful = results.filter((r) => r.ok);
  const byPost = {};
  for (const r of successful) {
    byPost[r.post] = (byPost[r.post] || 0) + 1;
  }
  const postsPublished = Object.keys(byPost).length;
  const uniqueRelays = new Set(successful.map((r) => r.relay)).size;

  console.log(`\n=== SUMMARY ===`);
  console.log(`Posts published: ${postsPublished}/5`);
  console.log(`Successful relay deliveries: ${successful.length}/${results.length}`);
  console.log(`Relays reached: ${uniqueRelays}/${RELAYS.length}`);
}

main().catch(console.error);

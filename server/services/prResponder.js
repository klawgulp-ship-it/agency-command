import db from '../db/connection.js';
import { notify } from './notifications.js';

const GITHUB_API = 'https://api.github.com';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const GITHUB_USERNAME = 'klawgulp-ship-it';

const MAX_FIX_ITERATIONS = 3;
const MAX_RESPONSES_PER_CYCLE = 5;

// Patterns that signal the PR is dead — stop wasting cycles
const REJECTION_PATTERNS = [
  /\bclosing\b/i, /\bwon'?t merge\b/i, /\bnot going to merge\b/i,
  /\brejected?\b/i, /\bnot needed\b/i, /\bduplicate\b/i,
  /\bwontfix\b/i, /\binvalid\b/i, /\bstale\b/i,
  /\bplease close\b/i, /\bclosing this\b/i,
];

// Simple changes Haiku can handle — everything else goes to Sonnet
const SIMPLE_REVIEW_PATTERNS = [
  /naming/i, /rename/i, /typo/i, /spelling/i, /whitespace/i,
  /indent/i, /format/i, /style/i, /lint/i, /comment/i,
  /capitali[sz]/i, /semicolon/i, /trailing/i, /newline/i,
  /nit:/i, /nit\b/i, /minor/i,
];

// ─── GitHub API helper ──────────────────────────────────
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

// ─── Claude API helpers ─────────────────────────────────
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

const askHaiku = (prompt, maxTokens = 1024) => askClaude(prompt, maxTokens, 'claude-haiku-4-5-20251001');
const askSonnet = (prompt, maxTokens = 8192) => askClaude(prompt, maxTokens, 'claude-sonnet-4-6');

// ─── Helpers ────────────────────────────────────────────

function extractPRInfo(notes) {
  const match = (notes || '').match(/https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], prNumber: parseInt(match[3], 10) };
}

function getRespondedReviewIds(notes) {
  const matches = (notes || '').matchAll(/\[REVIEW-RESPONDED:(\d+)\]/g);
  return new Set([...matches].map(m => m[1]));
}

function getFixIterationCount(notes) {
  return ((notes || '').match(/\[FIX-COMMIT\]/g) || []).length;
}

function isSimpleReview(body) {
  return SIMPLE_REVIEW_PATTERNS.some(p => p.test(body || ''));
}

function isRejection(body) {
  return REJECTION_PATTERNS.some(p => p.test(body || ''));
}

function isApproval(review) {
  if (review.state === 'APPROVED') return true;
  const body = (review.body || '').toLowerCase();
  return /\blgtm\b/.test(body) || /\blooks good\b/.test(body) || /\bship it\b/.test(body);
}

// ─── Push fix commit to our fork's branch ───────────────
async function pushFixCommit(owner, repo, branch, filePath, newContent, commitMessage) {
  // Get current file SHA from our fork
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  let fileSha = null;
  try {
    const existing = await gh(`/repos/${GITHUB_USERNAME}/${repo}/contents/${encodedPath}?ref=${branch}`);
    fileSha = existing.sha;
  } catch (e) {
    // File doesn't exist yet — new file
  }

  const body = {
    message: commitMessage,
    content: Buffer.from(newContent).toString('base64'),
    branch,
  };
  if (fileSha) body.sha = fileSha;

  const result = await gh(`/repos/${GITHUB_USERNAME}/${repo}/contents/${encodedPath}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });

  return result.commit?.sha || null;
}

// ─── Respond to a single review ─────────────────────────
async function respondToReview(owner, repo, prNumber, review, bountyId) {
  const bounty = db.prepare('SELECT * FROM bounties WHERE id = ?').get(bountyId);
  if (!bounty) throw new Error(`Bounty ${bountyId} not found`);

  // Fetch PR details to get the branch name and diff
  const pr = await gh(`/repos/${owner}/${repo}/pulls/${prNumber}`);
  const branch = pr.head?.ref;
  if (!branch) throw new Error('Could not determine PR branch');

  // Fetch the PR diff for context
  let diff = '';
  try {
    const token = process.env.GITHUB_TOKEN;
    const diffRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`, {
      headers: {
        'Accept': 'application/vnd.github.v3.diff',
        'Authorization': `token ${token}`,
        'User-Agent': 'AgencyCommand/1.0',
      },
      signal: AbortSignal.timeout(30000),
    });
    if (diffRes.ok) diff = await diffRes.text();
  } catch (e) {
    console.warn(`[PR-RESPONDER] Failed to fetch diff: ${e.message}`);
  }

  // Collect all review comments (inline + top-level) for this review
  const reviewBody = review.body || '';
  let inlineComments = [];
  if (review.id) {
    try {
      const comments = await gh(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${review.id}/comments`);
      inlineComments = comments.filter(c => c.user?.login !== GITHUB_USERNAME);
    } catch (e) {
      // Some reviews don't have inline comments
    }
  }

  const feedbackText = [
    reviewBody ? `Top-level review:\n${reviewBody}` : '',
    ...inlineComments.map(c =>
      `File: ${c.path} (line ${c.original_line || c.line || '?'})\nComment: ${c.body}`
    ),
  ].filter(Boolean).join('\n\n---\n\n');

  if (!feedbackText.trim()) {
    console.log(`[PR-RESPONDER] Review ${review.id} has no actionable feedback, skipping`);
    return null;
  }

  // Determine which files are affected
  const affectedFiles = new Set();
  for (const c of inlineComments) {
    if (c.path) affectedFiles.add(c.path);
  }

  // If no inline comments, parse file paths from the diff
  if (affectedFiles.size === 0 && diff) {
    const fileMatches = diff.matchAll(/^diff --git a\/(.+?) b\//gm);
    for (const m of fileMatches) affectedFiles.add(m[1]);
  }

  // Read current content of affected files from our fork
  const fileContents = {};
  for (const filePath of affectedFiles) {
    try {
      const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
      const file = await gh(`/repos/${GITHUB_USERNAME}/${repo}/contents/${encodedPath}?ref=${branch}`);
      if (file.content) {
        fileContents[filePath] = Buffer.from(file.content, 'base64').toString('utf-8');
      }
    } catch (e) {
      console.warn(`[PR-RESPONDER] Could not read ${filePath}: ${e.message}`);
    }
  }

  if (Object.keys(fileContents).length === 0) {
    console.warn(`[PR-RESPONDER] No file contents to work with for PR #${prNumber}`);
    return null;
  }

  // Build the prompt
  const filesContext = Object.entries(fileContents)
    .map(([path, content]) => `--- FILE: ${path} ---\n${content.slice(0, 6000)}`)
    .join('\n\n');

  const useHaiku = isSimpleReview(feedbackText);
  const model = useHaiku ? 'Haiku' : 'Sonnet';

  const fixPrompt = `You are an expert developer addressing PR review feedback. Your fix MUST be merged.

PR #${prNumber} on ${owner}/${repo}

REVIEWER FEEDBACK:
${feedbackText.slice(0, 3000)}

CURRENT PR DIFF (excerpt):
${diff.slice(0, 4000)}

CURRENT FILE CONTENTS:
${filesContext}

Address ALL of the reviewer's feedback precisely. Make the minimum changes needed.

CRITICAL JSON RULES:
- Your entire response must be valid JSON — no markdown, no backticks
- Escape all special characters in strings: newlines as \\n, tabs as \\t, quotes as \\"

Respond in this exact JSON format:
{
  "changes": [
    {"path": "path/to/file.ts", "content": "FULL updated file content", "description": "What changed"}
  ],
  "commit_message": "fix: address review feedback — brief description",
  "reply": "Brief, professional reply to the reviewer explaining what you changed (1-3 sentences, no markdown)"
}

RULES:
- Include COMPLETE file content, not just diffs
- Only change what the reviewer asked for — no drive-by refactors
- Match existing code style exactly
- If the reviewer's request is unclear, make your best reasonable interpretation
- Keep the reply concise and professional`;

  const result = useHaiku
    ? await askHaiku(fixPrompt, 8192)
    : await askSonnet(fixPrompt, 16384);

  const jsonMatch = result.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Failed to parse Claude fix response');

  let fix;
  try {
    fix = JSON.parse(jsonMatch[0]);
  } catch (e) {
    // Attempt repair for truncated JSON
    const partial = jsonMatch[0];
    const lastComplete = partial.lastIndexOf('"}');
    if (lastComplete > 0) {
      const repaired = partial.slice(0, lastComplete + 2) +
        '],"commit_message":"fix: address review feedback","reply":"Updated per feedback."}';
      try { fix = JSON.parse(repaired); } catch (e2) {}
    }
    if (!fix) throw new Error('Failed to parse fix JSON from Claude');
  }

  if (!fix.changes || fix.changes.length === 0) {
    console.warn(`[PR-RESPONDER] Claude generated no changes for review ${review.id}`);
    return null;
  }

  // Push each file change as a commit
  let lastCommitSha = null;
  for (const change of fix.changes) {
    if (!change.path || !change.content) continue;
    console.log(`[PR-RESPONDER] Pushing fix to ${change.path} on ${branch}`);
    try {
      lastCommitSha = await pushFixCommit(
        owner, repo, branch, change.path, change.content,
        fix.commit_message || 'fix: address review feedback'
      );
    } catch (e) {
      console.error(`[PR-RESPONDER] Failed to push ${change.path}: ${e.message}`);
      throw e;
    }
  }

  // Reply to the review
  const replyBody = fix.reply || 'Updated per your feedback. Please take another look!';
  try {
    if (review.id) {
      // Reply on the review itself
      await gh(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${review.id}/events`, {
        method: 'POST',
        body: JSON.stringify({ body: replyBody, event: 'COMMENT' }),
      }).catch(() => {
        // Fallback: post as a regular comment
        return gh(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
          method: 'POST',
          body: JSON.stringify({ body: replyBody }),
        });
      });
    } else {
      await gh(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: replyBody }),
      });
    }
  } catch (e) {
    console.error(`[PR-RESPONDER] Failed to post reply: ${e.message}`);
    // Non-fatal — the fix commit was already pushed
  }

  // Also reply to individual inline comments
  for (const inlineComment of inlineComments.slice(0, 5)) {
    try {
      await gh(`/repos/${owner}/${repo}/pulls/comments/${inlineComment.id}/replies`, {
        method: 'POST',
        body: JSON.stringify({ body: 'Addressed in the latest commit.' }),
      });
    } catch (e) {
      // Non-fatal — some APIs don't support replies
    }
  }

  console.log(`[PR-RESPONDER] Fixed review ${review.id} on ${owner}/${repo}#${prNumber} (${model}, commit: ${lastCommitSha?.slice(0, 7) || '?'})`);

  return {
    reviewId: review.id,
    commitSha: lastCommitSha,
    model,
    filesChanged: fix.changes.length,
  };
}

// ─── Main: Check all submitted PRs for review comments ──
export async function checkPRReviews() {
  const token = process.env.GITHUB_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!token || !apiKey) {
    console.log('[PR-RESPONDER] Missing GITHUB_TOKEN or ANTHROPIC_API_KEY — skipping');
    return { responded: 0, log: ['Missing required API keys'] };
  }

  const log = [];
  let responded = 0;

  // Get all submitted bounties with PR URLs
  const submitted = db.prepare(`
    SELECT * FROM bounties
    WHERE status = 'submitted'
      AND notes LIKE '%github.com%/pull/%'
  `).all();

  log.push(`[PR-RESPONDER] Checking ${submitted.length} submitted PRs for reviews`);

  for (const bounty of submitted) {
    if (responded >= MAX_RESPONSES_PER_CYCLE) {
      log.push(`[PR-RESPONDER] Hit rate limit (${MAX_RESPONSES_PER_CYCLE}/cycle), stopping`);
      break;
    }

    const prInfo = extractPRInfo(bounty.notes);
    if (!prInfo) continue;

    const { owner, repo, prNumber } = prInfo;
    const alreadyResponded = getRespondedReviewIds(bounty.notes);
    const fixCount = getFixIterationCount(bounty.notes);

    if (fixCount >= MAX_FIX_ITERATIONS) {
      log.push(`[PR-RESPONDER] ${owner}/${repo}#${prNumber} — hit max iterations (${MAX_FIX_ITERATIONS}), skipping`);
      continue;
    }

    try {
      // Fetch reviews (approval/changes_requested/commented)
      const reviews = await gh(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`);

      // Fetch standalone review comments (inline comments not attached to a review)
      let standaloneComments = [];
      try {
        standaloneComments = await gh(`/repos/${owner}/${repo}/pulls/${prNumber}/comments`);
      } catch (e) { /* non-fatal */ }

      // Also fetch issue-level comments (general PR discussion)
      let issueComments = [];
      try {
        issueComments = await gh(`/repos/${owner}/${repo}/issues/${prNumber}/comments`);
      } catch (e) { /* non-fatal */ }

      // Filter reviews: skip our own, skip already-responded
      const newReviews = reviews.filter(r =>
        r.user?.login !== GITHUB_USERNAME &&
        !alreadyResponded.has(String(r.id)) &&
        r.state !== 'PENDING' &&
        (r.state === 'CHANGES_REQUESTED' || r.state === 'COMMENTED' || r.state === 'APPROVED' || (r.body && r.body.trim()))
      );

      // Check issue comments for rejection or new feedback (use comment ID as review ID)
      const newIssueComments = issueComments.filter(c =>
        c.user?.login !== GITHUB_USERNAME &&
        !alreadyResponded.has(`ic-${c.id}`) &&
        c.body && c.body.trim()
      );

      // Check for rejection signals in any comment
      const allBodies = [
        ...newReviews.map(r => r.body || ''),
        ...newIssueComments.map(c => c.body || ''),
      ];
      const rejected = allBodies.some(body => isRejection(body));

      if (rejected) {
        log.push(`[PR-RESPONDER] ${owner}/${repo}#${prNumber} — rejection detected, marking as rejected`);
        db.prepare(`
          UPDATE bounties SET
            status = 'open',
            claimed = 0,
            submitted = 0,
            notes = COALESCE(notes, '') || ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(`\n[REJECTED] Maintainer indicated won't merge`, bounty.id);

        notify('bounty_rejected', `PR rejected: ${bounty.title.slice(0, 40)}`,
          `Maintainer signaled rejection on ${owner}/${repo}#${prNumber}. Bounty returned to open pool.`,
          { bountyId: bounty.id },
          `https://github.com/${owner}/${repo}/pull/${prNumber}`);
        continue;
      }

      // Process approvals — just log them
      const approvals = newReviews.filter(r => isApproval(r));
      for (const approval of approvals) {
        log.push(`[PR-RESPONDER] ${owner}/${repo}#${prNumber} — approval/LGTM from ${approval.user?.login}`);
        db.prepare("UPDATE bounties SET notes = COALESCE(notes, '') || ?, updated_at = datetime('now') WHERE id = ?")
          .run(`\n[REVIEW-RESPONDED:${approval.id}][APPROVED] by ${approval.user?.login}`, bounty.id);
      }

      // Process change requests — these need fixes
      const changeRequests = newReviews.filter(r =>
        !isApproval(r) &&
        (r.state === 'CHANGES_REQUESTED' || (r.state === 'COMMENTED' && r.body && r.body.trim().length > 10))
      );

      for (const review of changeRequests) {
        if (responded >= MAX_RESPONSES_PER_CYCLE) break;
        if (fixCount + responded >= MAX_FIX_ITERATIONS) {
          log.push(`[PR-RESPONDER] ${owner}/${repo}#${prNumber} — would exceed max iterations, skipping review ${review.id}`);
          break;
        }

        try {
          log.push(`[PR-RESPONDER] Responding to review ${review.id} from ${review.user?.login} on ${owner}/${repo}#${prNumber}`);

          const result = await respondToReview(owner, repo, prNumber, review, bounty.id);

          if (result) {
            responded++;
            db.prepare("UPDATE bounties SET notes = COALESCE(notes, '') || ?, updated_at = datetime('now') WHERE id = ?")
              .run(`\n[REVIEW-RESPONDED:${review.id}][FIX-COMMIT] ${result.model}, ${result.filesChanged} file(s), sha:${(result.commitSha || '').slice(0, 7)}`, bounty.id);

            log.push(`[PR-RESPONDER] Fixed: ${result.filesChanged} file(s) via ${result.model}`);

            notify('pr_review_responded', `Review addressed on ${owner}/${repo}#${prNumber}`,
              `Pushed fix commit for review by ${review.user?.login}. ${result.filesChanged} file(s) updated via ${result.model}.`,
              { bountyId: bounty.id, prNumber, reviewId: review.id },
              `https://github.com/${owner}/${repo}/pull/${prNumber}`);
          } else {
            // No changes needed — mark as responded anyway
            db.prepare("UPDATE bounties SET notes = COALESCE(notes, '') || ?, updated_at = datetime('now') WHERE id = ?")
              .run(`\n[REVIEW-RESPONDED:${review.id}][NO-OP] No actionable feedback`, bounty.id);
          }
        } catch (e) {
          log.push(`[PR-RESPONDER] Error responding to review ${review.id}: ${e.message}`);
          console.error(`[PR-RESPONDER] Error:`, e);
          // Mark as attempted so we don't retry endlessly
          db.prepare("UPDATE bounties SET notes = COALESCE(notes, '') || ?, updated_at = datetime('now') WHERE id = ?")
            .run(`\n[REVIEW-RESPONDED:${review.id}][ERROR] ${e.message.slice(0, 100)}`, bounty.id);
        }
      }

      // Handle issue-level comments that look like review feedback (not rejection, not our own)
      const feedbackComments = newIssueComments.filter(c =>
        !isRejection(c.body) &&
        !isApproval({ body: c.body, state: 'COMMENTED' }) &&
        c.body.trim().length > 20 // Skip short "thanks" type comments
      );

      for (const comment of feedbackComments.slice(0, 2)) {
        if (responded >= MAX_RESPONSES_PER_CYCLE) break;
        if (fixCount + responded >= MAX_FIX_ITERATIONS) break;

        // Wrap issue comment as a review-like object for respondToReview
        const pseudoReview = {
          id: null, // no review ID for issue comments
          body: comment.body,
          user: comment.user,
          state: 'COMMENTED',
        };

        try {
          log.push(`[PR-RESPONDER] Responding to issue comment from ${comment.user?.login} on ${owner}/${repo}#${prNumber}`);
          const result = await respondToReview(owner, repo, prNumber, pseudoReview, bounty.id);

          if (result) {
            responded++;
            db.prepare("UPDATE bounties SET notes = COALESCE(notes, '') || ?, updated_at = datetime('now') WHERE id = ?")
              .run(`\n[REVIEW-RESPONDED:ic-${comment.id}][FIX-COMMIT] ${result.model}, ${result.filesChanged} file(s)`, bounty.id);
          } else {
            db.prepare("UPDATE bounties SET notes = COALESCE(notes, '') || ?, updated_at = datetime('now') WHERE id = ?")
              .run(`\n[REVIEW-RESPONDED:ic-${comment.id}][NO-OP]`, bounty.id);
          }
        } catch (e) {
          log.push(`[PR-RESPONDER] Error on issue comment ${comment.id}: ${e.message}`);
          db.prepare("UPDATE bounties SET notes = COALESCE(notes, '') || ?, updated_at = datetime('now') WHERE id = ?")
            .run(`\n[REVIEW-RESPONDED:ic-${comment.id}][ERROR] ${e.message.slice(0, 100)}`, bounty.id);
        }
      }

    } catch (e) {
      log.push(`[PR-RESPONDER] Error checking ${owner}/${repo}#${prNumber}: ${e.message}`);
      console.error(`[PR-RESPONDER] Error:`, e);
    }
  }

  log.push(`[PR-RESPONDER] Done: ${responded} review(s) addressed`);
  console.log(`[PR-RESPONDER] Cycle complete: ${responded} responses`);
  return { responded, total: submitted.length, log };
}

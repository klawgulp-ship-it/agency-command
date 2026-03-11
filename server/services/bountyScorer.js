import db from '../db/connection.js';

const getMySkills = () => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'my_skills'").get();
  return row ? JSON.parse(row.value).map(s => s.toLowerCase()) : [];
};

// Difficulty estimation based on labels, description length, and keywords
const DIFFICULTY_SIGNALS = {
  easy: ['good first issue', 'beginner', 'easy', 'trivial', 'docs', 'typo', 'documentation', 'readme'],
  medium: ['bug', 'enhancement', 'feature', 'improvement', 'refactor'],
  hard: ['complex', 'architecture', 'security', 'performance', 'breaking', 'migration', 'redesign'],
};

const HOURS_BY_DIFFICULTY = { easy: 1.5, medium: 4, hard: 10 };

export function estimateDifficulty(title, description, labels) {
  const text = `${title} ${description} ${labels.join(' ')}`.toLowerCase();

  for (const keyword of DIFFICULTY_SIGNALS.easy) {
    if (text.includes(keyword)) return 'easy';
  }
  for (const keyword of DIFFICULTY_SIGNALS.hard) {
    if (text.includes(keyword)) return 'hard';
  }

  // Description length as proxy — longer = more complex
  if (description.length > 2000) return 'hard';
  if (description.length < 300) return 'easy';

  return 'medium';
}

export function estimateHours(difficulty) {
  return HOURS_BY_DIFFICULTY[difficulty] || 4;
}

// ROI Score: how profitable is this bounty relative to effort?
// Scale: 0-100. Higher = better money per hour + skill match
export function scoreBounty(bounty) {
  const mySkills = getMySkills();
  const title = (bounty.title || '').toLowerCase();
  const desc = (bounty.description || '').toLowerCase();
  const fullText = `${title} ${desc}`;
  const labels = (Array.isArray(bounty.labels) ? bounty.labels : JSON.parse(bounty.labels || '[]')).map(l => l.toLowerCase());
  const skills = (Array.isArray(bounty.skills) ? bounty.skills : JSON.parse(bounty.skills || '[]')).map(s => s.toLowerCase());

  // ─── ROI: $/hour (0-40 points) ─────────────────────────
  const reward = bounty.reward || 0;
  const hours = bounty.est_hours || estimateHours(bounty.difficulty || 'medium');
  const hourlyRate = hours > 0 ? reward / hours : 0;

  let roiScore = 0;
  if (hourlyRate >= 200) roiScore = 40;
  else if (hourlyRate >= 100) roiScore = 35;
  else if (hourlyRate >= 75) roiScore = 30;
  else if (hourlyRate >= 50) roiScore = 25;
  else if (hourlyRate >= 30) roiScore = 18;
  else if (hourlyRate >= 15) roiScore = 10;
  else roiScore = 5;

  // ─── Skill match (0-30 points) ─────────────────────────
  let skillMatch = 0;
  const allBountySkills = [...skills, ...labels];
  if (allBountySkills.length > 0) {
    const matches = allBountySkills.filter(s =>
      mySkills.some(ms => ms.includes(s) || s.includes(ms))
    ).length;
    skillMatch = Math.round((matches / allBountySkills.length) * 30);
  } else {
    // Check title/desc for our skills
    const textMatches = mySkills.filter(s => fullText.includes(s)).length;
    skillMatch = Math.min(textMatches * 6, 30);
  }

  // ─── Reward size bonus (0-15 points) ───────────────────
  let rewardScore = 0;
  if (reward >= 1000) rewardScore = 15;
  else if (reward >= 500) rewardScore = 12;
  else if (reward >= 200) rewardScore = 10;
  else if (reward >= 100) rewardScore = 7;
  else if (reward >= 50) rewardScore = 4;
  else rewardScore = 2;

  // ─── Difficulty preference (0-15 points) ───────────────
  // Prefer easy/medium bounties — faster turnaround
  const difficultyScore = bounty.difficulty === 'easy' ? 15
    : bounty.difficulty === 'medium' ? 10
    : 5;

  // ─── Repo freshness penalty (-30 to 0 points) ─────────
  // Dead repos = zombie bounties, nobody to merge or pay
  let freshnessPenalty = 0;
  const repo = bounty.repo || '';
  if (repo) {
    // Check if we have cached repo activity data
    const cached = db.prepare("SELECT value FROM settings WHERE key = ?").get(`repo_activity:${repo}`);
    if (cached) {
      try {
        const activity = JSON.parse(cached.value);
        const daysSincePush = activity.daysSincePush || 999;
        if (daysSincePush > 365 * 2) freshnessPenalty = -30;      // 2+ years dead
        else if (daysSincePush > 365) freshnessPenalty = -20;      // 1+ year stale
        else if (daysSincePush > 180) freshnessPenalty = -10;      // 6+ months quiet
        else if (daysSincePush <= 30) freshnessPenalty = 5;        // Active = bonus
      } catch (e) {}
    }
  }

  // ─── Suspicious reward penalty (-20 to 0 points) ──────
  // $5K+ bounties marked "easy" are almost always zombie/scam
  let suspiciousPenalty = 0;
  if (reward >= 5000 && bounty.difficulty === 'easy') suspiciousPenalty = -20;
  else if (reward >= 3000 && bounty.difficulty === 'easy') suspiciousPenalty = -10;

  return Math.max(0, Math.min(100, roiScore + skillMatch + rewardScore + difficultyScore + freshnessPenalty + suspiciousPenalty));
}

// Quick-solve detection: bounties Claude can likely handle in <1 hour
export function isQuickSolve(bounty) {
  const text = `${bounty.title} ${bounty.description}`.toLowerCase();
  const quickPatterns = [
    'typo', 'documentation', 'readme', 'update dep', 'rename',
    'add type', 'type error', 'lint', 'format', 'css fix',
    'translation', 'i18n', 'localization', 'broken link',
  ];
  return quickPatterns.some(p => text.includes(p)) || bounty.difficulty === 'easy';
}

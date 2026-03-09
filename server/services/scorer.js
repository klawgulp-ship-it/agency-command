import db from '../db/connection.js';

const getMySkills = () => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'my_skills'").get();
  return row ? JSON.parse(row.value) : [];
};

export function scoreJob(job) {
  const mySkills = getMySkills().map(s => s.toLowerCase());
  const jobSkills = (Array.isArray(job.skills) ? job.skills : JSON.parse(job.skills || '[]'))
    .map(s => s.toLowerCase());

  if (jobSkills.length === 0) return 50;

  // Skill match (0-60 points)
  const matchCount = jobSkills.filter(s =>
    mySkills.some(ms => ms.includes(s) || s.includes(ms))
  ).length;
  const skillScore = Math.round((matchCount / jobSkills.length) * 60);

  // Budget score (0-20 points) — prefer higher value
  const value = job.est_value || 0;
  const budgetScore = value >= 5000 ? 20 : value >= 3000 ? 16 : value >= 1500 ? 12 : value >= 500 ? 8 : 4;

  // Recency score (0-10 points)
  const posted = (job.posted_at || '').toLowerCase();
  const recencyScore = posted.includes('h ago') || posted.includes('just')
    ? 10 : posted.includes('1d') ? 7 : posted.includes('d ago') ? 4 : 2;

  // Source quality (0-10 points)
  const sourceScore = { upwork: 10, linkedin: 9, fiverr: 7, custom: 5 }[
    (job.source || '').toLowerCase()
  ] || 5;

  return Math.min(100, skillScore + budgetScore + recencyScore + sourceScore);
}

export function estimateValue(budgetStr) {
  if (!budgetStr) return 0;
  const nums = budgetStr.match(/[\d,]+/g);
  if (!nums || nums.length === 0) return 0;
  const values = nums.map(n => parseInt(n.replace(/,/g, '')));
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

export function estimateTime(value) {
  if (value >= 5000) return '7-14 days';
  if (value >= 3000) return '5-7 days';
  if (value >= 1500) return '3-5 days';
  if (value >= 500) return '1-3 days';
  return '1-2 days';
}

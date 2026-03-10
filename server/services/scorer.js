import db from '../db/connection.js';

const getMySkills = () => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'my_skills'").get();
  return row ? JSON.parse(row.value) : [];
};

// Skills that mean "this is a dev job we can actually do"
const STRONG_MATCH_SKILLS = [
  'react', 'typescript', 'node.js', 'express', 'next.js', 'javascript',
  'full-stack', 'fullstack', 'frontend', 'backend', 'web app',
  'dashboard', 'payment', 'stripe', 'api', 'rest api', 'graphql',
  'postgresql', 'mongodb', 'firebase', 'supabase',
  'solana', 'web3', 'blockchain',
  'ai', 'llm', 'chatbot', 'openai',
  'landing page', 'e-commerce', 'saas',
];

// Skills that mean "this is NOT a dev job" — skip these
const EXCLUDE_KEYWORDS = [
  'graphic designer', 'brand designer', 'ui designer', 'ux designer',
  'email designer', 'production designer', 'visual designer',
  'motion designer', 'print designer', 'illustration',
  'copywriter', 'content writer', 'social media manager',
  'project manager', 'recruiter', 'sales representative',
  'customer support', 'data entry', 'virtual assistant',
];

export function scoreJob(job) {
  const mySkills = getMySkills().map(s => s.toLowerCase());
  const jobSkills = (Array.isArray(job.skills) ? job.skills : JSON.parse(job.skills || '[]'))
    .map(s => s.toLowerCase());

  const title = (job.title || '').toLowerCase();
  const desc = (job.description || '').toLowerCase();
  const fullText = `${title} ${desc}`;

  // Exclude non-dev jobs
  for (const ex of EXCLUDE_KEYWORDS) {
    if (title.includes(ex)) return 10;
  }

  // Strong match bonus — is this a dev job we can crush?
  let strongMatch = 0;
  for (const s of STRONG_MATCH_SKILLS) {
    if (fullText.includes(s)) strongMatch++;
  }
  if (strongMatch === 0 && jobSkills.length === 0) return 20;

  // Skill match (0-50 points)
  let matchCount = 0;
  if (jobSkills.length > 0) {
    matchCount = jobSkills.filter(s =>
      mySkills.some(ms => ms.includes(s) || s.includes(ms))
    ).length;
  }
  const skillScore = jobSkills.length > 0
    ? Math.round((matchCount / jobSkills.length) * 50)
    : Math.min(strongMatch * 8, 30);

  // Budget score (0-20 points)
  const value = job.est_value || 0;
  const budgetScore = value >= 5000 ? 20 : value >= 3000 ? 16 : value >= 1500 ? 12 : value >= 500 ? 8 : 4;

  // Recency score (0-10 points)
  const posted = (job.posted_at || '').toLowerCase();
  const recencyScore = posted.includes('h ago') || posted.includes('just')
    ? 10 : posted.includes('1d') ? 7 : posted.includes('d ago') ? 4 : 2;

  // Source quality (0-10 points)
  const sourceScore = { remoteok: 9, 'hn jobs': 10, remotive: 9, dribbble: 5, custom: 5 }[
    (job.source || '').toLowerCase()
  ] || 5;

  // Dev relevance bonus (0-10 points)
  const devBonus = strongMatch >= 3 ? 10 : strongMatch >= 2 ? 7 : strongMatch >= 1 ? 4 : 0;

  return Math.min(100, skillScore + budgetScore + recencyScore + sourceScore + devBonus);
}

export function estimateValue(budgetStr) {
  if (!budgetStr) return 0;
  const nums = budgetStr.match(/[\d,]+/g);
  if (!nums || nums.length === 0) return 0;
  const values = nums.map(n => parseInt(n.replace(/,/g, '')));
  // Handle k notation
  if (budgetStr.toLowerCase().includes('k')) {
    return Math.round(values.reduce((a, b) => a + b, 0) / values.length) * 1000;
  }
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

// Smarter estimation based on job title/description when no budget given
export function estimateFromContext(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  // Senior/lead roles
  if (text.includes('senior') || text.includes('lead') || text.includes('architect'))
    return { min: 5000, max: 15000 };
  // Full-stack / web app
  if (text.includes('full-stack') || text.includes('fullstack') || text.includes('web app'))
    return { min: 3000, max: 8000 };
  // Specific integrations
  if (text.includes('payment') || text.includes('stripe') || text.includes('blockchain'))
    return { min: 2000, max: 5000 };
  // Dashboard / admin
  if (text.includes('dashboard') || text.includes('admin') || text.includes('analytics'))
    return { min: 2000, max: 5000 };
  // Landing page / simple
  if (text.includes('landing') || text.includes('portfolio') || text.includes('website'))
    return { min: 600, max: 1500 };
  // API / backend
  if (text.includes('api') || text.includes('backend') || text.includes('microservice'))
    return { min: 1500, max: 4000 };
  // Default
  return { min: 1000, max: 3000 };
}

export function estimateTime(value) {
  if (value >= 8000) return '10-21 days';
  if (value >= 5000) return '7-14 days';
  if (value >= 3000) return '5-7 days';
  if (value >= 1500) return '3-5 days';
  if (value >= 500) return '1-3 days';
  return '1-2 days';
}

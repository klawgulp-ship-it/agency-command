const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

export async function generateProposal(job, apiKey) {
  if (!apiKey) {
    return { success: false, error: 'ANTHROPIC_API_KEY not set. Add it to Railway environment variables.' };
  }

  const skills = Array.isArray(job.skills) ? job.skills : JSON.parse(job.skills || '[]');

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `Generate a compelling freelance proposal for this job. Be concise, professional, and highlight speed of delivery using AI-assisted development.

JOB TITLE: ${job.title}
CLIENT: ${job.client}
BUDGET: ${job.budget}
DESCRIPTION: ${job.description}
REQUIRED SKILLS: ${skills.join(', ')}

MY STRENGTHS:
- Senior full-stack developer (TypeScript, React, Node.js, Solana/Web3)
- AI-assisted development workflow = 5-10x faster delivery
- Production deployment experience (Railway, Vercel)
- Payment integration specialist (Stripe, crypto)
- Portfolio of shipped products

FORMAT:
- Opening hook (2 sentences, address their specific need)
- Why I'm the right fit (3-4 bullet points)
- Proposed approach & timeline (brief)
- Pricing (based on their budget range, 50% deposit / 50% delivery)
- Call to action

Keep it under 300 words. No fluff. Sound human, not templated.`
        }],
      }),
    });

    const data = await res.json();
    const text = data.content?.map(c => c.text || '').join('\n') || '';
    if (!text) return { success: false, error: 'Empty response from Claude API' };
    return { success: true, proposal: text };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

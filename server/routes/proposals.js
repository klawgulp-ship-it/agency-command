import { Router } from 'express';
import db from '../db/connection.js';
import { generateProposal } from '../services/proposalGenerator.js';

const router = Router();

router.post('/generate', async (req, res) => {
  const { job_id, job } = req.body;
  let jobData = job;

  if (job_id && !jobData) {
    jobData = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job_id);
    if (!jobData) return res.status(404).json({ error: 'Job not found' });
  }
  if (!jobData) return res.status(400).json({ error: 'job or job_id required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const result = await generateProposal(jobData, apiKey);
  res.json(result);
});

export default router;

import { Router } from 'express';
import { runAutoAgent, getAgentStats } from '../services/autoAgent.js';

const router = Router();

// POST /api/agent/run — trigger the auto-agent
router.post('/run', async (req, res) => {
  try {
    const result = await runAutoAgent();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/agent/stats — get agent dashboard stats
router.get('/stats', (req, res) => {
  res.json(getAgentStats());
});

export default router;

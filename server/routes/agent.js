import { Router } from 'express';
import { runAutoAgent, getAgentStats } from '../services/autoAgent.js';

const router = Router();

let agentRunning = false;
let lastAgentResult = null;

// POST /api/agent/run — trigger the auto-agent (non-blocking)
router.post('/run', (req, res) => {
  if (agentRunning) {
    return res.json({ status: 'already_running', message: 'Agent is already running...' });
  }
  agentRunning = true;
  lastAgentResult = null;

  // Fire and forget — don't block the HTTP request
  runAutoAgent().then(result => {
    lastAgentResult = result;
    agentRunning = false;
  }).catch(e => {
    lastAgentResult = { log: ['[ERROR] ' + e.message], error: e.message };
    agentRunning = false;
  });

  res.json({ status: 'started', message: 'Agent started! Results will appear shortly.' });
});

// GET /api/agent/status — poll for agent completion
router.get('/status', (req, res) => {
  res.json({ running: agentRunning, result: lastAgentResult });
});

// GET /api/agent/stats — get agent dashboard stats
router.get('/stats', (req, res) => {
  res.json(getAgentStats());
});

export default router;

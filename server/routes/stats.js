import { Router } from 'express';
import db from '../db/connection.js';

const router = Router();

router.get('/', (req, res) => {
  const totalClients = db.prepare('SELECT COUNT(*) as c FROM clients').get().c;
  const activeBuilds = db.prepare("SELECT COUNT(*) as c FROM clients WHERE stage IN ('building','accepted','deposit_paid')").get().c;
  const revenue = db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM invoices WHERE status = 'paid'").get().total;
  const pending = db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM invoices WHERE status = 'pending'").get().total;
  const jobCount = db.prepare('SELECT COUNT(*) as c FROM jobs WHERE dismissed = 0').get().c;
  const avgScore = db.prepare('SELECT COALESCE(AVG(score),0) as avg FROM jobs WHERE dismissed = 0').get().avg;
  const stageBreakdown = db.prepare('SELECT stage, COUNT(*) as count FROM clients GROUP BY stage').all();

  res.json({ totalClients, activeBuilds, revenue, pending, jobCount, avgScore: Math.round(avgScore), stageBreakdown });
});

export default router;

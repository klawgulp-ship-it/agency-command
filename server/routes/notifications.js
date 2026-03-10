import { Router } from 'express';
import { getNotifications, markRead, markAllRead, getUnreadCount, addSSEClient } from '../services/notifications.js';

const router = Router();

// SSE stream — real-time notifications
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('data: {"type":"connected"}\n\n');
  addSSEClient(res);
});

router.get('/', (req, res) => {
  const unreadOnly = req.query.unread === 'true';
  res.json(getNotifications(50, unreadOnly));
});

router.get('/count', (req, res) => {
  res.json({ count: getUnreadCount() });
});

router.post('/:id/read', (req, res) => {
  markRead(req.params.id);
  res.json({ success: true });
});

router.post('/read-all', (req, res) => {
  markAllRead();
  res.json({ success: true });
});

export default router;

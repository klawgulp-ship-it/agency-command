const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

export const api = {
  // Jobs
  getJobs: (params) => request(`/jobs?${new URLSearchParams(params)}`),
  refreshJobs: () => request('/jobs/refresh', { method: 'POST' }),
  dismissJob: (id) => request(`/jobs/${id}/dismiss`, { method: 'POST' }),
  addJob: (job) => request('/jobs', { method: 'POST', body: job }),

  // Clients
  getClients: (params) => request(`/clients?${new URLSearchParams(params || {})}`),
  getClient: (id) => request(`/clients/${id}`),
  createClient: (data) => request('/clients', { method: 'POST', body: data }),
  updateClient: (id, data) => request(`/clients/${id}`, { method: 'PATCH', body: data }),
  deleteClient: (id) => request(`/clients/${id}`, { method: 'DELETE' }),

  // Invoices
  getInvoices: (params) => request(`/invoices?${new URLSearchParams(params || {})}`),
  createInvoice: (data) => request('/invoices', { method: 'POST', body: data }),
  markPaid: (id) => request(`/invoices/${id}/pay`, { method: 'PATCH' }),
  deleteInvoice: (id) => request(`/invoices/${id}`, { method: 'DELETE' }),
  getOverdue: (days) => request(`/invoices/overdue?days=${days || 7}`),

  // Feeds
  getFeeds: () => request('/feeds'),
  addFeed: (data) => request('/feeds', { method: 'POST', body: data }),
  deleteFeed: (id) => request(`/feeds/${id}`, { method: 'DELETE' }),

  // Proposals
  generateProposal: (data) => request('/proposals/generate', { method: 'POST', body: data }),

  // Settings
  getSettings: () => request('/settings'),
  updateSetting: (key, value) => request(`/settings/${key}`, { method: 'PUT', body: { value } }),

  // Stats
  getStats: () => request('/stats'),

  // Agent (long timeout — scraping + AI generation takes time)
  runAgent: () => fetch('/api/agent/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000) }).then(r => r.json()),
  getAgentStats: () => request('/agent/stats'),

  // Notifications
  getNotifications: (unread) => request(`/notifications${unread ? '?unread=true' : ''}`),
  getUnreadCount: () => request('/notifications/count'),
  markRead: (id) => request(`/notifications/${id}/read`, { method: 'POST' }),
  markAllRead: () => request('/notifications/read-all', { method: 'POST' }),
};

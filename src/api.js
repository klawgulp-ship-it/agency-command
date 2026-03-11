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
  getPortalLink: (id) => request(`/clients/${id}/portal`, { method: 'POST' }),
  createClientInvoice: (id, data) => request(`/clients/${id}/invoice`, { method: 'POST', body: data }),

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

  // Agent
  runAgent: () => request('/agent/run', { method: 'POST' }),
  getAgentStatus: () => request('/agent/status'),
  getAgentStats: () => request('/agent/stats'),

  // Bounties
  getBounties: (params) => request(`/bounties?${new URLSearchParams(params || {})}`),
  getBountyStats: () => request('/bounties/stats'),
  getTopBounties: (limit) => request(`/bounties/top?limit=${limit || 20}`),
  getQuickWins: (limit) => request(`/bounties/quick-wins?limit=${limit || 10}`),
  refreshBounties: () => request('/bounties/refresh', { method: 'POST' }),
  solveBounties: () => request('/bounties/solve', { method: 'POST' }),
  claimBounty: (id) => request(`/bounties/${id}/claim`, { method: 'POST' }),
  submitBounty: (id) => request(`/bounties/${id}/submit`, { method: 'POST' }),
  completeBounty: (id) => request(`/bounties/${id}/complete`, { method: 'POST' }),
  markBountyPaid: (id) => request(`/bounties/${id}/paid`, { method: 'POST' }),
  dismissBounty: (id) => request(`/bounties/${id}/dismiss`, { method: 'POST' }),
  updateBountyNotes: (id, notes) => request(`/bounties/${id}`, { method: 'PATCH', body: { notes } }),

  // Notifications
  getNotifications: (unread) => request(`/notifications${unread ? '?unread=true' : ''}`),
  getUnreadCount: () => request('/notifications/count'),
  markRead: (id) => request(`/notifications/${id}/read`, { method: 'POST' }),
  markAllRead: () => request('/notifications/read-all', { method: 'POST' }),
};

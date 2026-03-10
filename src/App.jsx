import { useState, useEffect } from "react";
import { api } from "./api.js";

const PIPELINE_STAGES = [
  { id: "lead", label: "Lead", color: "#6B7280" },
  { id: "proposal_sent", label: "Proposal Sent", color: "#F59E0B" },
  { id: "accepted", label: "Accepted", color: "#3B82F6" },
  { id: "deposit_paid", label: "Deposit Paid", color: "#8B5CF6" },
  { id: "building", label: "Building", color: "#EC4899" },
  { id: "delivered", label: "Delivered", color: "#10B981" },
  { id: "final_payment", label: "Final Payment", color: "#059669" },
];

const PROJECT_TEMPLATES = [
  { id: "landing", name: "Landing Page", desc: "Marketing/product landing page with CTA sections", est: "$800-1500", time: "2-3 days", stack: ["React","TypeScript","Tailwind"] },
  { id: "dashboard", name: "Admin Dashboard", desc: "Data visualization dashboard with auth, CRUD, charts", est: "$2000-4000", time: "4-7 days", stack: ["React","TypeScript","Express","PostgreSQL"] },
  { id: "webapp", name: "Full-Stack Web App", desc: "Complete web application with auth, DB, API", est: "$3000-6000", time: "5-10 days", stack: ["Next.js","TypeScript","PostgreSQL","Stripe"] },
  { id: "payment", name: "Payment Integration", desc: "Stripe/crypto payment flow with webhooks", est: "$1000-2500", time: "2-4 days", stack: ["Node.js","Stripe","Express"] },
  { id: "portfolio", name: "Portfolio Site", desc: "Personal/business portfolio with CMS", est: "$600-1200", time: "1-2 days", stack: ["React","TypeScript","MDX"] },
  { id: "ecommerce", name: "E-Commerce Store", desc: "Product listings, cart, checkout, order management", est: "$3500-7000", time: "7-14 days", stack: ["Next.js","Stripe","PostgreSQL"] },
  { id: "api", name: "REST API Service", desc: "Backend API with auth, rate limiting, docs", est: "$1500-3000", time: "3-5 days", stack: ["Express","TypeScript","PostgreSQL","Swagger"] },
  { id: "bot", name: "Telegram/Discord Bot", desc: "Automated bot with commands, payments, notifications", est: "$800-2000", time: "2-4 days", stack: ["Node.js","TypeScript"] },
];

// ─── UI Primitives ───────────────────────────────────────
function Badge({ children, color = "#6B7280", size = "sm" }) {
  return <span style={{ background: color + "18", color, border: `1px solid ${color}40`, padding: size === "sm" ? "2px 8px" : "4px 12px", borderRadius: 4, fontSize: size === "sm" ? 11 : 12, fontWeight: 600, letterSpacing: "0.02em", whiteSpace: "nowrap" }}>{children}</span>;
}

function Button({ children, onClick, variant = "primary", size = "md", disabled, style = {} }) {
  const base = { border: "none", borderRadius: 6, cursor: disabled ? "not-allowed" : "pointer", fontWeight: 600, fontFamily: "'DM Sans', sans-serif", transition: "all 0.15s ease", opacity: disabled ? 0.5 : 1, display: "inline-flex", alignItems: "center", gap: 6, ...style };
  const sizes = { sm: { padding: "6px 12px", fontSize: 12 }, md: { padding: "8px 16px", fontSize: 13 }, lg: { padding: "10px 20px", fontSize: 14 } };
  const variants = { primary: { background: "#C8FF32", color: "#0A0A0B" }, secondary: { background: "#1E1E22", color: "#E0E0E4", border: "1px solid #2A2A2E" }, ghost: { background: "transparent", color: "#A0A0A8" }, danger: { background: "#EF444420", color: "#EF4444", border: "1px solid #EF444440" } };
  return <button onClick={onClick} disabled={disabled} style={{ ...base, ...sizes[size], ...variants[variant] }}>{children}</button>;
}

function Card({ children, style = {}, onClick }) {
  return <div onClick={onClick} style={{ background: "#141416", border: "1px solid #1E1E22", borderRadius: 10, padding: 20, cursor: onClick ? "pointer" : "default", transition: "border-color 0.15s ease", ...style }}>{children}</div>;
}

function Input({ value, onChange, placeholder, type = "text", style = {} }) {
  return <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={{ background: "#0A0A0B", border: "1px solid #2A2A2E", borderRadius: 6, padding: "8px 12px", color: "#E0E0E4", fontSize: 13, fontFamily: "'DM Sans', sans-serif", outline: "none", width: "100%", boxSizing: "border-box", ...style }} />;
}

function TextArea({ value, onChange, placeholder, rows = 4, style = {} }) {
  return <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={rows} style={{ background: "#0A0A0B", border: "1px solid #2A2A2E", borderRadius: 6, padding: "10px 12px", color: "#E0E0E4", fontSize: 13, fontFamily: "'DM Sans', sans-serif", outline: "none", width: "100%", boxSizing: "border-box", resize: "vertical", lineHeight: 1.5, ...style }} />;
}

function Select({ value, onChange, options, style = {} }) {
  return <select value={value} onChange={e => onChange(e.target.value)} style={{ background: "#0A0A0B", border: "1px solid #2A2A2E", borderRadius: 6, padding: "8px 12px", color: "#E0E0E4", fontSize: 13, fontFamily: "'DM Sans', sans-serif", outline: "none", cursor: "pointer", ...style }}>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
}

function Modal({ open, onClose, title, children, width = 600 }) {
  if (!open) return null;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, backdropFilter: "blur(4px)" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#141416", border: "1px solid #2A2A2E", borderRadius: 12, width: "90%", maxWidth: width, maxHeight: "85vh", overflow: "auto" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #1E1E22", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, background: "#141416", zIndex: 1 }}>
          <h3 style={{ margin: 0, fontSize: 16, color: "#E0E0E4" }}>{title}</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#6B6B73", fontSize: 20, cursor: "pointer", padding: "4px 8px" }}>✕</button>
        </div>
        <div style={{ padding: 20 }}>{children}</div>
      </div>
    </div>
  );
}

function ScoreBadge({ score }) {
  const color = score >= 90 ? "#C8FF32" : score >= 75 ? "#F59E0B" : score >= 60 ? "#3B82F6" : "#6B7280";
  return <div style={{ width: 42, height: 42, borderRadius: "50%", border: `2px solid ${color}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, color, background: color + "10", flexShrink: 0 }}>{score}</div>;
}

function StatCard({ label, value, sub, accent = "#C8FF32" }) {
  return (
    <Card style={{ flex: 1, minWidth: 140 }}>
      <div style={{ fontSize: 11, color: "#6B6B73", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: accent, fontFamily: "'Space Mono', monospace" }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "#6B6B73", marginTop: 4 }}>{sub}</div>}
    </Card>
  );
}

// ─── Tab: Job Monitor ────────────────────────────────────
function JobMonitor({ onSelectJob }) {
  const [jobs, setJobs] = useState([]);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const [feedSource, setFeedSource] = useState("Upwork");
  const [showAddFeed, setShowAddFeed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadJobs = async () => {
    try {
      const params = {};
      if (filter !== "all") params.source = filter;
      const data = await api.getJobs(params);
      setJobs(data);
    } catch (e) { console.error("Failed to load jobs:", e); }
    setLoading(false);
  };

  useEffect(() => { loadJobs(); }, [filter]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try { await api.refreshJobs(); await loadJobs(); }
    catch (e) { console.error(e); }
    setRefreshing(false);
  };

  const handleAddFeed = async () => {
    if (!feedUrl.trim()) return;
    try {
      await api.addFeed({ url: feedUrl, source: feedSource });
      await api.refreshJobs();
      await loadJobs();
      setFeedUrl(""); setShowAddFeed(false);
    } catch (e) { console.error(e); }
  };

  const handleDismiss = async (e, id) => {
    e.stopPropagation();
    await api.dismissJob(id);
    setJobs(prev => prev.filter(j => j.id !== id));
  };

  const filtered = jobs.filter(j => !search || j.title.toLowerCase().includes(search.toLowerCase()) || (j.skills || []).some(s => s.toLowerCase().includes(search.toLowerCase())));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, color: "#E0E0E4" }}>Job Monitor</h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6B6B73" }}>AI-scored matches from your feeds • {jobs.length} jobs</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="secondary" size="sm" onClick={() => setShowAddFeed(!showAddFeed)}>+ Add Feed</Button>
          <Button size="sm" onClick={handleRefresh} disabled={refreshing}>{refreshing ? "⏳ Scraping..." : "⟳ Refresh Feeds"}</Button>
        </div>
      </div>

      {showAddFeed && (
        <Card style={{ marginBottom: 16, display: "flex", gap: 8, alignItems: "center" }}>
          <Input value={feedUrl} onChange={setFeedUrl} placeholder="RSS feed URL or job board scraper endpoint..." style={{ flex: 1 }} />
          <Select value={feedSource} onChange={setFeedSource} options={[{ value: "Upwork", label: "Upwork" }, { value: "Fiverr", label: "Fiverr" }, { value: "LinkedIn", label: "LinkedIn" }, { value: "Custom", label: "Custom" }]} />
          <Button onClick={handleAddFeed} size="sm">Add</Button>
        </Card>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <Input value={search} onChange={setSearch} placeholder="Search jobs or skills..." style={{ flex: 1, minWidth: 200 }} />
        {["all", "RemoteOK", "HN Jobs", "Dribbble"].map(f => (
          <Button key={f} variant={filter === f ? "primary" : "secondary"} size="sm" onClick={() => setFilter(f)}>{f === "all" ? "All Sources" : f}</Button>
        ))}
      </div>

      {loading ? <div style={{ textAlign: "center", padding: 40, color: "#6B6B73" }}>Loading jobs...</div> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map(job => (
            <Card key={job.id} onClick={() => onSelectJob(job)} style={{ cursor: "pointer", display: "flex", gap: 16, alignItems: "center" }}>
              <ScoreBadge score={job.score} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#E0E0E4", marginBottom: 4 }}>{job.title}</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
                  {(job.skills || []).slice(0, 4).map(s => <Badge key={s} color="#3B82F6">{s}</Badge>)}
                </div>
                <div style={{ display: "flex", gap: 16, fontSize: 12, color: "#6B6B73" }}>
                  <span>{job.source}</span><span>{job.budget}</span><span>{job.posted_at}</span><span>{job.client}</span>
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#C8FF32", fontFamily: "'Space Mono', monospace" }}>${(job.est_value || 0).toLocaleString()}</div>
                <div style={{ fontSize: 11, color: "#6B6B73" }}>~{job.est_time}</div>
                <button onClick={e => { e.stopPropagation(); onSelectJob(job); }} style={{ background: "#C8FF3220", border: "1px solid #C8FF3240", color: "#C8FF32", fontSize: 11, cursor: "pointer", marginTop: 4, borderRadius: 4, padding: "2px 8px", fontWeight: 600 }}>⚡ Apply</button>
                <button onClick={e => handleDismiss(e, job.id)} style={{ background: "none", border: "none", color: "#6B6B73", fontSize: 11, cursor: "pointer", marginTop: 2 }}>dismiss</button>
              </div>
            </Card>
          ))}
          {filtered.length === 0 && <div style={{ textAlign: "center", padding: 40, color: "#6B6B73" }}>No matching jobs. Try adjusting filters or adding feeds.</div>}
        </div>
      )}
    </div>
  );
}

// ─── Tab: Proposal Generator ─────────────────────────────
function ProposalGenerator({ job }) {
  const [proposal, setProposal] = useState("");
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [added, setAdded] = useState(false);
  const [autoStatus, setAutoStatus] = useState("");
  const lastJobId = useState({ current: null })[0];

  const generate = async (autoMode = false) => {
    setGenerating(true);
    setCopied(false);
    setAdded(false);
    if (autoMode) setAutoStatus("Generating proposal...");
    try {
      const result = await api.generateProposal({ job });
      const text = result.proposal || result.error || "Failed";
      setProposal(text);
      // Auto-copy to clipboard
      if (result.proposal) {
        try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 3000); } catch (e) {}
        if (autoMode) setAutoStatus("Proposal copied to clipboard! Opening job...");
        // Auto-open job link in new tab
        if (job.url) {
          setTimeout(() => window.open(job.url, '_blank'), 500);
        }
        // Auto-add to pipeline
        try {
          await api.createClient({ name: job.client || "Unknown", project: job.title, stage: "proposal_sent", budget: job.est_value || 0, requirements: job.description, proposal: text, job_id: job.id });
          setAdded(true);
          if (autoMode) setAutoStatus("Done! Proposal copied + job opened + added to pipeline");
        } catch (e) {}
      }
    } catch (e) { setProposal("Error: " + e.message); setAutoStatus(""); }
    setGenerating(false);
  };

  // Auto-generate when a new job is selected
  useEffect(() => {
    if (job && job.id !== lastJobId.current) {
      lastJobId.current = job.id;
      setProposal("");
      setAutoStatus("");
      setAdded(false);
      generate(true);
    }
  }, [job?.id]);

  const copyProposal = () => { navigator.clipboard.writeText(proposal); setCopied(true); setTimeout(() => setCopied(false), 2000); };

  const openJob = () => { if (job.url) window.open(job.url, '_blank'); };

  if (!job) return <div style={{ textAlign: "center", padding: 60, color: "#6B6B73" }}><div style={{ fontSize: 48, marginBottom: 16 }}>📝</div><p style={{ fontSize: 15 }}>Click any job from Job Monitor — proposal auto-generates, copies, and opens the listing</p></div>;

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 20, color: "#E0E0E4" }}>Rapid Apply</h2>
        <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6B6B73" }}>Click job → auto-generate → auto-copy → auto-open → paste & submit</p>
      </div>
      {autoStatus && (
        <div style={{ background: "#C8FF3215", border: "1px solid #C8FF3240", borderRadius: 8, padding: "10px 16px", marginBottom: 16, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ color: "#C8FF32", fontSize: 13, fontWeight: 600 }}>{autoStatus}</span>
        </div>
      )}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, color: "#E0E0E4" }}>{job.title}</h3>
            <div style={{ fontSize: 13, color: "#6B6B73", marginTop: 4 }}>{job.client} • {job.source} • {job.budget}</div>
          </div>
          <ScoreBadge score={job.score} />
        </div>
        <p style={{ color: "#A0A0A8", fontSize: 13, lineHeight: 1.6, margin: "8px 0" }}>{job.description}</p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{(job.skills || []).map(s => <Badge key={s} color="#3B82F6">{s}</Badge>)}</div>
      </Card>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <Button onClick={() => generate(false)} disabled={generating}>{generating ? "⏳ Generating..." : "⟳ Regenerate"}</Button>
        {proposal && <>
          <Button variant="secondary" onClick={copyProposal}>{copied ? "✓ Copied!" : "📋 Copy"}</Button>
          {job.url && <Button variant="secondary" onClick={openJob}>↗ Open Job Listing</Button>}
          <Button variant="secondary" onClick={() => { copyProposal(); if (job.url) setTimeout(() => window.open(job.url, '_blank'), 200); }} style={{ background: "#C8FF3220", color: "#C8FF32", border: "1px solid #C8FF3240" }}>⚡ Copy + Open</Button>
          {!added && <Button variant="secondary" onClick={async () => { try { await api.createClient({ name: job.client || "Unknown", project: job.title, stage: "proposal_sent", budget: job.est_value || 0, requirements: job.description, proposal, job_id: job.id }); setAdded(true); } catch(e){} }}>📌 Add to Pipeline</Button>}
          {added && <Badge color="#10B981" size="md">✓ In Pipeline</Badge>}
        </>}
      </div>
      {proposal && <Card><TextArea value={proposal} onChange={setProposal} rows={16} style={{ border: "none", background: "transparent", padding: 0 }} /></Card>}
    </div>
  );
}

// ─── Tab: Client Pipeline ────────────────────────────────
function ClientPipeline() {
  const [clients, setClients] = useState([]);
  const [selectedClient, setSelectedClient] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newClient, setNewClient] = useState({ name: "", project: "", budget: "", requirements: "" });
  const [editNotes, setEditNotes] = useState("");
  const [stats, setStats] = useState(null);

  const load = async () => {
    const [c, s] = await Promise.all([api.getClients(), api.getStats()]);
    setClients(c); setStats(s);
  };
  useEffect(() => { load(); }, []);

  const updateClient = async (id, updates) => {
    const updated = await api.updateClient(id, updates);
    setClients(prev => prev.map(c => c.id === id ? updated : c));
    if (selectedClient?.id === id) setSelectedClient(updated);
  };

  const addClient = async () => {
    await api.createClient({ name: newClient.name, project: newClient.project, budget: parseInt(newClient.budget) || 0, requirements: newClient.requirements });
    setNewClient({ name: "", project: "", budget: "", requirements: "" }); setShowAdd(false); load();
  };

  const deleteClient = async (id) => {
    await api.deleteClient(id); setSelectedClient(null); load();
  };

  const pipelineCounts = PIPELINE_STAGES.map(s => ({ ...s, count: clients.filter(c => c.stage === s.id).length }));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div><h2 style={{ margin: 0, fontSize: 20, color: "#E0E0E4" }}>Client Pipeline</h2><p style={{ margin: "4px 0 0", fontSize: 13, color: "#6B6B73" }}>Track every client from lead to final payment</p></div>
        <Button onClick={() => setShowAdd(true)}>+ Add Client</Button>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        <StatCard label="Active Clients" value={stats?.totalClients || 0} />
        <StatCard label="Revenue Collected" value={`$${(stats?.revenue || 0).toLocaleString()}`} accent="#10B981" />
        <StatCard label="Pending" value={`$${(stats?.pending || 0).toLocaleString()}`} accent="#F59E0B" />
      </div>

      <div style={{ display: "flex", gap: 4, marginBottom: 20, overflowX: "auto", paddingBottom: 4 }}>
        {pipelineCounts.map(s => (
          <div key={s.id} style={{ flex: 1, minWidth: 90, textAlign: "center", padding: "8px 4px", borderRadius: 6, background: s.color + "15", border: `1px solid ${s.color}30` }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: s.color }}>{s.count}</div>
            <div style={{ fontSize: 10, color: s.color, textTransform: "uppercase", letterSpacing: "0.05em" }}>{s.label}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {clients.map(client => {
          const stage = PIPELINE_STAGES.find(s => s.id === client.stage);
          return (
            <Card key={client.id} onClick={() => { setSelectedClient(client); setEditNotes(client.notes || ""); }} style={{ cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 20px" }}>
              <div><div style={{ fontSize: 14, fontWeight: 600, color: "#E0E0E4" }}>{client.name}</div><div style={{ fontSize: 12, color: "#6B6B73", marginTop: 2 }}>{client.project}</div></div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <Badge color={stage?.color}>{stage?.label}</Badge>
                <span style={{ fontSize: 14, fontWeight: 600, color: "#C8FF32", fontFamily: "'Space Mono', monospace" }}>${(client.budget || 0).toLocaleString()}</span>
              </div>
            </Card>
          );
        })}
        {clients.length === 0 && <div style={{ textAlign: "center", padding: 40, color: "#6B6B73" }}>No clients yet. Add one manually or from a job proposal.</div>}
      </div>

      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add New Client">
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Input value={newClient.name} onChange={v => setNewClient({ ...newClient, name: v })} placeholder="Client name" />
          <Input value={newClient.project} onChange={v => setNewClient({ ...newClient, project: v })} placeholder="Project title" />
          <Input value={newClient.budget} onChange={v => setNewClient({ ...newClient, budget: v })} placeholder="Budget ($)" type="number" />
          <TextArea value={newClient.requirements} onChange={v => setNewClient({ ...newClient, requirements: v })} placeholder="Project requirements..." rows={4} />
          <Button onClick={addClient}>Add to Pipeline</Button>
        </div>
      </Modal>

      <Modal open={!!selectedClient} onClose={() => setSelectedClient(null)} title={selectedClient?.name || ""} width={650}>
        {selectedClient && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div><div style={{ fontSize: 11, color: "#6B6B73", textTransform: "uppercase", marginBottom: 4 }}>Project</div><div style={{ color: "#E0E0E4", fontSize: 14 }}>{selectedClient.project}</div></div>
            <div>
              <div style={{ fontSize: 11, color: "#6B6B73", textTransform: "uppercase", marginBottom: 6 }}>Stage</div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {PIPELINE_STAGES.map(s => <Button key={s.id} size="sm" variant={selectedClient.stage === s.id ? "primary" : "secondary"} onClick={() => updateClient(selectedClient.id, { stage: s.id })} style={selectedClient.stage === s.id ? { background: s.color, color: "#fff" } : {}}>{s.label}</Button>)}
              </div>
            </div>
            <div style={{ display: "flex", gap: 12 }}>
              <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: "#6B6B73", textTransform: "uppercase", marginBottom: 4 }}>Budget</div><div style={{ color: "#C8FF32", fontSize: 20, fontWeight: 700, fontFamily: "'Space Mono', monospace" }}>${(selectedClient.budget || 0).toLocaleString()}</div></div>
              <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: "#6B6B73", textTransform: "uppercase", marginBottom: 4 }}>Deposit</div><Input value={selectedClient.deposit || ""} type="number" onChange={v => updateClient(selectedClient.id, { deposit: parseInt(v) || 0 })} placeholder="0" /></div>
              <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: "#6B6B73", textTransform: "uppercase", marginBottom: 4 }}>Final</div><Input value={selectedClient.final_payment || ""} type="number" onChange={v => updateClient(selectedClient.id, { final_payment: parseInt(v) || 0 })} placeholder="0" /></div>
            </div>
            {selectedClient.requirements && <div><div style={{ fontSize: 11, color: "#6B6B73", textTransform: "uppercase", marginBottom: 4 }}>Requirements</div><div style={{ color: "#A0A0A8", fontSize: 13, lineHeight: 1.6, background: "#0A0A0B", padding: 12, borderRadius: 6 }}>{selectedClient.requirements}</div></div>}
            <div>
              <div style={{ fontSize: 11, color: "#6B6B73", textTransform: "uppercase", marginBottom: 4 }}>Notes</div>
              <TextArea value={editNotes} onChange={setEditNotes} rows={3} placeholder="Add notes..." />
              <Button variant="secondary" size="sm" style={{ marginTop: 8 }} onClick={() => updateClient(selectedClient.id, { notes: editNotes })}>Save Notes</Button>
            </div>
            <div style={{ borderTop: "1px solid #1E1E22", paddingTop: 12, display: "flex", justifyContent: "flex-end" }}>
              <Button variant="danger" size="sm" onClick={() => deleteClient(selectedClient.id)}>Delete Client</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

// ─── Tab: Templates ──────────────────────────────────────
function Templates() {
  const [selected, setSelected] = useState(null);
  const [copied, setCopied] = useState(false);

  const copyCmd = (t) => {
    navigator.clipboard.writeText(`claude "Build a ${t.name.toLowerCase()} using ${t.stack.join(", ")}. Client requirements: [paste requirements]. Deploy to Railway."`);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div>
      <div style={{ marginBottom: 20 }}><h2 style={{ margin: 0, fontSize: 20, color: "#E0E0E4" }}>Project Templates</h2><p style={{ margin: "4px 0 0", fontSize: 13, color: "#6B6B73" }}>Pre-built starters — feed into Claude Code with client requirements</p></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
        {PROJECT_TEMPLATES.map(t => (
          <Card key={t.id} onClick={() => setSelected(t)} style={{ cursor: "pointer" }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "#E0E0E4", marginBottom: 6 }}>{t.name}</div>
            <p style={{ color: "#6B6B73", fontSize: 12, lineHeight: 1.5, margin: "0 0 10px" }}>{t.desc}</p>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>{t.stack.map(s => <Badge key={s} color="#8B5CF6">{s}</Badge>)}</div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}><span style={{ color: "#C8FF32", fontWeight: 600 }}>{t.est}</span><span style={{ color: "#6B6B73" }}>{t.time}</span></div>
          </Card>
        ))}
      </div>
      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected?.name || ""}>
        {selected && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <p style={{ color: "#A0A0A8", fontSize: 13, margin: 0 }}>{selected.desc}</p>
            <div><div style={{ fontSize: 11, color: "#6B6B73", textTransform: "uppercase", marginBottom: 6 }}>Stack</div><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{selected.stack.map(s => <Badge key={s} color="#8B5CF6" size="md">{s}</Badge>)}</div></div>
            <div style={{ display: "flex", gap: 24 }}>
              <div><div style={{ fontSize: 11, color: "#6B6B73", textTransform: "uppercase", marginBottom: 4 }}>Price Range</div><div style={{ color: "#C8FF32", fontSize: 18, fontWeight: 700 }}>{selected.est}</div></div>
              <div><div style={{ fontSize: 11, color: "#6B6B73", textTransform: "uppercase", marginBottom: 4 }}>Timeline</div><div style={{ color: "#E0E0E4", fontSize: 18, fontWeight: 700 }}>{selected.time}</div></div>
            </div>
            <Card style={{ background: "#0A0A0B" }}>
              <div style={{ fontSize: 11, color: "#6B6B73", textTransform: "uppercase", marginBottom: 8 }}>Claude Code Command</div>
              <code style={{ color: "#C8FF32", fontSize: 13, fontFamily: "'Space Mono', monospace", lineHeight: 1.6, wordBreak: "break-all" }}>claude "Build a {selected.name.toLowerCase()} using {selected.stack.join(", ")}. Client requirements: [paste requirements]. Deploy to Railway."</code>
            </Card>
            <Button onClick={() => copyCmd(selected)}>{copied ? "✓ Copied!" : "📋 Copy Claude Code Command"}</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}

// ─── Tab: Invoices & Payments ────────────────────────────
function Invoices() {
  const [invoices, setInvoices] = useState([]);
  const [clients, setClients] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newInv, setNewInv] = useState({ clientId: "", type: "deposit", amount: "", note: "" });

  const load = async () => {
    const [inv, cl] = await Promise.all([api.getInvoices(), api.getClients()]);
    setInvoices(inv); setClients(cl);
  };
  useEffect(() => { load(); }, []);

  const createInvoice = async () => {
    const client = clients.find(c => c.id === newInv.clientId);
    if (!client) return;
    const amount = parseInt(newInv.amount) || Math.round(client.budget * 0.5);
    await api.createInvoice({ client_id: client.id, client_name: client.name, project: client.project, type: newInv.type, amount, note: newInv.note });
    setShowCreate(false); setNewInv({ clientId: "", type: "deposit", amount: "", note: "" }); load();
  };

  const markPaid = async (id) => { await api.markPaid(id); load(); };

  const totalPaid = invoices.filter(i => i.status === "paid").reduce((s, i) => s + i.amount, 0);
  const totalPending = invoices.filter(i => i.status === "pending").reduce((s, i) => s + i.amount, 0);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div><h2 style={{ margin: 0, fontSize: 20, color: "#E0E0E4" }}>Invoices & Payments</h2><p style={{ margin: "4px 0 0", fontSize: 13, color: "#6B6B73" }}>SnipeLink payment tracking — 50/50 split</p></div>
        <Button onClick={() => setShowCreate(true)}>+ Create Invoice</Button>
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        <StatCard label="Total Paid" value={`$${totalPaid.toLocaleString()}`} accent="#10B981" />
        <StatCard label="Pending" value={`$${totalPending.toLocaleString()}`} accent="#F59E0B" />
        <StatCard label="Invoices" value={invoices.length} accent="#3B82F6" />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {invoices.map(inv => (
          <Card key={inv.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 20px" }}>
            <div><div style={{ fontSize: 14, fontWeight: 600, color: "#E0E0E4" }}>{inv.client_name}</div><div style={{ fontSize: 12, color: "#6B6B73", marginTop: 2 }}>{inv.project} • {inv.type === "deposit" ? "50% Deposit" : "Final Payment"}</div></div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Badge color={inv.status === "paid" ? "#10B981" : "#F59E0B"}>{inv.status === "paid" ? "PAID" : "PENDING"}</Badge>
              <span style={{ fontSize: 16, fontWeight: 700, color: "#C8FF32", fontFamily: "'Space Mono', monospace" }}>${inv.amount.toLocaleString()}</span>
              {inv.status === "pending" && (
                <div style={{ display: "flex", gap: 4 }}>
                  <Button variant="secondary" size="sm" onClick={() => navigator.clipboard.writeText(inv.payment_link)}>🔗 Link</Button>
                  <Button size="sm" onClick={() => markPaid(inv.id)}>✓ Paid</Button>
                </div>
              )}
            </div>
          </Card>
        ))}
        {invoices.length === 0 && <div style={{ textAlign: "center", padding: 40, color: "#6B6B73" }}>No invoices yet.</div>}
      </div>
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Create Invoice">
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Select value={newInv.clientId} onChange={v => setNewInv({ ...newInv, clientId: v })} options={[{ value: "", label: "Select client..." }, ...clients.map(c => ({ value: c.id, label: `${c.name} — ${c.project}` }))]} style={{ width: "100%" }} />
          <Select value={newInv.type} onChange={v => setNewInv({ ...newInv, type: v })} options={[{ value: "deposit", label: "50% Deposit" }, { value: "final", label: "Final Payment" }]} style={{ width: "100%" }} />
          <Input value={newInv.amount} onChange={v => setNewInv({ ...newInv, amount: v })} placeholder={newInv.clientId ? `Auto: $${Math.round((clients.find(c => c.id === newInv.clientId)?.budget || 0) * 0.5)}` : "Select client first"} type="number" />
          <Input value={newInv.note} onChange={v => setNewInv({ ...newInv, note: v })} placeholder="Optional note..." />
          <Button onClick={createInvoice} disabled={!newInv.clientId}>Generate Invoice & Payment Link</Button>
        </div>
      </Modal>
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("jobs");
  const [selectedJob, setSelectedJob] = useState(null);

  const tabs = [
    { id: "jobs", label: "Job Monitor", icon: "📡" },
    { id: "proposal", label: "Proposals", icon: "📝" },
    { id: "pipeline", label: "Pipeline", icon: "🔄" },
    { id: "templates", label: "Templates", icon: "📦" },
    { id: "invoices", label: "Invoices", icon: "💰" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#0A0A0B", color: "#E0E0E4", fontFamily: "'DM Sans', sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet" />
      <div style={{ borderBottom: "1px solid #1E1E22", padding: "12px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, background: "#0A0A0B", zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 32, height: 32, borderRadius: 6, background: "linear-gradient(135deg, #C8FF32, #8BDB00)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 700, color: "#0A0A0B" }}>⚡</div>
          <div><div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.01em" }}>Agency Command</div><div style={{ fontSize: 10, color: "#6B6B73", fontFamily: "'Space Mono', monospace" }}>CLAUDE CODE × FREELANCE</div></div>
        </div>
        <div style={{ display: "flex", gap: 2 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{ background: tab === t.id ? "#1E1E22" : "transparent", border: tab === t.id ? "1px solid #2A2A2E" : "1px solid transparent", borderRadius: 6, padding: "6px 14px", color: tab === t.id ? "#C8FF32" : "#6B6B73", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans', sans-serif", transition: "all 0.15s ease", display: "flex", alignItems: "center", gap: 6 }}>
              <span>{t.icon}</span><span>{t.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "24px 20px" }}>
        {tab === "jobs" && <JobMonitor onSelectJob={job => { setSelectedJob(job); setTab("proposal"); }} />}
        {tab === "proposal" && <ProposalGenerator job={selectedJob} />}
        {tab === "pipeline" && <ClientPipeline />}
        {tab === "templates" && <Templates />}
        {tab === "invoices" && <Invoices />}
      </div>
    </div>
  );
}

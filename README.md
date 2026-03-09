# ⚡ Agency Command

AI-powered freelance agency management dashboard. Built for speed with Claude Code.

## Features
- **Job Monitor** — RSS feed scraping + AI skill-match scoring
- **Proposal Generator** — Claude API generates tailored proposals
- **Client Pipeline** — Lead → Deposit → Building → Delivered → Paid
- **Project Templates** — Pre-built starters with Claude Code commands
- **Invoices** — SnipeLink payment links, 50/50 deposit split

## Stack
- Frontend: React + Vite
- Backend: Express + SQLite (better-sqlite3)
- AI: Claude API (Sonnet)
- Deploy: Railway (Docker)

## Setup
```bash
npm install
cp .env.example .env  # Add your ANTHROPIC_API_KEY
npm run db:reset       # Seed sample data
npm run dev            # Frontend :5173 + API :3001
```

## Deploy to Railway
```bash
railway login
railway init
railway up
# Set ANTHROPIC_API_KEY in Railway dashboard
```

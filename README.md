# Lota

Agent communication over GitHub Issues. Zero infrastructure.

## Get Started

Paste this into Claude Code:

```
Set up Lota:
1. git clone https://github.com/xliry/lota.git ~/.lota/lota && cd ~/.lota/lota && npm install && npm run build
2. Read ~/.lota/lota/SETUP.md and follow each step conversationally
```

That's it. The agent handles the rest.

## After Setup

- `/lota-hub` — create and manage tasks
- `/lota-agent` — start autonomous agent mode

## How It Works

GitHub Issues = task database. Labels = state machine. No server, no database.

```
You ── create task ──→ GitHub Issue ──→ Agent picks it up
You ←── report ──────← GitHub Issue ←── Agent completes it
```

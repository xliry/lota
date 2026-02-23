---
name: lota-agent
description: >
  Start the autonomous LOTA agent in the background. The agent polls GitHub Issues
  for assigned tasks, then spawns Claude Code to plan, execute, and complete them.
  Use when the user says "lota-agent", "start agent", "otonom mod", "agent başlat",
  or wants to run the autonomous agent.
allowed-tools: Bash(node *), Bash(cd * && node *), Bash(kill *), Bash(sleep *), Bash(ps *), Bash(pkill *)
---

# LOTA Agent Skill

## What to do

Run this EXACT sequence. Do NOT run any other commands.

### Step 1: Kill any existing agent

```bash
pkill -f "node.*daemon" 2>/dev/null; true
```

Note: This may show "exit code 144" — that's normal (process was killed). Ignore it.

### Step 2: Start agent in background

Run with `run_in_background: true` and `timeout: 600000`:

```bash
cd ~/lota-mcp && node dist/daemon.js --interval 15 2>&1
```

### Step 3: Wait and read log file

```bash
sleep 5
```

Then use the **Read** tool to read `~/.lota/agent.log`.

### Step 4: Report to user

Show the log content and tell the user:
- The agent name (from banner)
- The poll interval
- "Agent is running. Check logs anytime: `cat ~/.lota/agent.log`"

That's ALL. Do NOT run diagnostics, version checks, or anything else.

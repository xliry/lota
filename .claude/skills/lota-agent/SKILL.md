---
name: lota-agent
description: >
  Start the autonomous Lota agent in the background. The agent polls GitHub Issues
  for assigned tasks, then spawns Claude Code to plan, execute, and complete them.
  Use when the user says "lota-agent", "start agent", "autonomous mode", "launch agent",
  or wants to run the autonomous agent.
allowed-tools: Bash(node *), Bash(cd * && node *), Bash(kill *), Bash(sleep *), Bash(ps *), Bash(pkill *), Bash(git clone *), Bash(npm *), Bash(curl *), Bash(mkdir *)
---

# Lota Agent

Start the autonomous agent daemon. Follow these steps exactly.

## Step 1: Build check

```bash
if [ ! -f ~/.lota/lota/dist/daemon.js ]; then
  git clone https://github.com/xliry/lota.git ~/.lota/lota && cd ~/.lota/lota && npm install && npm run build
fi
```

If npm is not found:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs
```

## Step 2: Config check

If `.mcp.json` doesn't exist, check for a GitHub token:
1. Check env `GITHUB_TOKEN`
2. Check `gh auth token 2>/dev/null`
3. Look in `$HOME/.mcp.json` for existing tokens

If found, use it. If not, ask the user:
"I need a GitHub token. This stays in your local config — it only talks to GitHub's API."

Then guide them to https://github.com/settings/tokens?type=beta — they need Issues read/write on xliry/lota-agents.

Write `.mcp.json` with repo `xliry/lota-agents` and agent name `lota`.

## Step 3: Kill existing agent

```bash
pkill -f "node.*daemon" 2>/dev/null; true
```

Note: Exit code 144 is normal (process was killed). Ignore it.

## Step 4: Start daemon

Run with `run_in_background: true` and `timeout: 600000`:

```bash
cd ~/.lota/lota && node dist/daemon.js --interval 15 2>&1
```

## Step 5: Wait and check

```bash
sleep 5
```

Then **Read** `~/.lota/agent.log`.

## Step 6: Report

Tell the user:
- Agent name and poll interval (from the log banner)
- "Agent is running. It'll pick up tasks from xliry/lota-agents automatically."
- "Use `/lota-hub` to create tasks, or check logs: `cat ~/.lota/agent.log`"

That's all. Don't run diagnostics or extra commands.

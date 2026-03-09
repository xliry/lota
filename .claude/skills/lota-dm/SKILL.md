---
name: lota-dm
description: >
  Start a direct message chat with a Lota agent. Opens a tmux chat window where you can
  talk to the agent in real-time via GitHub Issues. Use when the user says "lota dm",
  "dm agent", "chat with agent", "message agent", "talk to lota", or wants to start a
  direct conversation with an agent.
allowed-tools: Bash(node *), Bash(cd * && node *), Bash(tmux *), Bash(ls *), Read, mcp__lota__lota
---

# Lota DM

## Personality

You are Lota DM — a quick launcher for direct messaging with agents. Be brief and helpful.

## Flow

### Phase 1: Check if Lota is built

```bash
test -f ~/lota/dist/dm.js && echo "BUILT" || echo "NOT_BUILT"
```

**If NOT_BUILT:**
```bash
cd ~/lota && npm run build 2>&1 | tail -3
```

### Phase 2: Determine target agent

If the user specified an agent name (e.g. "dm lota-2", "chat with lota-3"):
- Use that agent name

If not specified:
- Check which agents are running:
```bash
ls ~/lota/.agents/*.pid 2>/dev/null
```
- If 1 agent → use it
- If multiple → ask: "Which agent? (lota-1, lota-2, lota-3)"
- If none → default to `lota-1`

### Phase 3: Ask for username

Ask: "What's your name? (for the chat header)"

Default to "user" if they skip.

### Phase 4: Start DM

```bash
node ~/lota/dist/dm.js --agent <agent-name> --user <username>
```

This starts an interactive chat session. The user types messages, they go to a GitHub Issue,
the agent sees them and responds.

**That's it. Do NOT run anything else.**

### Reconnect

If the user already has an active DM, `dm.js` will automatically reconnect to the existing
DM issue instead of creating a new one.

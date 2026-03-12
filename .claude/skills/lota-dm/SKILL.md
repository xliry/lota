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
- Default to `lota-chat`

### Phase 3: Ask for username

Ask: "What's your name? (for the chat header)"

Default to "user" if they skip.

### Phase 4: Start DM

Check if lota-chat tmux session is already running:

```bash
tmux has-session -t lota-chat 2>/dev/null && echo "TMUX_RUNNING" || echo "TMUX_NONE"
```

**If TMUX_RUNNING:**
- Show: "lota-chat is already running."
- Show: `Watch: tmux a -t lota-chat`
- Then start the DM client:

```bash
node ~/lota/dist/dm.js --agent <agent-name> --user <username>
```

**If TMUX_NONE:**
- Start the DM client directly:

```bash
node ~/lota/dist/dm.js --agent <agent-name> --user <username>
```

- After starting, show: `Watch: tmux a -t lota-chat`

This starts an interactive chat session. The user types messages, they go to a GitHub Issue,
the agent sees them and responds.

**That's it. Do NOT run anything else.**

### Reconnect

If the user already has an active DM, `dm.js` will automatically reconnect to the existing
DM issue instead of creating a new one.

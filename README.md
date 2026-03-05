# Lota

Autonomous agent that picks up tasks from GitHub Issues, plans them, waits for your approval, then executes.

## Quick Start

Open Claude Code and paste this:

```
git clone https://github.com/xliry/lota.git ~/lota
cd ~/lota && npm install && npm run build
ln -sf ~/lota/.claude/skills/lota-agent ~/.claude/skills/lota-agent
ln -sf ~/lota/.claude/skills/lota-hub ~/.claude/skills/lota-hub
```

Then restart Claude Code.

After restart:
- `/lota-agent` — set up GitHub connection + start the agent
- `/lota-hub` — create tasks, approve plans, check progress

## How It Works

1. You create a task (via `/lota-hub` or a GitHub Issue)
2. Lota plans it and posts the plan for your review
3. You approve → Lota executes → reports back
4. All communication happens through GitHub Issue comments

## Task Lifecycle

```
assigned → planned → approved → in-progress → completed
```

## License

MIT

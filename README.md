# Lota

**Agent-to-agent communication over GitHub Issues. Zero infrastructure.**

Lota turns GitHub Issues into a task queue for AI agents. No servers, no databases — just GitHub.

```
You ── create task ──→ GitHub Issue ──→ Agent picks it up
You ←── report ──────← GitHub Issue ←── Agent completes it
```

## How It Works

1. A human (or agent) creates a task, which becomes a GitHub Issue
2. Labels act as a state machine tracking task lifecycle
3. An autonomous daemon polls for assigned tasks and spawns Claude Code to execute them
4. Results are reported back as issue comments and label transitions

**Task Lifecycle:**

```
assigned → planned → approved → in-progress → completed
```

## Quick Start

```bash
# 1. Clone
git clone <repo-url> ~/.lota/lota
cd ~/.lota/lota

# 2. Install & build
npm install
npm run build

# 3. Set your GitHub token
export GITHUB_TOKEN="ghp_..."

# 4. Add MCP config to your project's .mcp.json
cat <<'EOF' >> .mcp.json
{
  "mcpServers": {
    "lota": {
      "command": "node",
      "args": ["~/.lota/lota/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_...",
        "GITHUB_REPO": "owner/repo",
        "AGENT_NAME": "my-agent"
      }
    }
  }
}
EOF

# 5. Install skills (optional)
cp skills/* ~/.claude/skills/

# 6. Restart Claude Code
```

## Setup

### Prerequisites

- Node.js
- A GitHub repository for task storage
- A GitHub personal access token with repo access

### Configuration

| Variable | Required | Description |
|---|---|---|
| `GITHUB_TOKEN` | Yes | GitHub personal access token |
| `GITHUB_REPO` | Yes | Target repository (`owner/repo`) |
| `AGENT_NAME` | Yes | Unique name for this agent |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token (supervised mode) |
| `TELEGRAM_CHAT_ID` | No | Telegram chat ID (supervised mode) |

## Usage

### MCP Tool (Claude Code Integration)

Lota exposes a single `lota()` tool via MCP stdio transport. Once configured in `.mcp.json`, Claude Code can create, query, and manage tasks directly.

### Skills

| Skill | Description |
|---|---|
| `/lota-hub` | Dashboard for humans to create and manage tasks |
| `/lota-agent` | Start the autonomous daemon |

### CLI

```bash
# Start the MCP server
lota

# Start the autonomous daemon
lota-agent

# Daemon options
lota-agent --interval 30        # Poll every 30 seconds
lota-agent --once               # Run once and exit
lota-agent --model sonnet       # Specify Claude model
lota-agent --mode auto          # Auto mode (default)
lota-agent --mode supervised    # Require Telegram approval
lota-agent --config ./cfg.json  # Custom config file
```

**Daemon Modes:**

- **auto** — picks up tasks and executes them directly
- **supervised** — sends a Telegram notification and waits for human approval before execution

## API Reference

All routes are accessed through the `lota()` MCP tool.

### Tasks

```
GET  /tasks                  → List my assigned tasks
GET  /tasks?status=X         → Filter tasks by status
GET  /tasks/:id              → Task detail + comments
POST /tasks                  → Create a task
POST /tasks/:id/plan         → Save execution plan
POST /tasks/:id/status       → Update task status
POST /tasks/:id/complete     → Report completion
POST /tasks/:id/comment      → Add a comment
GET  /sync                   → All pending work
```

### Request Bodies

**Create task** — `POST /tasks`
```json
{
  "title": "Implement auth module",
  "assign": "agent-name",
  "priority": "high",
  "body": "Detailed description...",
  "workspace": "/path/to/project"
}
```

**Save plan** — `POST /tasks/:id/plan`
```json
{
  "goals": ["Implement login endpoint", "Add JWT validation"],
  "affected_files": ["src/auth.ts", "src/middleware.ts"],
  "effort": "medium"
}
```

**Update status** — `POST /tasks/:id/status`
```json
{
  "status": "in-progress"
}
```

**Report completion** — `POST /tasks/:id/complete`
```json
{
  "summary": "Implemented auth with JWT tokens",
  "modified_files": ["src/auth.ts"],
  "new_files": ["src/middleware.ts"]
}
```

**Add comment** — `POST /tasks/:id/comment`
```json
{
  "content": "Blocked on missing API credentials"
}
```

## Architecture

Lota has three components:

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  MCP Server │     │  GitHub API  │     │    Daemon    │
│  index.ts   │────→│  github.ts   │←────│  daemon.ts   │
│             │     │              │     │              │
│ Claude Code │     │ Issues as DB │     │ Polls + runs │
│ connects    │     │ Labels =     │     │ Claude Code  │
│ via stdio   │     │ state machine│     │ subprocess   │
└─────────────┘     └──────────────┘     └──────────────┘
```

- **`src/index.ts`** — MCP server exposing the `lota()` tool over stdio transport
- **`src/github.ts`** — GitHub API layer. CRUD operations on issues. Labels encode state. Metadata stored as versioned HTML comments
- **`src/daemon.ts`** — Autonomous daemon that polls GitHub, spawns Claude Code subprocesses. Supports auto and supervised modes with subagent spawning

### Key Design Decisions

- **GitHub Issues as database** — no infrastructure to maintain
- **Labels as state machine** — status transitions are atomic label swaps
- **HTML comments for metadata** — plans and structured data live inside issue bodies without cluttering the visible content
- **Rate limiting with retry/backoff** — respects GitHub API limits

## License

MIT

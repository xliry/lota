# Lota Architecture Report

Lota is an autonomous agent system that manages tasks via GitHub Issues. Agents poll for work, spawn Claude Code subprocesses to execute tasks, and coordinate through a shared GitHub Issues backend. The system supports multiple concurrent agents, direct messaging, and an orchestrator layer.

## Source Files (18 files in `src/`)

### Entry Points

| File | Lines | Role |
|------|-------|------|
| `index.ts` | 55 | **MCP Server** — Registers a single `lota()` tool via the Model Context Protocol SDK. Connects over stdio. All API routing is delegated to `github.ts`. |
| `daemon.ts` | 494 | **Agent Daemon** — Main polling loop. Parses CLI args, manages PID files, runs the `checkForWork → runClaude → handleCycleResult` lifecycle. Starts chat and orchestrator loops as sidecars. |
| `dm.ts` | 297 | **DM Client** — Interactive readline-based chat client. Creates/resumes GitHub Issues prefixed with `DM:` and polls for new messages. Standalone CLI entry point (`lota-dm`). |
| `live.ts` | 501 | **Live Hub** — Interactive terminal dashboard. Polls `/sync?all=true`, detects state changes (new tasks, status transitions, comments), and prints real-time updates with tmux notifications. Supports focus mode for quick replies. |

### Core Engine

| File | Lines | Role |
|------|-------|------|
| `github.ts` | 524 | **API Layer & Router** — REST-style dispatcher (`lota()` function). Wraps the GitHub Issues API with retry/backoff, rate limit tracking, label-based status management, and metadata stored in HTML comments (`<!-- lota:v1:type {...} -->`). Handles task CRUD, plan/report storage, completion with idempotency, and dependency unblocking. |
| `process.ts` | 311 | **Claude Subprocess Manager** — Spawns `claude` CLI as a child process with `--print --output-format stream-json`. Manages workspace resolution, branch/worktree setup, environment sanitization, Claude settings merging, and post-completion auto-merge. |
| `prompt.ts` | 245 | **Prompt Builder** — Constructs the system prompt for each Claude invocation based on work phase (plan/execute/single/comments). Handles task body sanitization, workspace detection, build command resolution, and conditional rule injection (bounty vs campaign tasks). |
| `comments.ts` | 216 | **Work Detector** — The `checkForWork()` function that drives the main loop. Polls `/sync`, detects new comments via persisted baselines, auto-unblocks tasks with met dependencies, and determines which phase to run next (comments → approved/execute → assigned/plan). |
| `types.ts` | 70 | **Shared Types** — TypeScript interfaces: `AgentConfig`, `WorkData`, `TaskInfo`, `CommentUpdate`, `OrchestratorSnapshot`, `OrchestratorDelta`, `ClaudeEvent`. |

### Communication Loops

| File | Lines | Role |
|------|-------|------|
| `chat.ts` | 212 | **Chat Loop** — Runs on a 3-second interval (configurable). Polls for DM issues (`DM:` prefix), spawns a Claude subprocess to respond to new messages, and notifies active DMs when tasks complete. |
| `chat-prompt.ts` | 58 | **Chat Prompt Builder** — Constructs the conversational prompt for DM responses. Includes last 10 messages, agent capabilities (codebase exploration, task creation, plan approval), and task creation rules. |
| `orchestrator.ts` | 315 | **Orchestrator Loop** — Runs on a 60-second interval. Computes deltas between snapshots (new tasks, status changes, completions, agent online/offline). Invokes Claude to autonomously approve plans, reassign tasks, and send briefings to the active DM channel. Uses leader election (alphabetically lowest agent name). |
| `orchestrator-prompt.ts` | 65 | **Orchestrator Prompt Builder** — Constructs the orchestrator briefing prompt with current task state grouped by status, computed delta, and allowed actions. |

### Infrastructure

| File | Lines | Role |
|------|-------|------|
| `git.ts` | 218 | **Git Operations** — Safe wrappers around `git` CLI commands via `execSync`. Never throws — returns `{ok, output}`. Covers checkout, branch CRUD, merge, rebase, push (with token auth), worktree management, and conflict detection. |
| `worktree.ts` | 185 | **Worktree Isolation** — Creates per-agent git worktrees at `.worktrees/<agentName>` for parallel execution. Handles merge-back with rebase fallback on conflicts, push retry on race conditions, and stale worktree cleanup. |
| `recovery.ts` | 137 | **Crash Recovery** — Startup recovery resets stale in-progress tasks (up to 3 retries, then marks failed). Runtime recovery detects tasks stuck in-progress for >5 minutes and resets them. Cleans up stale worktrees. |
| `telegram.ts` | 120 | **Telegram Integration** — Sends notifications and receives inline button responses for supervised mode. Handles chat ID setup via `/start` polling, task approval/rejection buttons, and 30-minute approval timeout. |
| `logging.ts` | 179 | **Logging & Monitoring** — File-based log rotation (5MB cap, 2 rotations). Colored console output. Memory monitoring with automatic GC hints. RSS-based OOM protection (exit code 42). Stream-JSON event formatter for Claude subprocess output. |

## MCP Tool Architecture

Lota exposes a **single MCP tool** (`lota()`) with REST-style routing:

```
lota(method: "GET"|"POST"|..., path: string, body?: object) → result
```

The `index.ts` MCP server registers this tool, and `github.ts` dispatches it:

```
method + path pattern          → handler function
─────────────────────────────────────────────────
GET  /sync                     → sync()         — all pending work, grouped by status
GET  /tasks                    → getTasks()     — filtered by agent label
GET  /tasks/:id                → getTask()      — full detail + comments + plan/report
POST /tasks                    → createTask()   — creates issue with labels
POST /tasks/:id/plan           → savePlan()     — posts plan as comment with metadata
POST /tasks/:id/status         → updateStatus() — swaps status: label atomically
POST /tasks/:id/complete       → completeTask() — posts report, swaps label, closes issue
POST /tasks/:id/comment        → addComment()   — posts comment to issue
POST /tasks/:id/assign         → assignTask()   — swaps agent: label
PATCH /tasks/:id/meta          → patchTaskMeta() — updates metadata in issue body
```

**Data model:** GitHub Issues serve as the task database. Status, agent assignment, and priority are encoded as labels (`status:in-progress`, `agent:lota-1`, `priority:high`). Structured data (plans, reports, workspace, dependencies) is stored in HTML comment metadata tags within issue bodies/comments: `<!-- lota:v1:plan {"goals":[...]} -->`.

## Agent Polling Loop Lifecycle

```
daemon.main()
  │
  ├── parseArgs() → AgentConfig
  ├── checkAndCleanStalePid() / writePidFile()
  ├── recoverStaleTasks()           ← startup crash recovery
  ├── startChatLoop()               ← 3s interval sidecar
  ├── startOrchestratorLoop()       ← 60s interval sidecar
  │
  └── while (!stopped)
        │
        ├── checkForWork(config)     ← comments.ts
        │     ├── lota("GET", "/sync")
        │     ├── auto-unblock tasks with met dependencies
        │     ├── detectCommentUpdates() via persisted baselines
        │     └── returns WorkData { phase, tasks, commentUpdates }
        │           or null (no work → adaptive backoff: 15s → 60s → 150s → 300s)
        │
        ├── logWorkActivity()
        │
        ├── runClaude(config, work)   ← process.ts
        │     ├── cleanEnvironment()
        │     ├── setupBranchStrategy()  ← branch or worktree
        │     ├── buildPrompt()          ← prompt.ts
        │     ├── spawn("claude", [...args])
        │     ├── stream-json parsing → formatEvent()
        │     └── handlePostCompletion() ← auto-merge branch back
        │
        └── handleCycleResult(code, work, elapsed, config)
              ├── code 0 + plan phase → auto-approve (auto mode) or tgWaitForApproval (supervised)
              ├── rate limited → backoff 2/5/15/30 min tiers
              └── crash → retry up to 3x, then mark failed
```

## Architectural Patterns

### 1. Chat Loop (DM System)
- GitHub Issues with `DM:` title prefix serve as persistent chat channels
- `chat.ts` polls every 3 seconds for new messages on DM issues
- Spawns a separate Claude subprocess per DM response (stateless per message)
- Chat baselines track seen message counts to avoid re-processing
- Completion notifications are batched and forwarded to active DM channels
- The `dm.ts` CLI client provides a readline-based terminal UI for users

### 2. Orchestrator Loop (Autonomous Manager)
- Runs every 60 seconds on the **leader agent** (alphabetically lowest name wins)
- Builds snapshots of all task state across all agents via `/sync?all=true`
- Computes deltas: new tasks, status transitions, new comments, agent online/offline
- Invokes Claude with the delta to autonomously approve plans, reassign tasks, and post briefing summaries to the active DM channel
- Re-fetches snapshot after action to prevent false deltas on next poll

### 3. Worktree Isolation
- Optional (`--worktree` flag) per-agent git worktrees at `.worktrees/<agentName>`
- Enables parallel agents to work on the same repo without branch conflicts
- Merge-back strategy: direct merge → rebase fallback → manual conflict report
- Push retry (up to 3 attempts) with fresh pull on race conditions
- Default (without `--worktree`): simple branch strategy (`task-<id>-<agent>`)

### 4. Recovery System
- **Startup recovery** (`recoverStaleTasks`): On daemon start, finds in-progress tasks assigned to this agent. Resets to assigned with retry counter in issue body metadata. After 3 retries, marks failed.
- **Runtime recovery** (`checkRuntimeStaleTasks`): Periodically (every 10 poll cycles), detects tasks stuck in-progress for >5 minutes and resets them.
- **Crash retry** (in `handleCycleResult`): Tracks per-task crash counts in memory. After 3 consecutive crashes, marks failed with a comment.
- **Rate limit backoff**: Tiered backoff (2→5→15→30 min) on consecutive rate limits. Tasks are reset to assigned for retry.

## Observations and Potential Improvements

### Code Duplication
- `cleanEnvironment()` is defined identically in `process.ts`, `chat.ts`, and `orchestrator.ts`. Could be extracted to a shared utility.
- `ensureClaudeSettings()` / `mergeClaudeSettings()` is near-identical in `chat.ts`, `orchestrator.ts`, and `process.ts`.
- `loadCredentials()` is duplicated between `dm.ts` and `live.ts` (with identical logic).

### Architecture Observations
- **Single-tool MCP design** is elegant — one `lota()` tool handles all API interaction, keeping the agent's tool surface minimal while supporting rich REST-style routing.
- **GitHub Issues as database** is creative but has inherent limitations: no transactions, eventual consistency on label swaps, rate limit pressure from frequent polling.
- **Stateless Claude invocations** for chat/orchestrator mean no conversation memory between responses. The chat prompt includes last 10 messages as context, but long conversations lose history.
- **Leader election** for the orchestrator is simple (alphabetical name) but not failure-aware — if the leader crashes, the next agent picks up only when the PID file is cleaned.
- **Adaptive polling backoff** (15s → 5min) reduces GitHub API pressure during idle periods, but the chat loop's fixed 3s interval could be a bottleneck with many agents.

### Potential Improvements
- **Extract shared utilities**: `cleanEnvironment()`, Claude settings merge, and credential loading could move to a shared module.
- **Connection pooling**: Multiple `lota("GET", "/sync")` calls happen in parallel (main loop + chat loop + orchestrator). A shared cache with TTL could reduce API calls.
- **Chat loop backoff**: The 3-second fixed interval could adopt the same adaptive backoff as the main loop when no DMs are active.
- **Structured logging**: The current mix of console.log + file write could benefit from a structured logger with log levels, making it easier to filter and analyze.
- **Worktree + branch strategy unification**: The two code paths (worktree in `worktree.ts` vs simple branch in `process.ts`) share merge logic that could be consolidated.

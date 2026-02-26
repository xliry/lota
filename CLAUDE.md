# Lota

You are connected to Lota via the `lota` MCP tool.
Lota enables agent communication using GitHub Issues — zero infrastructure.

## Your Capabilities

- **MCP Server**: `lota()` tool for all API calls (tasks, comments, status updates)
- **Skill: /lota-hub** — Interactive dashboard for creating and managing tasks
- **Skill: /lota-agent** — Start autonomous daemon that polls and executes tasks
- **Setup guide**: `~/.lota/lota/SETUP.md` — Walk users through configuration

## Quick Reference

```
lota("GET", "/sync")                          — check for pending work
lota("GET", "/tasks")                         — list assigned tasks
lota("GET", "/tasks/<id>")                    — task details + comments
lota("POST", "/tasks", {title, assign?, priority?, body?})  — create task
lota("POST", "/tasks/<id>/status", {status})  — update status
lota("POST", "/tasks/<id>/complete", {summary}) — mark complete
lota("POST", "/tasks/<id>/comment", {content}) — add comment
```

## Agent Workflow

1. Check work: `lota("GET", "/sync")`
2. Plan: `lota("POST", "/tasks/{id}/plan", {goals, affected_files, effort})`
3. Start: `lota("POST", "/tasks/{id}/status", {status: "in-progress"})`
4. Do the work
5. Complete: `lota("POST", "/tasks/{id}/complete", {summary: "..."})`

## Config

- `GITHUB_TOKEN` — GitHub PAT with Issues read/write
- `GITHUB_REPO` — "owner/repo" format
- `AGENT_NAME` — agent identity (default: "lota")

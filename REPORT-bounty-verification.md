# Bounty Verification System — Post-Mortem Report

## Context

Built an autonomous bounty verification pipeline for [peteromallet/desloppify#204](https://github.com/peteromallet/desloppify/issues/204). 253 comments from 70 authors on a code quality bounty — each claiming to have found poor engineering in the desloppify codebase. Our system ingested, filtered, and verified all of them autonomously using Lota agents.

## Results Summary

| Metric | Count |
|--------|-------|
| Total comments ingested | 253 |
| Auto-filtered (noise/spam/duplicates) | 154 |
| Submissions verified by agent | 99 |
| PRs opened to upstream | 102 (open) + 23 (closed from early bugs) |
| Scoreboard entries | 99 |
| YES verdicts | 19 |
| YES_WITH_CAVEATS verdicts | 29 |
| NO verdicts | 51 |
| Acceptance rate | 48.5% (YES + YES_WITH_CAVEATS) |

## Architecture

### Pipeline Overview

```
GitHub comments (253)
  -> Ingest (bounty-inbox.json)
  -> Auto-filter (bounty-filtered.json) — 99 VERIFY, 154 SKIP
  -> Task creation (GitHub Issues on xliry/lota-agents)
  -> Lota daemon (single agent, single-phase, auto mode)
  -> Per-submission: verify claims -> write verdict -> open cross-fork PR -> update scoreboard
```

### Files Modified in Lota

| File | Changes | Purpose |
|------|---------|---------|
| `src/prompt.ts` | Truncation limits 2K->16K, bounty snapshot rule, cross-fork PR rule, PR template rule, signature | Agent sees full task body, follows exact template |
| `src/process.ts` | Branch pre-checkout, merge skip for cross-fork | Agent starts on correct branch, PRs don't auto-close |
| `src/daemon.ts` | PR template extraction from task body | Template written to /tmp before agent starts |
| `src/git.ts` | Added `checkoutNewBranch()` | Daemon creates branch deterministically |

### Data Files

| File | Location | Purpose |
|------|----------|---------|
| `bounty-inbox.json` | `~/desloppify/` | 253 raw comments with metadata |
| `bounty-filtered.json` | `~/desloppify/` | Tagged comments (VERIFY/SKIP_*) |
| `bounty-scoreboard.md` | `~/lota-agents/` | Living scoreboard updated by agent |
| `bounty-verdicts/*.json` | `~/desloppify/` (per branch) | Structured verdict per submission |
| `bounty-verification-*.md` | `~/desloppify/` (per branch) | Human-readable verification report |

## Problems Encountered & Fixes

### 1. Task Body Truncation (Critical)
**Problem:** `sanitizeTaskBody()` truncated to 2000 chars. Bounty tasks are 3K-11K chars. Agent never saw verdict schema, PR template, or key instructions.
**Fix:** Raised limits to 16000/12000/3000. All bounty bodies fit within limit.
**File:** `prompt.ts:13-15`

### 2. PR Template Ignored (Critical)
**Problem:** Agent saw template as context, not instruction. Wrote its own summary format.
**Fix:** Two-layer approach — (a) extract template from task body to `/tmp/pr-template-<id>.md` in daemon before Claude spawns, (b) add explicit RULES telling agent to use `--body-file`.
**Files:** `daemon.ts:421-441`, `prompt.ts:139-142`

### 3. Stale Branch PRs (Critical)
**Problem:** Agent created branch from stale local main. PRs showed 800+ files, 98K lines — all old commits included.
**Fix:** Daemon pulls latest main and creates branch before agent starts. Deterministic, not prompt-dependent.
**File:** `process.ts:148-158`

### 4. Post-Completion Merge Closes PRs (Critical)
**Problem:** After task completion, daemon merged branch to main and deleted remote branch. GitHub auto-closes PR when source branch is deleted.
**Fix:** Skip merge for bounty/cross-fork tasks (detected by title prefix or task body keywords).
**File:** `process.ts:200-206`

### 5. PRs Opened to Wrong Repo (Medium)
**Problem:** Agent ran `gh pr create` without `--repo`, defaulting to fork (xliry/desloppify) instead of upstream (peteromallet/desloppify).
**Fix:** Hardcoded exact command in RULES with "NEVER open PRs to xliry/desloppify".
**File:** `prompt.ts:134-138`

### 6. Agent Commits to Main (Medium)
**Problem:** Agent sometimes committed to main instead of task branch, then tried cherry-pick.
**Fix:** Daemon creates and checks out the task branch before spawning Claude. Agent starts already on the correct branch.
**File:** `process.ts:153-156`

### 7. /sync Strips Task Body (Medium)
**Problem:** `/sync` endpoint uses `slim()` which removes body. Template extraction in daemon got empty string.
**Fix:** Fallback fetch via `GET /tasks/<id>` when body is missing.
**File:** `daemon.ts:426-431`

### 8. Bounty Snapshot Consistency (Medium)
**Problem:** Submissions made against commit `6eb2065`. Agent read current working tree which may have drifted.
**Fix:** Added RULES instruction to use `git show 6eb2065:<path>` for all source file reads. Fork main synced to same commit.
**File:** `prompt.ts:143-145`

### 9. Plan Phase Waste (Optimization)
**Problem:** Two Claude invocations per task (plan + execute). Auto-approve made plan phase redundant for template-driven bounty work.
**Fix:** `--single-phase` flag — agent explores and executes in one invocation. ~3min saved per task.
**CLI:** `node dist/daemon.js --name lota-1 --single-phase`

### 10. Reopened Tasks Skip Work (Minor)
**Problem:** When resetting a task, old "Completion Report" comments remained. Agent read them and said "already completed".
**Fix:** Create fresh task instead of reopening. Long-term: agent should check PR state, not comments.

## Auto-Filter Rules

| Filter | Condition | Tag | Count |
|--------|-----------|-----|-------|
| Noise | len < 100, no file ref | `SKIP_NOISE` | 17 |
| Owner | author == peteromallet/xliry | `SKIP_OWNER` | ~5 |
| Duplicate | same author, same file refs | `SKIP_DUPLICATE` | ~20 |
| Expression of interest | "interested", no code block | `SKIP_EOI` | ~15 |
| Bot/meta | "agent", "scoreboard", "verdict" | `SKIP_META` | ~10 |
| Spam author | >10 comments, >50% short | `SKIP_AGENT_SPAM` | 89 (renhe3983) |
| Thin | 100-300 chars, no code block | `SKIP_THIN` | ~10 |
| Pass | everything else | `VERIFY` | 99 |

## Agent Execution Profile

- **Model:** Claude Opus
- **Mode:** auto, single-phase
- **Average time per task:** ~4 minutes
- **Turns per task:** ~35-45
- **Rate limit handling:** 2min -> 5min -> 15min -> 30min backoff tiers
- **Daemon:** `node dist/daemon.js --name lota-1 --interval 15 --mode auto --model opus --single-phase`

## Verdict Quality Observations

**Strong points:**
- Agent reads actual source code at correct commit, verifies line numbers
- Correctly identifies duplicates by comparing with earlier submissions
- Scores are calibrated — fabricated evidence gets 0, real bugs get 6-8
- PR body follows exact template with all 8 sections

**Weak points / areas to improve:**
- Agent sometimes tries `npx tsc` on Python projects (build command detection)
- Cross-fork PR creation requires 2-3 attempts (tries wrong auth first)
- Branch naming inconsistent — sometimes uses `fix/bounty-*` instead of `task-*-lota-1`
- No dedup check against already-verified submissions before starting work

## Daemon Command Reference

```bash
# Start bounty verification agent
node ~/lota/dist/daemon.js \
  --name lota-1 \
  --interval 15 \
  --mode auto \
  --model opus \
  --single-phase

# Watch live
tmux a -t lota-agents

# Stop
pkill -f "node.*daemon"
```

## Key Prompt Rules (prompt.ts RULES array)

1. `git pull origin main` before branch creation
2. Cross-fork PR: `GITHUB_TOKEN="" gh pr create --repo peteromallet/desloppify --head xliry:<branch>`
3. PR template: read `/tmp/pr-template-<id>.md`, fill placeholders, use `--body-file`
4. Bounty snapshot: `git show 6eb2065:<path>` for all source reads
5. Scoreboard: edit `~/lota-agents/bounty-scoreboard.md`, commit from that repo
6. Signature: `Generated with [Lota](https://github.com/xliry/lota)`
7. Never force push, never open PRs to xliry/desloppify

## What to Build Next

1. **Build command auto-detection** — detect Python projects and skip `npx tsc`
2. **Dedup pre-check** — before starting a task, check if verdict already exists
3. **Configurable snapshot commit** — move `6eb2065` from hardcoded to task metadata
4. **Cross-fork PR auth** — try OAuth token first to avoid retry dance
5. **Batch task creation script** — reusable for future bounties
6. **Scoreboard analytics** — auto-generate summary stats from scoreboard data

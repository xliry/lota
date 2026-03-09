# Plan: Full Bounty Re-verification from Scratch

## Context

254 comments on peteromallet/desloppify#204, 70 unique authors. Old scoreboard (72 entries) will be wiped — starting fresh with new pipeline.

## Data Summary

| Metric | Count |
|--------|-------|
| Total comments | 254 |
| Unique authors | 70 |
| < 100 chars (noise) | 17 |
| 100-500 chars (thin) | 74 |
| 500-1500 chars (medium) | 64 |
| > 1500 chars (substantial) | 98 |
| Top spammer: renhe3983 | 89 comments |

## Pipeline

### Step 1: Ingest all comments

Script: `~/lota/scripts/ingest-bounty.ts` (new)

- Fetch all 254 comments from GitHub API (3 pages × 100)
- Save to `~/desloppify/bounty-inbox.json` as array of `{id, author, body, created_at, len}`
- Assign S-numbers sequentially by created_at order

### Step 2: Auto-filter (no agent needed)

Script: `~/lota/scripts/filter-bounty.ts` (new)

Rules (applied in order):

| Filter | Condition | Tag |
|--------|-----------|-----|
| **Noise** | len < 100, no `.py`/`.ts` file ref | `SKIP_NOISE` |
| **Peteromallet** | author == "peteromallet" or "xliry" | `SKIP_OWNER` |
| **Duplicate author** | same author, same file refs as earlier comment | `SKIP_DUPLICATE` |
| **Expression of interest** | matches "interested", "want to participate", "looking into", no code block | `SKIP_EOI` |
| **Bot/meta** | matches "agent", "scoreboard", "verdict", "robin", has no `.py` ref | `SKIP_META` |
| **Spam author** | author has > 10 comments AND > 50% are < 500 chars | `REVIEW_SPAM` |
| **Thin submission** | 100-300 chars, no code block, no file:line ref | `SKIP_THIN` |
| **Pass** | everything else | `VERIFY` |

Output: `~/desloppify/bounty-filtered.json` — same array with `tag` field added.

Expected: ~30-50 VERIFY, ~200 SKIP_*

### Step 3: Agent verification (batched)

For each `VERIFY` comment, create a lota task:

```
Title: "Bounty: verify S<N> @<author> — <first 50 chars of body>"
Agent: lota-1
Body: standard single-agent template (verify + PR)
```

Agent does:
1. Read submission comment
2. Trace claims against codebase
3. Write verdict JSON with full schema (is_poor_engineering, is_significant, why_missed, etc.)
4. Open PR to upstream with template
5. Update scoreboard

Rate limit handling: agent auto-backs off on API limit, resumes when window resets.

### Step 4: New scoreboard

Reset `~/lota-agents/bounty-scoreboard.md` with fresh header, entries added by agents as they verify.

## Files to Create/Modify

| File | Action |
|------|--------|
| `~/lota/scripts/ingest-bounty.ts` | NEW — fetch + save comments |
| `~/lota/scripts/filter-bounty.ts` | NEW — auto-filter + tag |
| `~/lota-agents/bounty-scoreboard.md` | RESET — empty table |
| `~/desloppify/bounty-inbox.json` | NEW — raw comments |
| `~/desloppify/bounty-filtered.json` | NEW — filtered + tagged |
| `~/desloppify/bounty-verdicts/` | CLEAN — remove old verdict JSONs |

## Execution Order

1. Write ingest script → run → bounty-inbox.json (254 entries)
2. Write filter script → run → bounty-filtered.json (~30-50 VERIFY)
3. Review VERIFY list manually (quick eyeball)
4. Reset scoreboard
5. Create lota tasks for each VERIFY entry
6. Agents grind through them

## Estimated Cost

- ~30-50 real verifications × ~100 turns each × sonnet = reasonable
- Auto-filtered ~200 comments save significant API/model cost
- Rate limit backoff: 2min → 5min → 15min → 30min tiers already in daemon

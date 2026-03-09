#!/usr/bin/env python3
"""
Desloppify Campaign Runner — reads curated repo list, creates Lota tasks
for each pending repo to run full desloppify analysis + tweet draft.

Usage:
    python3 scripts/campaign-runner.py              # run once
    python3 scripts/campaign-runner.py --loop 300   # poll every 5 minutes
    python3 scripts/campaign-runner.py --add https://github.com/owner/repo "optional notes"
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

LOTA_REPO = "xliry/lota-agents"
CAMPAIGNS_DIR = Path(__file__).parent.parent / "campaigns"
REPOS_FILE = CAMPAIGNS_DIR / "repos.json"
AGENT = "lota-1"


def gh(args: list[str]) -> str:
    result = subprocess.run(
        ["gh"] + args,
        capture_output=True, text=True, timeout=30
    )
    if result.returncode != 0:
        print(f"  [gh error] {result.stderr.strip()}", file=sys.stderr)
        return ""
    return result.stdout


def load_repos() -> list[dict]:
    if REPOS_FILE.exists():
        return json.loads(REPOS_FILE.read_text())
    return []


def save_repos(repos: list[dict]):
    REPOS_FILE.write_text(json.dumps(repos, indent=2) + "\n")


def parse_repo_url(url: str) -> tuple[str, str]:
    """Extract owner/repo from GitHub URL."""
    url = url.rstrip("/")
    if "github.com/" in url:
        parts = url.split("github.com/")[1].split("/")
        if len(parts) >= 2:
            return parts[0], parts[1]
    raise ValueError(f"Invalid GitHub URL: {url}")


def has_open_task_for_repo(owner: str, repo: str) -> bool:
    """Check if there's already an open campaign task for this repo."""
    raw = gh(["api", f"repos/{LOTA_REPO}/issues",
              "--jq", f'[.[] | select(.state=="open") | select(.title | test("Campaign:.*{owner}/{repo}"))] | length'])
    try:
        return int(raw.strip()) > 0
    except (ValueError, AttributeError):
        return False


def create_campaign_task(owner: str, repo: str, notes: str = "") -> str | None:
    """Create a Lota task to analyze a repo with desloppify."""

    if has_open_task_for_repo(owner, repo):
        return "skip"

    notes_section = f"\n**Notes:** {notes}\n" if notes else ""

    task_body = f"""## Desloppify Campaign: Analyze {owner}/{repo}
{notes_section}
### Instructions

You are running a desloppify analysis on a public GitHub repo for a Twitter content campaign.
Do NOT open issues or PRs on the target repo. Generate a report and tweet draft only.

### Step 1 — Clone the target repo

```bash
cd /tmp && rm -rf campaign-{repo} && git clone --depth 1 https://github.com/{owner}/{repo}.git campaign-{repo}
```

### Step 2 — Run desloppify analysis

Clone or update desloppify if needed:
```bash
test -d ~/desloppify || git clone https://github.com/xliry/desloppify.git ~/desloppify
```

Run the analysis on the cloned repo. Read through the codebase systematically:
1. Identify the main language(s) and framework(s)
2. Read key files: entry points, config, core modules
3. Look for poor engineering patterns:
   - No error handling / silent failures
   - Security vulnerabilities (injection, hardcoded secrets, etc.)
   - Race conditions / concurrency issues
   - Memory leaks / resource leaks
   - Dead code / unused imports at scale
   - God classes / functions (>500 lines)
   - No input validation at system boundaries
   - Inconsistent patterns (mix of styles without reason)
   - Missing type safety where it matters
   - Copied code instead of abstractions (>3 duplicates)

4. Assign a **Sloppy Score** (0-100):
   - 0-20: Clean, well-engineered
   - 21-40: Minor issues, generally solid
   - 41-60: Notable problems, needs work
   - 61-80: Seriously sloppy, major issues
   - 81-100: Dumpster fire

### Step 3 — Generate report

Write the full report to `~/lota/campaigns/reports/{owner}-{repo}.md` using this format:

```markdown
# Desloppify Report: {owner}/{repo}

**Sloppy Score:** X/100
**Date:** YYYY-MM-DD
**Analyzed by:** Lota
**Repo:** https://github.com/{owner}/{repo}

## Overview
Brief description of what the project is and its tech stack.

## Top Findings

### 1. [Finding Title]
- **Severity:** high/medium/low
- **File:** path/to/file.py:42
- **Issue:** Clear description of the problem
- **Fix:** What should be done

### 2. [Finding Title]
...

### 3. [Finding Title]
...

(Include up to 5 findings, ranked by severity)

## Summary
2-3 sentences summarizing the analysis, suitable for Twitter.
```

### Step 4 — Generate tweet thread draft

Write a tweet thread to `~/lota/campaigns/tweets/{owner}-{repo}.txt`:

```
TWEET 1 (hook — max 280 chars):
We ran desloppify on {owner}/{repo}.
Sloppy Score: X/100.
Here's the thread...

TWEET 2 (worst finding — include code snippet if short):
The worst thing we found: [finding title]
[2-3 line code snippet]
[Why it's bad in one sentence]

TWEET 3 (more findings):
Also found:
- [Finding 2 one-liner]
- [Finding 3 one-liner]
These aren't style nitpicks — real engineering problems.

TWEET 4 (CTA):
Full report + all findings: [link]
Run desloppify on your own repo: github.com/peteromallet/desloppify
```

Keep tweets punchy and engaging. The tone is "helping + light dunking" — point out real problems, not style preferences.

### Step 5 — Commit and push reports

```bash
cd ~/lota && git add campaigns/reports/{owner}-{repo}.md campaigns/tweets/{owner}-{repo}.txt
git commit -m "campaign: desloppify report for {owner}/{repo}"
git push
```

### Step 6 — Complete the task

Report which files were created and the sloppy score.

<!-- lota:v1:meta {{"workspace":"~/lota"}} -->
"""

    task_title = f"Campaign: analyze {owner}/{repo}"

    raw = gh([
        "api", f"repos/{LOTA_REPO}/issues",
        "-X", "POST",
        "-f", f"title={task_title}",
        "-f", f"body={task_body}",
        "-f", "labels[]=task",
        "-f", f"labels[]=agent:{AGENT}",
        "-f", "labels[]=status:assigned",
        "-f", "labels[]=priority:medium",
    ])

    if raw:
        data = json.loads(raw)
        return f"#{data['number']}"
    return None


def add_repo(url: str, notes: str = ""):
    """Add a repo to the curated list."""
    repos = load_repos()
    owner, repo = parse_repo_url(url)

    # Check for duplicates
    for r in repos:
        try:
            ro, rr = parse_repo_url(r["url"])
            if ro == owner and rr == repo:
                print(f"  Already in list: {owner}/{repo} (status: {r['status']})")
                return
        except ValueError:
            continue

    repos.append({
        "url": url,
        "status": "pending",
        "priority": "medium",
        "notes": notes,
        "added": time.strftime("%Y-%m-%d"),
    })
    save_repos(repos)
    print(f"  Added {owner}/{repo} to campaign list")


def run_once() -> int:
    repos = load_repos()
    created = 0

    for repo_entry in repos:
        if repo_entry["status"] != "pending":
            continue

        try:
            owner, repo = parse_repo_url(repo_entry["url"])
        except ValueError as e:
            print(f"  Invalid URL: {repo_entry['url']} — {e}")
            continue

        print(f"  Processing: {owner}/{repo}")
        task_num = create_campaign_task(owner, repo, repo_entry.get("notes", ""))

        if task_num == "skip":
            print(f"    → Skipped (open task exists)")
        elif task_num:
            print(f"    → Created Lota task {task_num}")
            repo_entry["status"] = "queued"
            repo_entry["task"] = task_num
            created += 1
        else:
            print(f"    → Failed to create task")

    save_repos(repos)
    return created


def main():
    parser = argparse.ArgumentParser(description="Desloppify Campaign Runner")
    parser.add_argument("--loop", type=int, default=0,
                        help="Poll interval in seconds (0 = run once)")
    parser.add_argument("--add", type=str, default="",
                        help="Add a repo URL to the campaign list")
    parser.add_argument("--notes", type=str, default="",
                        help="Notes for the repo being added")
    args = parser.parse_args()

    if args.add:
        add_repo(args.add, args.notes)
        return

    if args.loop > 0:
        print(f"Campaign runner polling every {args.loop}s...")
        while True:
            now = time.strftime("%H:%M:%S")
            print(f"[{now}] Checking for pending repos...")
            new = run_once()
            if new:
                print(f"  → {new} new task(s) created")
            else:
                print(f"  → No pending repos")
            time.sleep(args.loop)
    else:
        print("Running campaign...")
        new = run_once()
        print(f"Done. {new} task(s) created.")


if __name__ == "__main__":
    main()

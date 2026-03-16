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
Do NOT open issues or PRs on the target repo. Use the real desloppify CLI tool — do NOT invent your own scores or analysis.

### Step 1 — Clone the target repo

```bash
cd /tmp && rm -rf campaign-{repo} && git clone --depth 1 https://github.com/{owner}/{repo}.git campaign-{repo}
cd /tmp/campaign-{repo}
```

### Step 2 — Install and set up desloppify

```bash
pip install --upgrade "desloppify[full]"
desloppify update-skill claude
```

### Step 3 — Exclude non-source directories

Before scanning, check for directories that should be excluded (vendor, build output, generated code, node_modules, dist, .next, etc.) and exclude obvious ones:

```bash
desloppify exclude node_modules
desloppify exclude dist
desloppify exclude build
desloppify exclude .next
```

Check `ls` output and exclude any other obvious non-source directories.

### Step 4 — Scan the repo

```bash
desloppify scan --path .
```

Read the scan output carefully. It includes agent instructions — follow them exactly.

### Step 5 — The Fix Loop

Run `desloppify next`. It tells you what to fix, which file, and the resolve command to run when done.

**THE LOOP:**
1. `desloppify next` — get the next issue
2. Fix it properly (not minimally)
3. Run the resolve command shown by `next`
4. Repeat

Don't be lazy. Large refactors and small detailed fixes — do both with equal energy.
Use `desloppify plan` to reorder priorities or cluster related issues.
Rescan periodically with `desloppify scan --path .`

Your goal is to get the strict score as high as possible. The scoring resists gaming — the only way to improve it is to actually make the code better.

**IMPORTANT:** Do NOT substitute your own analysis. The scan output IS the analysis. Follow it.

### Step 6 — Save results

When the strict score is as high as you can get it, save the final scan output:

```bash
desloppify scan --path . > ~/lota/campaigns/reports/{owner}-{repo}.md
```

Also generate a tweet thread draft at `~/lota/campaigns/tweets/{owner}-{repo}.txt` based on the real desloppify findings. Keep tweets punchy and engaging. Tone: "helping + light dunking" — point out real problems, not style preferences.

```
TWEET 1 (hook — max 280 chars):
We ran @desloppify on {owner}/{repo}. Strict score: X. Here's what we found...

TWEET 2 (worst finding — include code snippet if short):
[Use actual findings from desloppify scan]

TWEET 3 (more findings):
[Use actual findings from desloppify scan]

TWEET 4 (CTA):
Run desloppify on YOUR repo: pip install desloppify
```

### Step 7 — Commit and push

```bash
cd ~/lota && git add campaigns/reports/{owner}-{repo}.md campaigns/tweets/{owner}-{repo}.txt
git commit -m "campaign: desloppify report for {owner}/{repo}"
git push
```

### Step 8 — Complete the task

Report the final strict score and which files were created.

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

import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { err, dim, logNonCritical } from "./logging.js";
import { isGitRepoRoot, isGitRepo } from "./git.js";
import type { AgentConfig, WorkData } from "./types.js";

// ── Task body sanitization ───────────────────────────────────────
function sanitizeTaskBody(body: string): string {
  let cleaned = body.replace(/<!--[\s\S]*?-->/g, "");
  cleaned = cleaned.replace(/!\[([^\]]*)\]\([^)]*\)/g, "[image: $1]");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  const MAX = 16000;
  const HEAD = 12000;
  const TAIL = 3000;
  if (cleaned.length <= MAX) return cleaned;
  return cleaned.slice(0, HEAD) + "\n\n... [truncated] ...\n\n" + cleaned.slice(-TAIL);
}

// ── Build command resolution ─────────────────────────────────────
function resolveBuildCmd(workspace?: string): string {
  if (!workspace) return "npm run build";
  const home = resolve(process.env.HOME || "/root");
  const dir = workspace.startsWith("~/") ? join(home, workspace.slice(2)) : workspace;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    if (pkg.scripts?.build) return "npm run build";
  } catch (e) { logNonCritical("read package.json for build cmd", e); }
  return "npx tsc";
}

// ── Workspace path resolution ────────────────────────────────────
export function resolveWorkspace(work: WorkData): string {
  const rawWorkspace = work.tasks[0]?.workspace;
  if (!rawWorkspace) return process.cwd();

  const home = resolve(process.env.HOME || "/root");

  if (rawWorkspace.includes("..")) {
    err(`Workspace path rejected (path traversal): ${rawWorkspace}`);
    return process.cwd();
  }

  const expanded = rawWorkspace.startsWith("~/")
    ? join(home, rawWorkspace.slice(2))
    : rawWorkspace;

  if (expanded.startsWith("/")) {
    if (!expanded.startsWith(home + "/") && expanded !== home) {
      err(`Workspace path rejected (escapes home): ${rawWorkspace}`);
      return process.cwd();
    }
    const candidate = resolve(expanded);
    if (existsSync(candidate)) {
      warnIfNotGitRoot(candidate);
      return candidate;
    }
    return process.cwd();
  }

  const candidate = resolve(home, expanded);
  if (existsSync(candidate)) {
    warnIfNotGitRoot(candidate);
    return candidate;
  }
  return process.cwd();
}

function warnIfNotGitRoot(dir: string): void {
  if (isGitRepo(dir) && !isGitRepoRoot(dir)) {
    dim(`Workspace ${dir} is inside a parent git repo — branch/merge strategy will be skipped`);
  }
}

// ── Prompt builder ───────────────────────────────────────────────
export function buildPrompt(agentName: string, work: WorkData, config: AgentConfig): string {
  if (work.phase === "comments") {
    const dmUpdates = work.commentUpdates.filter(cu => cu.title.startsWith("DM:"));
    const taskUpdates = work.commentUpdates.filter(cu => !cu.title.startsWith("DM:"));

    const parts: string[] = [
      `You are agent "${agentName}". Your MCP tool is lota().`,
      "",
    ];

    if (dmUpdates.length) {
      const dmList = dmUpdates.map(cu =>
        `  #${cu.id} "${cu.title}": ${cu.new_comment_count} new message(s)`
      ).join("\n");
      parts.push(
        "DIRECT MESSAGES — Someone is chatting with you live. Read and reply conversationally.",
        "  - Be concise, friendly, and helpful.",
        "  - Reply with lota(\"POST\", \"/tasks/<id>/comment\", {content: \"...\"}).",
        "  - Do NOT post plans, status updates, or completion reports.",
        "  - Do NOT use <!-- lota: --> metadata tags in your replies.",
        "  - This is a conversation, not a task. Just chat.",
        "",
        dmList,
      );
    }

    if (taskUpdates.length) {
      const taskList = taskUpdates.map(cu =>
        `  #${cu.id} "${cu.title}": ${cu.new_comment_count} new comment(s)${cu.workspace ? ` — ${cu.workspace}` : ""}`
      ).join("\n");
      if (dmUpdates.length) parts.push("");
      parts.push(
        "NEW COMMENTS on tasks. Read via lota API and respond appropriately.",
        "  - User feedback → adjust your work",
        "  - Question → reply with a comment",
        "  - Changed requirements → update your approach",
        "",
        taskList,
      );
    }

    return parts.join("\n");
  }

  const t = work.tasks[0];
  if (!t) return `You are agent "${agentName}". No tasks assigned.`;

  const buildCmd = resolveBuildCmd(t.workspace);
  const taskHeader = `TASK #${t.id}: ${t.title}\nWorkspace: ${t.workspace ?? "(none)"}\nBuild: ${buildCmd}`;
  const body = t.body ? "\n" + sanitizeTaskBody(t.body) : "";

  if (work.phase === "plan") {
    return [
      `You are agent "${agentName}". Your MCP tool is lota().`,
      "",
      "PLAN PHASE — Explore, then plan. Do NOT execute code.",
      "",
      "WORKFLOW:",
      `  1. lota("POST", "/tasks/${t.id}/plan", {goals: [...], affected_files: [...], effort: "..."})`,
      `  2. lota("POST", "/tasks/${t.id}/status", {status: "planned"})`,
      "  3. STOP. User will approve via Hub before you execute.",
      "",
      taskHeader,
      body,
    ].join("\n");
  }

  const isCampaignTask = t.title.startsWith("Campaign:");
  const branchName = `task-${t.id}-${agentName}`;
  const branchRule = config.useWorktree
    ? "  - You are already in the correct workspace directory (git worktree)."
    : `  - You are in the workspace directory. First, run: git pull origin main && git checkout -b ${branchName} (or git checkout ${branchName} if it exists). Push to this branch.`;

  const campaignRules = [
    "RULES (CAMPAIGN TASK):",
    branchRule,
    "  - Git identity is pre-configured. Do not run git config.",
    "  - Token file: ~/lota/.github-token (for git push auth).",
    "  - Do NOT use TodoWrite tool. USE the Agent tool for parallel subtasks when the task is large.",
    "  - Do NOT re-read the task via lota API. The task body is below.",
    "  - Do NOT post plan comments. Your commit is the audit trail.",
    "  - Use `gh` CLI for GitHub operations, NOT curl.",
    "  - NEVER force push.",
    "  - CAMPAIGN RULES:",
    "    - Do NOT open issues or PRs on the target repo.",
    "    - Clone the target repo to /tmp/ (shallow clone, --depth 1).",
    "    - Write report to ~/lota/campaigns/reports/{owner}-{repo}.md",
    "    - Write tweet draft to ~/lota/campaigns/tweets/{owner}-{repo}.txt",
    "    - Keep tweets punchy: 'helping + light dunking' tone.",
    "    - Commit reports to ~/lota and push.",
  ].join("\n");

  const bountyRules = [
    "RULES:",
    branchRule,
    "  - Git identity is pre-configured. Do not run git config.",
    "  - Token file: ~/lota/.github-token (for git push auth).",
    `  - Run \`${buildCmd}\` before pushing. Fix errors before committing.`,
    `  - Make ONE focused commit: "feat: description (#${t.id})"`,
    "  - Do NOT use TodoWrite tool. USE the Agent tool for parallel subtasks when the task is large.",
    "  - Do NOT re-read the task via lota API. The task body is below.",
    "  - Do NOT post plan comments. Your commit is the audit trail.",
    "  - Use `gh` CLI for GitHub operations, NOT curl.",
    "  - NEVER force push.",
    "  - SCOREBOARD: The bounty scoreboard is at ~/lota-agents/bounty-scoreboard.md (repo: xliry/lota-agents).",
    "    To update: read the file, edit your row, commit, and push from ~/lota-agents (NOT from the workspace).",
    "  - CROSS-FORK PRs: You are working in a FORK (xliry/desloppify). PRs MUST go to the UPSTREAM repo.",
    "    ALWAYS use this EXACT command to create PRs:",
    "    `GITHUB_TOKEN=\"\" gh pr create --repo peteromallet/desloppify --head xliry:<branch> --base main --body-file <file>`",
    "    NEVER run `gh pr create` without `--repo peteromallet/desloppify`. NEVER open PRs to xliry/desloppify.",
    "    The GITHUB_TOKEN=\"\" prefix is required — fine-grained PAT cannot create cross-fork PRs.",
    `  - PR BODY TEMPLATE: If /tmp/pr-template-${t.id}.md exists, it is the EXACT PR body structure you MUST use.`,
    "    Read the file, fill in every <placeholder> with real values from your analysis, and pass it via --body-file.",
    "    Do NOT write your own PR body. Do NOT paraphrase, summarize, skip sections, or restructure.",
    "    Every heading, table, and bullet point in the template MUST appear in the final PR body.",
    "  - BOUNTY SNAPSHOT: When verifying bounty submissions, ALWAYS read source files at commit 6eb2065.",
    "    Use `git show 6eb2065:<path>` to read files. Do NOT use the working tree — it may have changed since the submission.",
    "    Run `git fetch origin` first if the commit is not available locally.",
    "  - SIGNATURE: When creating PRs, end the body with: Generated with [Lota](https://github.com/xliry/lota)",
  ].join("\n");

  const rules = isCampaignTask ? campaignRules : bountyRules;

  const workflow = [
    "WORKFLOW:",
    `  1. lota("POST", "/tasks/${t.id}/status", {status: "in-progress"})`,
    "  2. Do the work. Build. Test. Commit. Push.",
    `  3. lota("POST", "/tasks/${t.id}/complete", {summary: "..."})`,
  ].join("\n");

  if (work.phase === "execute") {
    const goals = t.plan?.goals?.length
      ? "\nGOALS:\n" + t.plan.goals.map(g => `  - ${g}`).join("\n")
      : "";
    const files = t.plan?.affected_files?.length
      ? "\nFILES:\n" + t.plan.affected_files.map(f => `  - ${f}`).join("\n")
      : "";
    return [
      `You are agent "${agentName}". Your MCP tool is lota().`,
      "",
      workflow,
      "",
      rules,
      "",
      taskHeader,
      body,
      goals,
      files,
    ].join("\n");
  }

  // PHASE: SINGLE (auto mode)
  return [
    `You are agent "${agentName}". Your MCP tool is lota().`,
    "",
    workflow,
    "",
    rules,
    "",
    taskHeader,
    body,
  ].join("\n");
}

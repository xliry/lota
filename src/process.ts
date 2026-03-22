import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lota } from "./github.js";
import * as git from "./git.js";
import { isGitRepoRoot } from "./git.js";
import { createWorktree, mergeWorktree, cleanupWorktree, type WorktreeInfo } from "./worktree.js";
import { log, ok, dim, err, logNonCritical, formatEvent, writeToLog } from "./logging.js";
import { buildPrompt, resolveWorkspace } from "./prompt.js";
import { buildCliArgs } from "./cli-spawn.js";
import type { AgentConfig, WorkData } from "./types.js";

let currentProcess: ChildProcess | null = null;
let busy = false;
let lastRunRateLimited = false;
let lastRateLimitResetMinutes = 0;

export function getCurrentProcess(): ChildProcess | null { return currentProcess; }
export function resetBusy(): void { busy = false; }
export function wasRateLimited(): boolean { return lastRunRateLimited; }
export function getRateLimitResetMinutes(): number { return lastRateLimitResetMinutes; }

const RATE_LIMIT_PATTERNS = /rate.?limit|429|overloaded|too many requests|retry.?after|exhausted your capacity|quota.?reset/i;

// Parse Gemini's "Your quota will reset after 20h59m50s" or "after 3s"
const GEMINI_RESET_RE = /quota will reset after\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i;
function parseGeminiResetTime(text: string): number {
  const m = GEMINI_RESET_RE.exec(text);
  if (!m) return 0;
  const hours = parseInt(m[1] || "0", 10);
  const mins = parseInt(m[2] || "0", 10);
  const secs = parseInt(m[3] || "0", 10);
  return hours * 60 + mins + Math.ceil(secs / 60);
}

// ── Git branch merge (simple branch strategy) ───────────────────
function mergeBranch(workspace: string, branch: string): { success: boolean; hasConflicts: boolean; output: string } {
  // Step 1: Detect and checkout default branch (main or master)
  const defaultBranch = git.getDefaultBranch(workspace);
  if (!defaultBranch) {
    err(`No default branch (main/master) found in ${workspace}`);
    return { success: false, hasConflicts: false, output: "No default branch found" };
  }

  if (!git.checkout(workspace, defaultBranch)) {
    return { success: false, hasConflicts: false, output: `Failed to checkout ${defaultBranch}` };
  }

  // Step 2: Pull latest
  git.pull(workspace, "origin", defaultBranch);

  // Step 3: Merge the branch
  if (!git.merge(workspace, branch)) {
    if (git.hasConflicts(workspace)) {
      git.mergeAbort(workspace);
      return { success: false, hasConflicts: true, output: "" };
    }
    return { success: false, hasConflicts: false, output: "" };
  }

  // Step 4: Push with retry
  let pushed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (git.push(workspace, `origin ${defaultBranch}`)) { pushed = true; break; }
    if (attempt < 2) git.pull(workspace, "origin", defaultBranch);
  }

  if (!pushed) {
    err(`Failed to push ${defaultBranch} after 3 attempts`);
    return { success: false, hasConflicts: false, output: `Push to ${defaultBranch} failed` };
  }

  // Step 5: Cleanup branch
  git.deleteBranch(workspace, branch);
  git.deleteRemoteBranch(workspace, branch);

  return { success: true, hasConflicts: false, output: "" };
}

// ── Environment setup ────────────────────────────────────────────
function cleanEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE") || key === "CLAUDECODE" || key === "CLAUDE_SHELL_SESSION_ID") {
      delete env[key];
    }
  }
  return env;
}

function setupGitIdentity(env: NodeJS.ProcessEnv, config: AgentConfig): void {
  const email = `${config.githubRepo.split("/")[0]}@users.noreply.github.com`;
  env.GIT_AUTHOR_NAME = config.agentName;
  env.GIT_AUTHOR_EMAIL = email;
  env.GIT_COMMITTER_NAME = config.agentName;
  env.GIT_COMMITTER_EMAIL = email;
}

function writeTokenFile(config: AgentConfig): void {
  const tokenFile = join(process.env.HOME || "/root", "lota", ".github-token");
  try { writeFileSync(tokenFile, config.ghAuth, { mode: 0o600 }); }
  catch (e) { logNonCritical("write token file", e); }
}

// ── Claude settings merge ────────────────────────────────────────
const REQUIRED_PERMISSIONS = [
  "mcp__lota__lota", "Bash(*)", "Read(*)", "Write(*)",
  "Edit(*)", "Glob(*)", "Grep(*)", "Task(*)", "WebFetch(*)", "WebSearch(*)",
];
const DENIED_TOOLS = ["TodoWrite", "Agent"];

function mergeClaudeSettings(settingsFile: string, withDeny = false): void {
  try {
    mkdirSync(dirname(settingsFile), { recursive: true });
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(readFileSync(settingsFile, "utf-8")); }
    catch (e) { logNonCritical(`read ${settingsFile}`, e); }

    const perms = existing.permissions as { allow?: string[]; deny?: string[] } || {};
    const mergedAllow = [...new Set([...(perms.allow || []), ...REQUIRED_PERMISSIONS])];
    const merged: Record<string, unknown> = {
      ...existing,
      permissions: {
        ...perms,
        allow: mergedAllow,
        ...(withDeny ? { deny: [...new Set([...(perms.deny || []), ...DENIED_TOOLS])] } : {}),
      },
    };
    writeFileSync(settingsFile, JSON.stringify(merged, null, 2) + "\n");
  } catch (e) {
    logNonCritical(`write Claude settings to ${settingsFile}`, e);
  }
}

// ── Worktree / branch setup ──────────────────────────────────────
interface BranchSetup {
  claudeCwd: string;
  worktreeInfo: WorktreeInfo | null;
  defaultBranch: string | null;
}

function setupBranchStrategy(config: AgentConfig, work: WorkData, workingDir: string): BranchSetup {
  if (!(work.phase === "execute" || work.phase === "single") || !work.tasks[0]?.id) {
    return { claudeCwd: workingDir, worktreeInfo: null, defaultBranch: null };
  }

  if (!isGitRepoRoot(workingDir)) {
    dim(`Workspace ${workingDir} is not a git repo root — skipping branch strategy`);
    return { claudeCwd: workingDir, worktreeInfo: null, defaultBranch: null };
  }

  if (config.useWorktree) {
    const worktreeInfo = createWorktree(workingDir, config.agentName, work.tasks[0].id);
    if (worktreeInfo) {
      ok(`Worktree: ${worktreeInfo.worktreePath} (branch: ${worktreeInfo.branch})`);
      return { claudeCwd: worktreeInfo.worktreePath, worktreeInfo, defaultBranch: null };
    }
    dim(`Worktree skipped (not a git repo or failed): ${workingDir}`);
    return { claudeCwd: workingDir, worktreeInfo: null, defaultBranch: null };
  }

  // Pull latest main, then create and checkout task branch — agent starts on the correct branch
  const mainBranch = git.getDefaultBranch(workingDir) || "main";
  git.checkout(workingDir, mainBranch);
  git.pull(workingDir, "origin", mainBranch);

  const defaultBranch = `task-${work.tasks[0].id}-${config.agentName}`;
  if (!git.checkout(workingDir, defaultBranch)) {
    git.checkoutNewBranch(workingDir, defaultBranch);
  }
  ok(`Branch strategy: checked out branch ${defaultBranch}`);
  return { claudeCwd: workingDir, worktreeInfo: null, defaultBranch };
}

// ── Post-completion merge ────────────────────────────────────────
function handlePostCompletion(
  code: number,
  work: WorkData,
  worktreeInfo: WorktreeInfo | null,
  defaultBranch: string | null,
  workingDir: string,
  config: AgentConfig,
): void {
  if (worktreeInfo) {
    if (code === 0) {
      log(`Merging branch ${worktreeInfo.branch} back to main...`);
      const result = mergeWorktree(worktreeInfo.originalWorkspace, worktreeInfo.branch);
      if (result.success) {
        ok(`Merged ${worktreeInfo.branch} → main`);
        cleanupWorktree(worktreeInfo.originalWorkspace, config.agentName, worktreeInfo.branch);
      } else if (result.hasConflicts) {
        err(`Merge conflict on ${worktreeInfo.branch} — manual review needed`);
        err(result.output.slice(0, 200));
        for (const t of work.tasks) {
          lota("POST", `/tasks/${t.id}/comment`, {
            content: `⚠️ **Merge conflict**: Agent completed work on branch \`${worktreeInfo.branch}\` but auto-merge to main failed due to conflicts. Manual review needed.\n\nWorktree preserved at: \`${worktreeInfo.worktreePath}\``,
          }).catch(e => dim(`Comment failed for task #${t.id}: ${(e as Error).message}`));
        }
      } else {
        err(`Merge/push failed: ${result.output.slice(0, 200)}`);
        cleanupWorktree(worktreeInfo.originalWorkspace, config.agentName, worktreeInfo.branch);
      }
    } else {
      cleanupWorktree(worktreeInfo.originalWorkspace, config.agentName, worktreeInfo.branch);
    }
    return;
  }

  if (defaultBranch && code === 0) {
    if (!isGitRepoRoot(workingDir)) {
      dim(`Skipping merge — workspace is not a git repo root: ${workingDir}`);
      return;
    }
    // Skip merge for cross-fork PRs (task body mentions upstream repo)
    const taskBody = work.tasks[0]?.body || "";
    const taskTitle = work.tasks[0]?.title || "";
    if (taskBody.includes("--repo ") || taskBody.includes("PR to ") || taskTitle.toLowerCase().startsWith("bounty:")) {
      dim(`Skipping merge — cross-fork PR workflow, branch preserved for upstream review`);
      return;
    }
    log(`Merging branch ${defaultBranch} back to main...`);
    const result = mergeBranch(workingDir, defaultBranch);
    if (result.success) {
      ok(`Merged ${defaultBranch} → main`);
    } else if (result.hasConflicts) {
      err(`Merge conflict on ${defaultBranch} — manual review needed`);
      err(result.output.slice(0, 200));
      for (const t of work.tasks) {
        lota("POST", `/tasks/${t.id}/comment`, {
          content: `⚠️ **Merge conflict**: Agent completed work on branch \`${defaultBranch}\` but auto-merge to main failed due to conflicts. Branch preserved for manual review.`,
        }).catch(e => dim(`Comment failed for task #${t.id}: ${(e as Error).message}`));
      }
    } else {
      err(`Merge/push failed: ${result.output.slice(0, 200)}`);
    }
  }
}

// ── Main Claude subprocess ───────────────────────────────────────
export function runClaude(config: AgentConfig, work: WorkData): Promise<number> {
  if (busy) { dim("Already running, skipping..."); return Promise.resolve(0); }
  busy = true;

  return new Promise((resolve) => {
    const cleanEnv = cleanEnvironment();
    cleanEnv.GITHUB_TOKEN = config.ghAuth;
    cleanEnv.GITHUB_REPO = config.githubRepo;
    cleanEnv.AGENT_NAME = config.agentName;
    setupGitIdentity(cleanEnv, config);
    writeTokenFile(config);

    mergeClaudeSettings(join(process.env.HOME || "/root", ".claude", "settings.json"), true);

    const workingDir = resolveWorkspace(work);
    const rawWorkspace = work.tasks[0]?.workspace;
    if (rawWorkspace) {
      workingDir !== process.cwd() ? ok(`Workspace: ${workingDir}`) : err(`Workspace not found: ${rawWorkspace} — using cwd`);
    }

    const { claudeCwd, worktreeInfo, defaultBranch } = setupBranchStrategy(config, work, workingDir);
    const promptWork: WorkData = worktreeInfo
      ? { ...work, tasks: work.tasks.map(t => ({ ...t, workspace: worktreeInfo.worktreePath })) }
      : work;
    const prompt = buildPrompt(config.agentName, promptWork, config);
    const { command, args } = buildCliArgs(config, prompt, { injectSharedSkills: true });

    if (config.cli === "claude") {
      mergeClaudeSettings(join(claudeCwd, ".claude", "settings.json"), false);
    }

    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], cwd: claudeCwd, env: cleanEnv });
    currentProcess = child;
    lastRunRateLimited = false;

    let jsonBuffer = "";
    child.stdout?.on("data", (d: Buffer) => {
      const chunk = d.toString();
      if (RATE_LIMIT_PATTERNS.test(chunk)) lastRunRateLimited = true;
      jsonBuffer += chunk;
      const lines = jsonBuffer.split("\n");
      jsonBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          formatEvent(JSON.parse(line));
        } catch {
          console.log(`  ${line}`);
          writeToLog(`  ${line}\n`);
        }
      }
    });

    child.stderr?.on("data", (d: Buffer) => {
      const chunk = d.toString();
      if (RATE_LIMIT_PATTERNS.test(chunk)) {
        lastRunRateLimited = true;
        // Parse Gemini's reset time so daemon can wait the right amount
        const resetMin = parseGeminiResetTime(chunk);
        if (resetMin > 0) lastRateLimitResetMinutes = resetMin;
        // Kill Gemini CLI immediately on quota exhaustion — don't let it burn retries
        if (/exhausted your capacity|TerminalQuotaError/i.test(chunk) && child.pid) {
          writeToLog(`  [stderr] ⚡ Gemini quota exhausted — killing process tree to save quota\n`);
          // Tree-kill: kill all descendants then the process itself
          try { execSync(`pkill -9 -P ${child.pid} 2>/dev/null; kill -9 ${child.pid} 2>/dev/null`, { timeout: 3000 }); } catch { /* already dead */ }
        }
      }
      for (const line of chunk.split("\n")) {
        if (line.trim()) writeToLog(`  [stderr] ${line}\n`);
      }
    });

    child.on("close", (code) => {
      currentProcess = null;
      busy = false;
      handlePostCompletion(code ?? 1, work, worktreeInfo, defaultBranch, workingDir, config);
      resolve(code ?? 1);
    });

    child.on("error", (e) => {
      currentProcess = null;
      busy = false;
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        err("'claude' not found. Install: npm i -g @anthropic-ai/claude-code");
      } else {
        err(`Spawn error: ${e.message}`);
      }
      resolve(1);
    });
  });
}

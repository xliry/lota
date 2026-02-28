import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
  originalWorkspace: string;
}

export interface MergeResult {
  success: boolean;
  hasConflicts: boolean;
  output: string;
}

/** Check if a directory is a git repository. */
export function isGitRepo(dir: string): boolean {
  try {
    execSync("git rev-parse --git-dir", { cwd: dir, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Add `.worktrees/` to the workspace's .gitignore if not already present. */
export function ensureWorktreeInGitignore(workspace: string): void {
  const gitignorePath = join(workspace, ".gitignore");
  try {
    let content = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
    const lines = content.split("\n").map(l => l.trim());
    if (!lines.includes(".worktrees/") && !lines.includes(".worktrees")) {
      if (content.length > 0 && !content.endsWith("\n")) content += "\n";
      content += ".worktrees/\n";
      writeFileSync(gitignorePath, content);
    }
  } catch { /* ignore — best effort */ }
}

/**
 * Create a git worktree for an agent to work in isolation.
 * Worktree path: `<workspace>/.worktrees/<agentName>`
 * Branch name: `task-<taskId>-<agentName>`
 * Returns null if the workspace is not a git repo or creation fails.
 */
export function createWorktree(
  workspace: string,
  agentName: string,
  taskId: number,
): WorktreeInfo | null {
  if (!isGitRepo(workspace)) return null;

  const branch = `task-${taskId}-${agentName}`;
  const worktreesDir = join(workspace, ".worktrees");
  const worktreePath = join(worktreesDir, agentName);

  try {
    mkdirSync(worktreesDir, { recursive: true });
    ensureWorktreeInGitignore(workspace);

    // Remove stale worktree for this agent slot if it exists
    if (existsSync(worktreePath)) {
      try {
        execSync(`git worktree remove "${worktreePath}" --force`, {
          cwd: workspace,
          stdio: "pipe",
        });
      } catch { /* may already be cleaned */ }
    }

    // Remove stale branch with same name if it exists
    try {
      execSync(`git branch -D "${branch}"`, { cwd: workspace, stdio: "pipe" });
    } catch { /* branch may not exist — that's fine */ }

    execSync(`git worktree add "${worktreePath}" -b "${branch}"`, {
      cwd: workspace,
      stdio: "pipe",
    });

    return { worktreePath, branch, originalWorkspace: workspace };
  } catch {
    return null;
  }
}

/**
 * Merge a worktree branch back to the current HEAD of the main workspace,
 * then push to origin.
 */
export function mergeWorktree(workspace: string, branch: string): MergeResult {
  try {
    const output = execSync(`git merge "${branch}" --no-edit`, {
      cwd: workspace,
      encoding: "utf-8",
      stdio: "pipe",
    });

    // Push merged main branch to origin
    try {
      execSync("git push origin HEAD", { cwd: workspace, stdio: "pipe" });
    } catch (pushErr) {
      return {
        success: false,
        hasConflicts: false,
        output: `Merge succeeded but push failed: ${(pushErr as Error).message}`,
      };
    }

    return { success: true, hasConflicts: false, output: String(output) };
  } catch (e) {
    const msg = String((e as Error).message || e);
    const hasConflicts = msg.includes("CONFLICT") || msg.toLowerCase().includes("conflict");
    if (hasConflicts) {
      try {
        execSync("git merge --abort", { cwd: workspace, stdio: "pipe" });
      } catch { /* ignore */ }
    }
    return { success: false, hasConflicts, output: msg };
  }
}

/** Remove a worktree directory and its associated branch. */
export function cleanupWorktree(
  workspace: string,
  agentName: string,
  branch: string,
): void {
  const worktreePath = join(workspace, ".worktrees", agentName);
  try {
    if (existsSync(worktreePath)) {
      execSync(`git worktree remove "${worktreePath}" --force`, {
        cwd: workspace,
        stdio: "pipe",
      });
    }
  } catch { /* ignore */ }
  try {
    execSync(`git branch -D "${branch}"`, { cwd: workspace, stdio: "pipe" });
  } catch { /* ignore */ }
}

/**
 * Clean up stale worktrees from crashed agents.
 * Called on daemon startup to recover from unclean shutdowns.
 */
export function cleanStaleWorktrees(workspace: string): void {
  if (!isGitRepo(workspace)) return;

  // git worktree prune removes entries whose paths no longer exist
  try {
    execSync("git worktree prune", { cwd: workspace, stdio: "pipe" });
  } catch { /* ignore */ }

  const worktreesDir = join(workspace, ".worktrees");
  if (!existsSync(worktreesDir)) return;

  try {
    const entries = readdirSync(worktreesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryPath = join(worktreesDir, entry.name);
      try {
        execSync(`git worktree remove "${entryPath}" --force`, {
          cwd: workspace,
          stdio: "pipe",
        });
      } catch { /* ignore — may already be clean */ }
    }
  } catch { /* ignore */ }
}

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as git from "./git.js";

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
  originalWorkspace: string;
}

interface MergeResult {
  success: boolean;
  hasConflicts: boolean;
  output: string;
}

/** Add `.worktrees/` to the workspace's .gitignore if not already present. */
function ensureWorktreeInGitignore(workspace: string): void {
  const gitignorePath = join(workspace, ".gitignore");
  try {
    let content = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
    const lines = content.split("\n").map(l => l.trim());
    if (!lines.includes(".worktrees/") && !lines.includes(".worktrees")) {
      if (content.length > 0 && !content.endsWith("\n")) content += "\n";
      content += ".worktrees/\n";
      writeFileSync(gitignorePath, content);
    }
  } catch {
    // best-effort — non-fatal if .gitignore is unwritable
  }
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
  if (!git.isGitRepo(workspace)) return null;

  const branch = `task-${taskId}-${agentName}`;
  const worktreesDir = join(workspace, ".worktrees");
  const worktreePath = join(worktreesDir, agentName);

  mkdirSync(worktreesDir, { recursive: true });
  ensureWorktreeInGitignore(workspace);

  // Remove stale worktree and branch for this agent slot if they exist
  git.worktreeRemove(workspace, worktreePath);
  git.deleteBranch(workspace, branch);

  if (!git.worktreeAdd(workspace, worktreePath, branch)) return null;
  return { worktreePath, branch, originalWorkspace: workspace };
}

/**
 * Merge a worktree branch back to the current HEAD of the main workspace,
 * then push to origin.
 *
 * Strategy:
 * 1. Pull latest main so we're up-to-date with other agents' merges
 * 2. Try direct merge
 * 3. If conflict → rebase task branch on latest main, then fast-forward merge
 * 4. If rebase also conflicts → true conflict, needs manual resolution
 */
export function mergeWorktree(workspace: string, branch: string): MergeResult {
  const didStash = git.stash(workspace);
  git.pull(workspace);

  if (!git.merge(workspace, branch)) {
    const hadConflicts = git.hasConflicts(workspace);
    git.mergeAbort(workspace);

    if (hadConflicts) {
      const rebaseResult = tryRebaseThenMerge(workspace, branch);
      if (rebaseResult) {
        if (didStash) git.stashPop(workspace);
        return rebaseResult;
      }
    }

    if (didStash) git.stashPop(workspace);
    return { success: false, hasConflicts: hadConflicts, output: "Merge failed" };
  }

  // Push merged main branch to origin — retry up to 3 times on race condition
  const MAX_PUSH_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_PUSH_RETRIES; attempt++) {
    if (git.push(workspace)) {
      if (didStash) git.stashPop(workspace);
      return { success: true, hasConflicts: false, output: "Merged and pushed" };
    }
    if (attempt >= MAX_PUSH_RETRIES) break;
    console.log(`[mergeWorktree] Push attempt ${attempt}/${MAX_PUSH_RETRIES} failed, retrying with fresh pull...`);
    git.resetHard(workspace);
    git.pull(workspace);
    if (!git.merge(workspace, branch)) {
      git.mergeAbort(workspace);
      if (didStash) git.stashPop(workspace);
      return {
        success: false,
        hasConflicts: true,
        output: `Push retry ${attempt}: re-merge after pull failed`,
      };
    }
  }

  if (didStash) git.stashPop(workspace);
  return { success: false, hasConflicts: false, output: `Push failed after ${MAX_PUSH_RETRIES} attempts` };
}

/**
 * Attempt to rebase a task branch onto latest main and then fast-forward merge.
 * Returns MergeResult on success/push-failure, or null if rebase itself conflicts.
 */
function tryRebaseThenMerge(workspace: string, branch: string): MergeResult | null {
  // Find the worktree directory that has this branch checked out
  const listOut = git.worktreeList(workspace);
  let worktreePath: string | null = null;
  for (const block of listOut.split("\n\n")) {
    if (block.includes(`branch refs/heads/${branch}`)) {
      const pathLine = block.split("\n").find(l => l.startsWith("worktree "));
      if (pathLine) worktreePath = pathLine.replace("worktree ", "");
      break;
    }
  }
  if (!worktreePath || !existsSync(worktreePath)) return null;

  // Rebase the task branch on latest main
  if (!git.rebase(worktreePath, "main")) {
    git.rebaseAbort(worktreePath);
    return null;
  }

  // Rebase succeeded — now fast-forward merge on main
  if (!git.merge(workspace, branch, true)) return null;

  if (!git.push(workspace)) {
    return {
      success: false,
      hasConflicts: false,
      output: "Rebase+merge succeeded but push failed",
    };
  }

  return { success: true, hasConflicts: false, output: "Rebased and merged" };
}

/** Remove a worktree directory and its associated branch. */
export function cleanupWorktree(
  workspace: string,
  agentName: string,
  branch: string,
): void {
  git.worktreeRemove(workspace, join(workspace, ".worktrees", agentName));
  git.deleteBranch(workspace, branch);
}

/**
 * Clean up stale worktrees from crashed agents.
 * Called on daemon startup to recover from unclean shutdowns.
 */
export function cleanStaleWorktrees(workspace: string): void {
  if (!git.isGitRepo(workspace)) return;

  git.worktreePrune(workspace);

  const worktreesDir = join(workspace, ".worktrees");
  if (!existsSync(worktreesDir)) return;

  for (const entry of readdirSync(worktreesDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      git.worktreeRemove(workspace, join(worktreesDir, entry.name));
    }
  }
}

import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { lota } from "./github.js";
import { cleanStaleWorktrees } from "./worktree.js";
import { tgSend } from "./telegram.js";
import { log, ok, dim, err } from "./logging.js";
import type { AgentConfig } from "./types.js";

const MS_PER_MINUTE = 60_000;
const FIVE_MINUTES_MS = 5 * MS_PER_MINUTE;
const TWO_MINUTES_MS = 2 * MS_PER_MINUTE;

type StaleTask = { id: number; title: string; assignee: string | null; retries?: number; updatedAt?: string };

async function safeLota(method: string, path: string, body?: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  try {
    const data = await lota(method, path, body);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── Startup recovery ─────────────────────────────────────────────
export async function recoverStaleTasks(config: AgentConfig): Promise<void> {
  process.env.GITHUB_TOKEN = config.githubToken;
  process.env.GITHUB_REPO = config.githubRepo;
  process.env.AGENT_NAME = config.agentName;

  log("🔍 Checking for stale in-progress tasks from previous crash...");

  const tasksResult = await safeLota("GET", "/tasks?status=in-progress");
  if (!tasksResult.ok) {
    err(`Startup recovery check failed: ${tasksResult.error}`);
    return;
  }

  const tasks = tasksResult.data as StaleTask[];
  const myTasks = tasks.filter(t => t.assignee === config.agentName);
  if (!myTasks.length) {
    dim("  No stale in-progress tasks found.");
    return;
  }

  for (const task of myTasks) {
    if (task.updatedAt && Date.now() - new Date(task.updatedAt).getTime() < TWO_MINUTES_MS) {
      dim(`  ⏭ Skipping task #${task.id} "${task.title}" (updated < 2 min ago, may be active)`);
      continue;
    }

    const detailResult = await safeLota("GET", `/tasks/${task.id}`);
    if (!detailResult.ok) {
      err(`Failed to fetch details for task #${task.id}: ${detailResult.error}`);
      continue;
    }

    await recoverOrFailTask(task, detailResult.data as { workspace?: string }, config);
  }

  ok("Startup recovery complete.");
}

async function recoverOrFailTask(
  task: StaleTask,
  details: { workspace?: string },
  config: AgentConfig,
): Promise<void> {
  const retryCount = task.retries ?? 0;

  if (retryCount < 3) {
    const nextRetry = retryCount + 1;
    log(`🔄 Recovering task #${task.id} "${task.title}" (retry ${nextRetry}/3)`);

    const patchResult = await safeLota("PATCH", `/tasks/${task.id}/meta`, { retries: nextRetry });
    if (!patchResult.ok) {
      err(`Failed to recover task #${task.id}: ${patchResult.error}`);
      return;
    }
    await safeLota("POST", `/tasks/${task.id}/status`, { status: "assigned" });
    await safeLota("POST", `/tasks/${task.id}/comment`, {
      content: `🔄 Auto-recovery: task was in-progress when agent crashed (retry ${nextRetry}/3).`,
    });
    await tgSend(config, `🔄 Task #${task.id} auto-recovered after crash (retry ${nextRetry}/3): ${task.title}`);
  } else {
    log(`❌ Task #${task.id} "${task.title}" — 3 crash recoveries exhausted, marking failed`);

    const statusResult = await safeLota("POST", `/tasks/${task.id}/status`, { status: "failed" });
    if (!statusResult.ok) {
      err(`Failed to mark task #${task.id} as failed: ${statusResult.error}`);
      return;
    }
    await safeLota("POST", `/tasks/${task.id}/comment`, {
      content: `❌ Task failed after 3 crash recoveries. Manual review needed.`,
    });
    await tgSend(config, `❌ Task #${task.id} failed after 3 retries: ${task.title}`);
  }

  if (!details.workspace) return;
  const home = resolve(process.env.HOME || "/root");
  const wsPath = details.workspace.startsWith("~/")
    ? join(home, details.workspace.slice(2))
    : details.workspace;
  if (existsSync(wsPath)) {
    try { cleanStaleWorktrees(wsPath); dim(`  Cleaned stale worktrees for workspace: ${wsPath}`); }
    catch (e) { dim(`[non-critical] stale worktree cleanup failed for ${wsPath}: ${(e as Error).message}`); }
  }
}

// ── Runtime stale-task recovery ──────────────────────────────────
export async function checkRuntimeStaleTasks(config: AgentConfig): Promise<void> {
  const tasksResult = await safeLota("GET", "/tasks?status=in-progress");
  if (!tasksResult.ok) {
    dim(`Runtime stale-task check failed: ${tasksResult.error}`);
    return;
  }

  const tasks = tasksResult.data as Array<{ id: number; title: string; assignee: string | null; updatedAt?: string }>;
  const now = Date.now();
  for (const task of tasks.filter(t => t.assignee === config.agentName)) {
    if (!task.updatedAt) continue;
    const age = now - new Date(task.updatedAt).getTime();
    if (age < FIVE_MINUTES_MS) continue;

    const ageMin = Math.round(age / MS_PER_MINUTE);
    log(`🔄 Runtime recovery: task #${task.id} "${task.title}" stuck for ${ageMin}m — resetting to assigned`);

    const statusResult = await safeLota("POST", `/tasks/${task.id}/status`, { status: "assigned" });
    if (!statusResult.ok) {
      err(`Failed to runtime-recover task #${task.id}: ${statusResult.error}`);
      continue;
    }
    await safeLota("POST", `/tasks/${task.id}/comment`, {
      content: `🔄 Runtime recovery: task was stuck in-progress for ${ageMin} minutes. Reset to assigned for retry.`,
    });
  }
}

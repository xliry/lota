import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { lota } from "./github.js";
import { dim, logNonCritical } from "./logging.js";
import { parseWorkspaceFromBody } from "./prompt.js";
import type { AgentConfig, TaskInfo, CommentUpdate, WorkData } from "./types.js";

// ── Dependency checking ───────────────────────────────────────────
async function checkDependenciesMet(deps: number[], knownCompleted: Set<number>): Promise<boolean> {
  for (const depId of deps) {
    if (knownCompleted.has(depId)) continue;
    try {
      const issue = await lota("GET", `/tasks/${depId}`) as { status: string };
      if (issue.status !== "completed") return false;
    } catch (e) {
      logNonCritical(`check dep #${depId}`, e);
      return false; // can't verify → assume not met
    }
  }
  return true;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * MS_PER_DAY;
const BASELINES_FILE = join(process.env.HOME || "/root", "lota", ".comment-baselines.json");

interface BaselineEntry {
  count: number;
  ts: number;
}

const lastSeenComments = new Map<number, number>();
let baselinesDirty = false;

// ── Baseline persistence ─────────────────────────────────────────
function loadCommentBaselines(): void {
  try {
    if (!existsSync(BASELINES_FILE)) return;
    const data = JSON.parse(readFileSync(BASELINES_FILE, "utf-8")) as Record<string, BaselineEntry>;
    const cutoff = Date.now() - SEVEN_DAYS_MS;
    let loaded = 0;
    for (const [idStr, entry] of Object.entries(data)) {
      const id = parseInt(idStr, 10);
      if (isNaN(id) || entry.ts < cutoff) continue;
      lastSeenComments.set(id, entry.count);
      loaded++;
    }
    if (loaded > 0) dim(`[baselines] loaded ${loaded} comment baseline(s) from disk`);
  } catch (e) {
    logNonCritical("load comment baselines", e);
  }
}

function saveCommentBaselines(): void {
  if (!baselinesDirty) return;
  try {
    const now = Date.now();
    const cutoff = now - SEVEN_DAYS_MS;
    const data: Record<string, BaselineEntry> = {};

    for (const [id, count] of lastSeenComments.entries()) {
      data[String(id)] = { count, ts: now };
    }

    try {
      if (existsSync(BASELINES_FILE)) {
        const existing = JSON.parse(readFileSync(BASELINES_FILE, "utf-8")) as Record<string, BaselineEntry>;
        for (const [idStr, entry] of Object.entries(existing)) {
          if (!data[idStr] && entry.ts >= cutoff) data[idStr] = entry;
        }
      }
    } catch (e) { logNonCritical("read existing baselines", e); }

    const tmpFile = BASELINES_FILE + ".tmp";
    writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    renameSync(tmpFile, BASELINES_FILE);
    baselinesDirty = false;
  } catch (e) {
    logNonCritical("save comment baselines", e);
  }
}

export async function refreshCommentBaselines(taskIds: number[]): Promise<void> {
  for (const id of taskIds) {
    try {
      const task = await lota("GET", `/tasks/${id}`) as { comments?: unknown[] };
      lastSeenComments.set(id, task.comments?.length ?? 0);
      baselinesDirty = true;
    } catch (e) {
      logNonCritical(`refresh baselines for task #${id}`, e);
    }
  }
  saveCommentBaselines();
}

// ── Comment update detection ─────────────────────────────────────
function detectCommentUpdates(
  tasks: (TaskInfo & { comment_count: number })[],
  firstSeen: boolean,
): CommentUpdate[] {
  const MAX_NEW_COMMENTS = 20; // skip spam — likely crash retry loops
  const updates: CommentUpdate[] = [];
  for (const task of tasks) {
    // Skip DM issues — chat loop handles them
    if (task.title.startsWith("DM:")) continue;
    const lastSeen = lastSeenComments.get(task.id) ?? -1;
    const currentCount = task.comment_count ?? 0;
    if (lastSeen === -1) {
      lastSeenComments.set(task.id, currentCount);
      baselinesDirty = true;
      if (firstSeen) continue; // don't trigger on first sight
    } else if (currentCount > lastSeen) {
      const newCount = currentCount - lastSeen;
      if (newCount > MAX_NEW_COMMENTS) {
        // Too many new comments — likely crash spam, just update baseline
        dim(`  ⏭ Skipping #${task.id}: ${newCount} new comments (likely spam) — updating baseline`);
        lastSeenComments.set(task.id, currentCount);
        baselinesDirty = true;
        continue;
      }
      updates.push({
        id: task.id,
        title: task.title,
        workspace: task.workspace ?? undefined,
        new_comment_count: newCount,
      });
      lastSeenComments.set(task.id, currentCount);
      baselinesDirty = true;
    }
  }
  return updates;
}

// ── Main work checker ────────────────────────────────────────────
export async function checkForWork(config: AgentConfig): Promise<WorkData | null> {
  process.env.GITHUB_TOKEN = config.ghAuth;
  process.env.GITHUB_REPO = config.githubRepo;
  process.env.AGENT_NAME = config.agentName;

  const data = await lota("GET", "/sync") as {
    assigned: TaskInfo[];
    approved: TaskInfo[];
    in_progress: (TaskInfo & { comment_count: number })[];
    blocked?: TaskInfo[];
    recently_completed: (TaskInfo & { comment_count: number })[];
  };

  // Auto-unblock: check blocked tasks whose dependencies are all completed
  const blocked = data.blocked || [];
  if (blocked.length) {
    const completedIds = new Set((data.recently_completed || []).map(t => t.id));
    for (const task of blocked) {
      const deps = task.depends_on || [];
      if (!deps.length) continue;
      const allMet = await checkDependenciesMet(deps, completedIds);
      if (allMet) {
        await lota("POST", `/tasks/${task.id}/status`, { status: "assigned" });
        dim(`Unblocked task #${task.id} "${task.title}" — all dependencies met`);
      }
    }
  }

  // Filter out DM channels — they are handled via comment detection only
  const isDM = (t: TaskInfo) => t.title.startsWith("DM:");
  const assigned = (data.assigned || []).filter(t => !isDM(t));
  const approved = (data.approved || []).filter(t => !isDM(t));
  const inProgress = data.in_progress || []; // keep DMs here for comment detection
  const recentlyCompleted = data.recently_completed || [];

  const commentUpdates = [
    ...detectCommentUpdates(inProgress, false),
    ...detectCommentUpdates(recentlyCompleted, true),
  ];

  // Clean up tracking for tasks no longer active
  const activeIds = new Set([...inProgress.map(t => t.id), ...recentlyCompleted.map(t => t.id)]);
  for (const id of lastSeenComments.keys()) {
    if (!activeIds.has(id)) {
      lastSeenComments.delete(id);
      baselinesDirty = true;
    }
  }

  saveCommentBaselines();

  if (commentUpdates.length) {
    return { phase: "comments", tasks: [], commentUpdates };
  }

  // Enrich a task: fetch full body, parse workspace from body if missing
  async function enrichTask(t: TaskInfo): Promise<TaskInfo> {
    try {
      const details = await lota("GET", `/tasks/${t.id}`) as {
        body?: string;
        plan?: { affected_files?: string[]; goals?: string[] };
      };
      const enriched = { ...t, plan: details.plan };
      // Parse workspace from issue body when not set via label
      if (!enriched.workspace && details.body) {
        const parsed = parseWorkspaceFromBody(details.body);
        if (parsed) {
          enriched.workspace = parsed;
          dim(`Workspace parsed from body: ${parsed} (task #${t.id})`);
        }
      }
      // Carry body forward for prompt building
      if (details.body && !enriched.body) enriched.body = details.body;
      return enriched;
    } catch (e) {
      logNonCritical(`enrich task #${t.id}`, e);
      return t;
    }
  }

  if (approved.length) {
    const tasksToExecute = approved.sort((a, b) => a.id - b.id).slice(0, config.maxTasksPerCycle);
    const enrichedTasks = await Promise.all(tasksToExecute.map(enrichTask));
    return { phase: "execute", tasks: enrichedTasks, commentUpdates: [] };
  }

  if (assigned.length) {
    const sorted = assigned.sort((a, b) => a.id - b.id).slice(0, config.maxTasksPerCycle);
    const enrichedTasks = await Promise.all(sorted.map(enrichTask));
    const phase = config.singlePhase ? "single" : "plan";
    return { phase, tasks: enrichedTasks, commentUpdates: [] };
  }

  return null;
}

// Load baselines at module init
loadCommentBaselines();

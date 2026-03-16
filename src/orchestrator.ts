import { spawn } from "node:child_process";
import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { writeFileSync } from "node:fs";
import { lota } from "./github.js";
import { ok, dim, err, logNonCritical, formatEvent, writeToLog } from "./logging.js";
import { buildOrchestratorPrompt } from "./orchestrator-prompt.js";
import type { AgentConfig, OrchestratorSnapshot, OrchestratorDelta } from "./types.js";
import { AGENTS_DIR } from "./daemon.js";

const ORCHESTRATOR_INTERVAL_MS = 60_000;

let lastSnapshot: OrchestratorSnapshot | null = null;
let orchestratorBusy = false;
let orchestratorTimer: ReturnType<typeof setInterval> | null = null;

// ── Environment setup (same as chat.ts) ─────────────────────────
function cleanEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE") || key === "CLAUDECODE" || key === "CLAUDE_SHELL_SESSION_ID") {
      delete env[key];
    }
  }
  return env;
}

const REQUIRED_PERMISSIONS = [
  "mcp__lota__lota", "Bash(*)", "Read(*)", "Write(*)",
  "Edit(*)", "Glob(*)", "Grep(*)", "Task(*)", "WebFetch(*)", "WebSearch(*)",
];

function ensureClaudeSettings(settingsFile: string): void {
  try {
    mkdirSync(dirname(settingsFile), { recursive: true });
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(readFileSync(settingsFile, "utf-8")); }
    catch { /* ignore */ }
    const perms = existing.permissions as { allow?: string[]; deny?: string[] } || {};
    const mergedAllow = [...new Set([...(perms.allow || []), ...REQUIRED_PERMISSIONS])];
    const merged: Record<string, unknown> = {
      ...existing,
      permissions: { ...perms, allow: mergedAllow },
    };
    writeFileSync(settingsFile, JSON.stringify(merged, null, 2) + "\n");
  } catch (e) {
    logNonCritical(`write Claude settings to ${settingsFile}`, e);
  }
}

// ── Agent discovery ─────────────────────────────────────────────
function discoverAgents(): Set<string> {
  const agents = new Set<string>();
  try {
    const files = readdirSync(AGENTS_DIR).filter(f => f.endsWith(".pid"));
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(AGENTS_DIR, file), "utf-8")) as { name?: string };
        if (data.name) agents.add(data.name);
      } catch { /* skip malformed PID files */ }
    }
  } catch { /* AGENTS_DIR may not exist yet */ }
  return agents;
}

// ── Sync data types ─────────────────────────────────────────────
interface SyncTask {
  id: number;
  title: string;
  status: string;
  assignee: string | null;
  comment_count?: number;
  workspace?: string | null;
}

interface SyncData {
  assigned: SyncTask[];
  approved: SyncTask[];
  in_progress: SyncTask[];
  failed: SyncTask[];
  blocked: SyncTask[];
  recently_completed: SyncTask[];
}

// ── Snapshot building ───────────────────────────────────────────
function buildSnapshot(syncData: SyncData, agents: Set<string>): OrchestratorSnapshot {
  const tasks = new Map<number, { status: string; commentCount: number; title: string; assignee: string | null; workspace: string | null }>();

  const allTasks = [
    ...syncData.assigned,
    ...syncData.approved,
    ...syncData.in_progress,
    ...syncData.failed,
    ...syncData.blocked,
    ...syncData.recently_completed,
  ];

  for (const t of allTasks) {
    tasks.set(t.id, {
      status: t.status,
      commentCount: t.comment_count ?? 0,
      title: t.title,
      assignee: t.assignee,
      workspace: t.workspace ?? null,
    });
  }

  return { tasks, agents };
}

// ── Delta computation ───────────────────────────────────────────
function computeDelta(prev: OrchestratorSnapshot, curr: OrchestratorSnapshot): OrchestratorDelta {
  const delta: OrchestratorDelta = {
    newTasks: [],
    statusChanges: [],
    newComments: [],
    agentChanges: { online: [], offline: [] },
    completions: [],
  };

  // New tasks
  for (const [id, task] of curr.tasks) {
    // Skip DM channels — chat activity is not a task event
    if (task.title.startsWith("DM:")) continue;
    if (!prev.tasks.has(id)) {
      delta.newTasks.push({ id, title: task.title, status: task.status });
    }
  }

  // Status changes & new comments
  for (const [id, task] of curr.tasks) {
    if (task.title.startsWith("DM:")) continue;
    const prevTask = prev.tasks.get(id);
    if (!prevTask) continue;

    if (prevTask.status !== task.status) {
      if (task.status === "completed") {
        delta.completions.push({ id, title: task.title });
      } else {
        delta.statusChanges.push({ id, title: task.title, from: prevTask.status, to: task.status });
      }
    }

    if (task.commentCount > prevTask.commentCount) {
      delta.newComments.push({ id, title: task.title, count: task.commentCount - prevTask.commentCount });
    }
  }

  // Agent changes
  for (const agent of curr.agents) {
    if (!prev.agents.has(agent)) delta.agentChanges.online.push(agent);
  }
  for (const agent of prev.agents) {
    if (!curr.agents.has(agent)) delta.agentChanges.offline.push(agent);
  }

  return delta;
}

function isDeltaEmpty(delta: OrchestratorDelta): boolean {
  return (
    delta.newTasks.length === 0 &&
    delta.statusChanges.length === 0 &&
    delta.newComments.length === 0 &&
    delta.completions.length === 0 &&
    delta.agentChanges.online.length === 0 &&
    delta.agentChanges.offline.length === 0
  );
}

// ── Claude invocation ───────────────────────────────────────────
function runOrchestratorClaude(prompt: string, config: AgentConfig): Promise<void> {
  const cleanEnv = cleanEnvironment();
  cleanEnv.GITHUB_TOKEN = config.ghAuth;
  cleanEnv.GITHUB_REPO = config.githubRepo;
  cleanEnv.AGENT_NAME = config.agentName;

  ensureClaudeSettings(join(process.env.HOME || "/root", ".claude", "settings.json"));

  const isRoot = process.getuid?.() === 0;
  const args: string[] = [
    "--print", "--verbose", "--output-format", "stream-json",
    ...(isRoot ? [] : ["--dangerously-skip-permissions"]),
    "--model", config.model,
    ...(config.configPath ? ["--mcp-config", config.configPath] : []),
    "-p", prompt,
  ];

  return new Promise((resolve) => {
    const child = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
      env: cleanEnv,
    });

    let jsonBuffer = "";
    child.stdout?.on("data", (d: Buffer) => {
      const chunk = d.toString();
      jsonBuffer += chunk;
      const lines = jsonBuffer.split("\n");
      jsonBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try { formatEvent(JSON.parse(line)); }
        catch { writeToLog(`  [orchestrator] ${line}\n`); }
      }
    });

    child.stderr?.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        if (line.trim()) writeToLog(`  [orchestrator-stderr] ${line}\n`);
      }
    });

    child.on("close", (code) => {
      if (code === 0) dim("Orchestrator cycle complete");
      else err(`Orchestrator Claude exited with code ${code}`);
      resolve();
    });

    child.on("error", (e) => {
      err(`Orchestrator spawn error: ${(e as Error).message}`);
      resolve();
    });
  });
}

// ── Poll cycle ──────────────────────────────────────────────────
async function orchestratorPoll(config: AgentConfig): Promise<void> {
  if (orchestratorBusy) return;
  orchestratorBusy = true;

  try {
    // Fetch all tasks across all agents
    const syncData = await lota("GET", "/sync?all=true") as SyncData;
    const agents = discoverAgents();
    const current = buildSnapshot(syncData, agents);

    // First poll — set baseline only
    if (lastSnapshot === null) {
      lastSnapshot = current;
      dim("Orchestrator baseline set");
      return;
    }

    // Compute delta
    const delta = computeDelta(lastSnapshot, current);

    // Nothing changed — skip
    if (isDeltaEmpty(delta)) return;

    // Find active DM channel
    const dmTasks = [...current.tasks.entries()]
      .filter(([, t]) => t.title.startsWith("DM:") && t.status === "in-progress");

    if (dmTasks.length === 0) {
      dim("Orchestrator: delta detected but no active DM channel — skipping");
      lastSnapshot = current;
      return;
    }

    const [dmId] = dmTasks[0];
    dim(`Orchestrator: delta detected, briefing DM #${dmId}`);

    // Build prompt and invoke Claude
    const prompt = buildOrchestratorPrompt(
      config.agentName,
      dmId,
      current,
      delta,
      { githubRepo: config.githubRepo },
    );

    await runOrchestratorClaude(prompt, config);

    // Re-fetch snapshot after Claude runs to capture any changes it made
    // (comments posted, statuses changed) — prevents false deltas next poll
    try {
      const freshSync = await lota("GET", "/sync?all=true") as SyncData;
      lastSnapshot = buildSnapshot(freshSync, discoverAgents());
    } catch {
      lastSnapshot = current;
    }
  } catch (e) {
    logNonCritical("orchestrator poll", e);
  } finally {
    orchestratorBusy = false;
  }
}

// ── Leader election (lowest agent name wins) ───────────────────
function isOrchestratorLeader(myName: string): boolean {
  const agents = discoverAgents();
  if (agents.size === 0) return true;
  const sorted = [...agents].sort();
  return sorted[0] === myName;
}

// ── Public API ──────────────────────────────────────────────────
export function startOrchestratorLoop(config: AgentConfig): void {
  orchestratorTimer = setInterval(() => {
    if (!isOrchestratorLeader(config.agentName)) return;
    orchestratorPoll(config);
  }, ORCHESTRATOR_INTERVAL_MS);
  // Check immediately if we're leader
  if (isOrchestratorLeader(config.agentName)) {
    ok("Orchestrator loop started (60s interval, this agent is leader)");
  } else {
    dim("Orchestrator loop started (60s interval, deferring to leader)");
  }
}

export function stopOrchestratorLoop(): void {
  if (orchestratorTimer) {
    clearInterval(orchestratorTimer);
    orchestratorTimer = null;
    dim("Orchestrator loop stopped");
  }
}

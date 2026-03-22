import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lota } from "./github.js";
import { ok, dim, err, logNonCritical, formatEvent, writeToLog } from "./logging.js";
import { buildChatPrompt } from "./chat-prompt.js";
import { buildCliArgs } from "./cli-spawn.js";
import type { AgentConfig } from "./types.js";

let chatTimer: ReturnType<typeof setInterval> | null = null;
let chatBusy = false;
let firstPoll = true;
const chatBaselines = new Map<number, number>();
const notifiedCompletions = new Set<number>();

interface SyncResult {
  in_progress: Array<{ id: number; title: string; comment_count?: number }>;
  recently_completed: Array<{ id: number; title: string }>;
}

interface TaskDetail {
  id: number;
  title: string;
  comments: Array<{ body: string; created_at: string; user: string }>;
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

// ── Claude settings merge ────────────────────────────────────────
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

// ── Handle DM messages ──────────────────────────────────────────
async function handleDMMessages(dmId: number, config: AgentConfig): Promise<void> {
  const task = await lota("GET", `/tasks/${dmId}`) as TaskDetail;
  const messages = task.comments || [];
  if (!messages.length) return;

  const prompt = buildChatPrompt(config.agentName, dmId, messages, config);

  const cleanEnv = cleanEnvironment();
  cleanEnv.GITHUB_TOKEN = config.ghAuth;
  cleanEnv.GITHUB_REPO = config.githubRepo;
  cleanEnv.AGENT_NAME = config.agentName;

  if (config.cli === "claude") {
    ensureClaudeSettings(join(process.env.HOME || "/root", ".claude", "settings.json"));
  }

  const { command, args } = buildCliArgs(config, prompt);

  return new Promise((resolve) => {
    const child = spawn(command, args, {
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
        catch { writeToLog(`  [chat] ${line}\n`); }
      }
    });

    child.stderr?.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        if (line.trim()) writeToLog(`  [chat-stderr] ${line}\n`);
      }
    });

    child.on("close", (code) => {
      if (code === 0) dim(`Chat response complete for DM #${dmId}`);
      else err(`Chat Claude exited with code ${code} for DM #${dmId}`);
      resolve();
    });

    child.on("error", (e) => {
      err(`Chat spawn error: ${(e as Error).message}`);
      resolve();
    });
  });
}

// ── Chat poll ───────────────────────────────────────────────────
async function chatPoll(config: AgentConfig): Promise<void> {
  if (chatBusy) return;
  chatBusy = true;

  try {
    const data = await lota("GET", "/sync") as SyncResult;
    const dmTasks = (data.in_progress || []).filter(t => t.title.startsWith("DM:"));

    for (const dm of dmTasks) {
      const currentCount = dm.comment_count ?? 0;
      const lastSeen = chatBaselines.get(dm.id);

      if (lastSeen === undefined) {
        // First time seeing this DM — set baseline, don't trigger
        chatBaselines.set(dm.id, currentCount);
        continue;
      }

      if (currentCount > lastSeen) {
        ok(`💬 DM #${dm.id} has ${currentCount - lastSeen} new message(s)`);
        chatBaselines.set(dm.id, currentCount);
        await handleDMMessages(dm.id, config);
        // Update baseline after our response
        try {
          const updated = await lota("GET", `/tasks/${dm.id}`) as TaskDetail;
          chatBaselines.set(dm.id, updated.comments?.length ?? currentCount);
        } catch (e) {
          logNonCritical(`refresh chat baseline for DM #${dm.id}`, e);
        }
      }
    }

    // ── Notify DMs about completed tasks ────────────────────────
    const completed = (data.recently_completed || []).filter(t => !t.title.startsWith("DM:"));

    if (firstPoll) {
      // Baseline: mark all currently completed tasks as already notified
      for (const task of completed) notifiedCompletions.add(task.id);
      firstPoll = false;
    } else {
      // Collect new completions
      const newCompletions = completed.filter(t => !notifiedCompletions.has(t.id));
      for (const t of newCompletions) notifiedCompletions.add(t.id);

      if (newCompletions.length && dmTasks.length) {
        // Batch into a single comment per DM
        const lines = newCompletions.map(t => `✅ #${t.id}: ${t.title}`);
        const content = lines.join("\n");

        for (const dm of dmTasks) {
          try {
            await lota("POST", `/tasks/${dm.id}/comment`, { content });
            // Re-fetch to get accurate baseline after our comment
            const updated = await lota("GET", `/tasks/${dm.id}`) as TaskDetail;
            chatBaselines.set(dm.id, updated.comments?.length ?? 0);
          } catch (e) {
            logNonCritical(`notify DM #${dm.id} about completions`, e);
          }
        }
      }
    }
  } catch (e) {
    logNonCritical("chat poll", e);
  } finally {
    chatBusy = false;
  }
}

// ── Public API ──────────────────────────────────────────────────
export function startChatLoop(config: AgentConfig): void {
  // Set env vars for lota() calls
  process.env.GITHUB_TOKEN = config.ghAuth;
  process.env.GITHUB_REPO = config.githubRepo;
  process.env.AGENT_NAME = config.agentName;

  const intervalMs = (config.chatInterval || 3) * 1000;
  ok("Chat loop started");
  chatTimer = setInterval(() => chatPoll(config), intervalMs);
}

export function stopChatLoop(): void {
  if (chatTimer) {
    clearInterval(chatTimer);
    chatTimer = null;
    dim("Chat loop stopped");
  }
}

#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { lota, getRateLimitInfo } from "./github.js";
import { tgSend, tgSetupChatId, tgWaitForApproval } from "./telegram.js";
import { LOG_FILE, LOG_DIR, log, ok, dim, err, logNonCritical, writeLog, logMemory, periodicGcHint, closeLog } from "./logging.js";
import { checkForWork, refreshCommentBaselines } from "./comments.js";
import { recoverStaleTasks, checkRuntimeStaleTasks } from "./recovery.js";
import { runClaude, getCurrentProcess, resetBusy, wasRateLimited } from "./process.js";
import { startChatLoop, stopChatLoop } from "./chat.js";
import { startOrchestratorLoop, stopOrchestratorLoop } from "./orchestrator.js";
import { evaluatePlan, extractSignals, getFailureCount } from "./evaluation.js";
import type { AgentConfig, AgentMode, CliType, WorkData } from "./types.js";

const MS_PER_MINUTE = 60_000;

// ── PID registry ─────────────────────────────────────────────────
export const AGENTS_DIR = join(LOG_DIR, ".agents");
mkdirSync(AGENTS_DIR, { recursive: true });

function getPidFile(name: string): string {
  return join(AGENTS_DIR, `${name}.pid`);
}

function checkAndCleanStalePid(name: string): void {
  const pidFile = getPidFile(name);
  if (!existsSync(pidFile)) return;
  try {
    const data = JSON.parse(readFileSync(pidFile, "utf-8")) as { pid?: number; started?: string };
    const pid = data.pid;
    if (typeof pid !== "number") {
      dim(`Removing malformed PID file for "${name}"`);
      try { unlinkSync(pidFile); } catch (e) { logNonCritical("remove malformed PID file", e); }
      return;
    }
    try {
      process.kill(pid, 0);
      log(`⚠️ Another instance of "${name}" may already be running (PID ${pid})`);
      if (data.started) log(`   Started: ${data.started}`);
      log(`   If it crashed, delete: ${pidFile}`);
    } catch (killErr) {
      const code = (killErr as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        dim(`Cleaning up stale PID file for "${name}" (PID ${pid} is dead)`);
        try { unlinkSync(pidFile); } catch (e) { logNonCritical("remove stale PID file", e); }
      } else if (code === "EPERM") {
        log(`⚠️ Agent "${name}" may already be running (PID ${pid}, EPERM)`);
      }
    }
  } catch (e) {
    logNonCritical("check PID file", e);
    try { unlinkSync(pidFile); } catch (e) { logNonCritical("remove corrupted PID file", e); }
  }
}

function writePidFile(name: string, model: string, cli: CliType = "claude"): void {
  try {
    writeFileSync(getPidFile(name), JSON.stringify({ pid: process.pid, name, started: new Date().toISOString(), model, cli }, null, 2) + "\n", { mode: 0o644 });
    dim(`PID file: ${getPidFile(name)}`);
  } catch (e) { logNonCritical("write PID file", e); }
}

function removePidFile(name: string): void {
  try {
    if (existsSync(getPidFile(name))) { unlinkSync(getPidFile(name)); dim(`PID file removed: ${getPidFile(name)}`); }
  } catch (e) { logNonCritical("remove PID file", e); }
}

// ── Argument parsing ─────────────────────────────────────────────
function loadCredentials(configPath: string, nameOverride: string): Pick<AgentConfig, "ghAuth" | "githubRepo" | "agentName" | "tgAuth" | "telegramChatId"> {
  const expandEnv = (val: string): string => val.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] || "");

  const creds = { ghAuth: "", githubRepo: "", agentName: "", tgAuth: "", telegramChatId: "" };

  if (configPath) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      const env = cfg.mcpServers?.lota?.env || {};
      creds.ghAuth = expandEnv(env.GITHUB_TOKEN || "");
      creds.githubRepo = expandEnv(env.GITHUB_REPO || "");
      creds.agentName = expandEnv(env.AGENT_NAME || "");
      creds.tgAuth = expandEnv(env.TELEGRAM_BOT_TOKEN || "");
      creds.telegramChatId = expandEnv(env.TELEGRAM_CHAT_ID || "");
    } catch (e) { console.error(`Warning: could not read ${configPath}: ${(e as Error).message}`); }
  }

  if (!creds.ghAuth) creds.ghAuth = process.env.GITHUB_TOKEN || "";
  if (!creds.ghAuth) {
    try { creds.ghAuth = execSync("gh auth token 2>/dev/null", { encoding: "utf-8" }).trim(); }
    catch (e) { logNonCritical("gh auth", e); }
  }
  if (!creds.ghAuth) {
    console.error("Error: No authentication found. Checked: .mcp.json, environment variable, gh CLI");
    process.exit(1);
  }

  if (!creds.githubRepo) creds.githubRepo = process.env.GITHUB_REPO || "xliry/lota-agents";
  if (!creds.agentName) creds.agentName = process.env.AGENT_NAME || "lota";
  if (nameOverride) creds.agentName = nameOverride;

  return creds;
}

function parseArgs(): AgentConfig {
  const args = process.argv.slice(2);
  let interval = 15, once = false, mcpConfig = "", model = "sonnet";
  let mode: AgentMode = "auto", maxTasksPerCycle = 1, singlePhaseOverride: boolean | null = null;
  let maxRssMb = 1024, nameOverride = "", useWorktree = false, chatInterval = 3;
  let cli: CliType = "claude";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--interval": case "-i": interval = parseInt(args[++i], 10); break;
      case "--once": case "-1": once = true; break;
      case "--config": case "-c": mcpConfig = args[++i]; break;
      case "--model": case "-m": model = args[++i]; break;
      case "--mode": mode = args[++i] as AgentMode; break;
      case "--max-tasks": case "-t": maxTasksPerCycle = Math.max(1, parseInt(args[++i], 10)); break;
      case "--single-phase": singlePhaseOverride = true; break;
      case "--no-single-phase": singlePhaseOverride = false; break;
      case "--max-rss": maxRssMb = parseInt(args[++i], 10); break;
      case "--name": case "-n": nameOverride = args[++i]; break;
      case "--worktree": useWorktree = true; break;
      case "--chat-interval": chatInterval = parseInt(args[++i], 10); break;
      case "--cli": cli = args[++i] as CliType; break;
      case "--help": case "-h":
        console.log(`Usage: lota-agent [options]

Autonomous LOTA agent (GitHub-backed).
Listens for assigned tasks, plans, executes, and reports.

Options:
  -n, --name <name>     Agent identity (default: lota). Sets log file, PID file, and task label filter.
  -c, --config <path>   MCP config file (default: .mcp.json)
  -m, --model <model>   Claude model (default: sonnet)
  -i, --interval <sec>  Poll interval in seconds (default: 15)
  -t, --max-tasks <n>   Max tasks per execute cycle (default: 1)
  --mode <auto|supervised>  auto = direct execution, supervised = Telegram approval (default: auto)
  --single-phase        Merge plan+execute into one Claude invocation (default: off — plan first, then execute)
  --no-single-phase     Use separate plan→approve→execute phases (this is now the default)
  --worktree            Use git worktree isolation (default: simple branch strategy)
  --chat-interval <sec> Chat loop poll interval in seconds (default: 3)
  --cli <claude|gemini> CLI to spawn for tasks (default: claude)
  -1, --once            Run once then exit
  -h, --help            Show this help`);
        process.exit(0);
    }
  }

  const singlePhase = singlePhaseOverride !== null ? singlePhaseOverride : false;

  function findMcpConfig(): string {
    let dir = process.cwd();
    while (true) {
      const candidate = join(dir, ".mcp.json");
      if (existsSync(candidate)) return candidate;
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
    const home = resolve(process.env.HOME || "~", ".mcp.json");
    return existsSync(home) ? home : "";
  }
  const configPath = mcpConfig ? resolve(mcpConfig) : findMcpConfig();

  if (mode === "supervised") {
    const creds = loadCredentials(configPath, nameOverride);
    if (!creds.tgAuth) {
      console.log("\n  Supervised mode requires Telegram. Let's set it up:\n");
      console.log("  1. Open @BotFather on Telegram, send /newbot");
      console.log("  2. Name it anything (e.g. 'My Lota')");
      console.log("  3. Add bot credentials to .mcp.json (mcpServers → lota → env)");
      console.log("  4. Run again with --mode supervised\n");
      process.exit(1);
    }
  }

  const creds = loadCredentials(configPath, nameOverride);
  return { configPath, model, cli, interval, once, mode, singlePhase, maxTasksPerCycle, maxRssMb, useWorktree, chatInterval, ...creds };
}

// ── Shutdown ─────────────────────────────────────────────────────
let stopped = false;
let sleepResolve: (() => void) | null = null;
let activeAgentName = "";

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    const cp = getCurrentProcess();
    if (stopped) {
      if (cp) cp.kill("SIGKILL");
      if (activeAgentName) removePidFile(activeAgentName);
      closeLog();
      process.exit(0);
    }
    stopped = true;
    log("Shutting down...");
    stopChatLoop();
    stopOrchestratorLoop();
    if (activeAgentName) removePidFile(activeAgentName);
    if (cp) {
      cp.kill("SIGTERM");
      setTimeout(() => { getCurrentProcess()?.kill("SIGKILL"); closeLog(); process.exit(0); }, 5000);
    }
    sleepResolve?.();
  });
}

const MS_PER_SECOND = 1000;
function sleep(sec: number): Promise<void> {
  return new Promise((r) => {
    sleepResolve = r;
    setTimeout(() => { sleepResolve = null; r(); }, sec * MS_PER_SECOND);
  });
}

// ── Crash retry tracking ─────────────────────────────────────────
const MAX_CRASH_RETRIES = 3;
const crashCounts = new Map<number, number>();

// ── Rate limit backoff ───────────────────────────────────────────
let consecutiveRateLimits = 0;
const RATE_LIMIT_WAIT_TIERS = [2, 5, 15, 30]; // minutes

function getRateLimitWaitMinutes(): number {
  const idx = Math.min(consecutiveRateLimits, RATE_LIMIT_WAIT_TIERS.length - 1);
  return RATE_LIMIT_WAIT_TIERS[idx];
}

// ── Main loop helpers ────────────────────────────────────────────
function printBanner(config: AgentConfig): void {
  const modeLabel = config.mode === "supervised"
    ? "supervised (Telegram)"
    : config.singlePhase ? "autonomous (single-phase)" : "autonomous (plan→approve→execute)";
  const _home = process.env.HOME || "/root";
  const prettyPath = (p: string) => p.startsWith(_home) ? "~" + p.slice(_home.length) : p;
  const lines = [
    "",
    "  ┌─────────────────────────┐",
    "  │         Lota            │",
    "  └─────────────────────────┘",
    `  agent:    ${config.agentName}`,
    `  mode:     ${modeLabel}`,
    `  cli:      ${config.cli}`,
    `  model:    ${config.model}`,
    `  config:   ${config.configPath}`,
    `  interval: ${config.interval}s`,
    `  max-tasks: ${config.maxTasksPerCycle} per cycle`,
    `  log:      ${prettyPath(LOG_FILE)}`,
    `  pid:      ${prettyPath(getPidFile(config.agentName))}`,
    "",
  ];
  for (const line of lines) writeLog(line, line);
}

async function logWorkActivity(work: WorkData, config: AgentConfig): Promise<void> {
  const taskCount = work.tasks.length;
  const commentCount = work.commentUpdates.length;

  if (work.phase === "comments") {
    ok(`${commentCount} task(s) have new comments`);
    for (const cu of work.commentUpdates) dim(`  💬 #${cu.id}: ${cu.title} (${cu.new_comment_count} new)`);
    if (config.mode === "supervised") {
      for (const cu of work.commentUpdates) {
        try { await tgSend(config, `💬 New comment on task #${cu.id}: ${cu.title}`); }
        catch (e) { err(`Telegram send failed: ${(e as Error).message}`); }
      }
    }
  } else if (work.phase === "single") {
    ok(`${taskCount} new task(s) — single-phase (explore+execute)`);
    for (const t of work.tasks) dim(`  ⚡ #${t.id}: ${t.title}`);
  } else if (work.phase === "plan") {
    ok(`${taskCount} new task(s) — creating plans for approval`);
    for (const t of work.tasks) dim(`  📋 #${t.id}: ${t.title}`);
  } else if (work.phase === "execute") {
    ok(`${taskCount} task(s) — executing`);
    for (const t of work.tasks) dim(`  🚀 #${t.id}: ${t.title}`);
    if (config.mode === "supervised") {
      for (const t of work.tasks) {
        try { await tgSend(config, `🚀 Executing task #${t.id}: ${t.title}`); }
        catch (e) { err(`Telegram send failed: ${(e as Error).message}`); }
      }
    }
  }
}

async function handleCycleResult(code: number, work: WorkData, elapsed: number, config: AgentConfig): Promise<void> {
  if (code === 0) {
    consecutiveRateLimits = 0;
    ok(`${work.phase} phase complete in ${elapsed}s`);

    if (config.mode === "auto" && work.phase === "plan") {
      for (const t of work.tasks) {
        // Evaluate plan quality before auto-approving (megaplan pattern)
        const failures = getFailureCount(t.workspace || "");
        const signals = extractSignals(t.plan, t.body || "", failures);
        const evaluation = evaluatePlan(signals);

        if (evaluation.recommendation === "APPROVE") {
          ok(`Task #${t.id} plan evaluated: ${evaluation.recommendation} (${evaluation.confidence}) — auto-approving`);
          try {
            await lota("POST", `/tasks/${t.id}/status`, { status: "approved" });
          } catch (e) { err(`Auto-approve failed for task #${t.id}: ${(e as Error).message}`); }
        } else if (evaluation.recommendation === "REJECT") {
          err(`Task #${t.id} plan evaluated: REJECT — ${evaluation.rationale}`);
          try {
            await lota("POST", `/tasks/${t.id}/comment`, {
              content: `⚠️ **Plan rejected by evaluation**: ${evaluation.rationale}\n\nPlease revise the plan with more specific goals and file paths.`,
            });
            await lota("POST", `/tasks/${t.id}/status`, { status: "assigned" });
          } catch (e) { err(`Reject feedback failed for task #${t.id}: ${(e as Error).message}`); }
        } else {
          // ESCALATE — leave as planned, user will review via Hub
          log(`⚠️ Task #${t.id} plan escalated: ${evaluation.rationale}`);
        }
      }
    }

    if (config.mode === "supervised" && work.phase === "plan") {
      for (const t of work.tasks) {
        ok(`Waiting for Telegram approval for task #${t.id}...`);
        const approved = await tgWaitForApproval(config, t.id, t.title);
        if (approved) {
          await lota("POST", `/tasks/${t.id}/status`, { status: "approved" });
          ok(`Task #${t.id} approved via Telegram`);
        } else {
          ok(`Task #${t.id} rejected via Telegram — skipping`);
        }
      }
    }

    if (config.mode === "supervised" && (work.phase === "execute" || work.phase === "single")) {
      for (const t of work.tasks) {
        try { await tgSend(config, `✅ Task #${t.id} completed: ${t.title}`); }
        catch (e) { err(`Telegram send failed: ${(e as Error).message}`); }
      }
    }
  } else if (wasRateLimited()) {
    // Rate limit — don't count as crash, wait and retry
    consecutiveRateLimits++;
    const waitMinutes = getRateLimitWaitMinutes();
    log(`⏳ Rate limited — waiting ${waitMinutes}m before retrying (consecutive: ${consecutiveRateLimits})`);

    for (const t of work.tasks) {
      lota("POST", `/tasks/${t.id}/comment`, {
        content: `⏳ Rate limited — agent will retry in ${waitMinutes} minutes.`,
      }).catch(e => dim(`Comment failed for task #${t.id}: ${(e as Error).message}`));
      lota("POST", `/tasks/${t.id}/status`, { status: "assigned" }).catch(e => dim(`Status reset failed for task #${t.id}: ${(e as Error).message}`));
    }

    await sleep(waitMinutes * 60);
  } else {
    consecutiveRateLimits = 0;
    err(`Claude exited with code ${code} after ${elapsed}s`);
    if (config.mode === "supervised") {
      try { await tgSend(config, `❌ Error: Claude exited with code ${code} after ${elapsed}s`); }
      catch (e) { err(`Telegram send failed: ${(e as Error).message}`); }
    }
    for (const t of work.tasks) {
      // Check current status — task may have been completed before the crash
      try {
        const current = await lota("GET", `/tasks/${t.id}`) as { status: string; report?: unknown };
        if (current.status === "completed" || current.report) {
          dim(`Task #${t.id} already completed — skipping crash reset`);
          continue;
        }
      } catch (e) { logNonCritical(`check task #${t.id} status`, e); }

      const crashes = (crashCounts.get(t.id) ?? 0) + 1;
      crashCounts.set(t.id, crashes);

      if (crashes >= MAX_CRASH_RETRIES) {
        err(`Task #${t.id} crashed ${crashes} times — marking as failed`);
        lota("POST", `/tasks/${t.id}/comment`, {
          content: `❌ Task failed after ${crashes} crashes (exit code ${code}). Manual review needed.`,
        }).catch(e => dim(`Comment failed for task #${t.id}: ${(e as Error).message}`));
        lota("POST", `/tasks/${t.id}/status`, { status: "failed" }).catch(e => dim(`Status update failed for task #${t.id}: ${(e as Error).message}`));
        crashCounts.delete(t.id);
      } else {
        lota("POST", `/tasks/${t.id}/comment`, {
          content: `⚠️ Agent crashed (exit code ${code}). Retry ${crashes}/${MAX_CRASH_RETRIES}.`,
        }).catch(e => dim(`Comment failed for task #${t.id}: ${(e as Error).message}`));
        lota("POST", `/tasks/${t.id}/status`, { status: "assigned" }).catch(e => dim(`Status reset failed for task #${t.id}: ${(e as Error).message}`));
      }
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  const config = parseArgs();
  activeAgentName = config.agentName;

  checkAndCleanStalePid(config.agentName);
  writePidFile(config.agentName, config.model, config.cli);

  if (config.mode === "supervised" && !config.telegramChatId) {
    try { config.telegramChatId = await tgSetupChatId(config); ok("Telegram connected!"); }
    catch (e) { err((e as Error).message); process.exit(1); }
  }

  printBanner(config);
  log("━━━ Agent active, waiting for tasks ━━━");
  console.log("");

  if (config.mode === "supervised") {
    try { await tgSend(config, "🤖 Lota is online. Watching for tasks."); }
    catch (e) { err(`Telegram send failed: ${(e as Error).message}`); }
  }

  await recoverStaleTasks(config);

  startChatLoop(config);
  startOrchestratorLoop(config);

  let emptyPolls = 0;
  let pollCycles = 0;

  const getIntervalMultiplier = (empty: number): number => {
    if (empty < 20) return Math.min(empty, 4);    // 15s → 60s
    if (empty < 50) return 10;                      // 150s
    return 20;                                       // 300s (5 min)
  };

  while (!stopped) {
    pollCycles++;
    let work: WorkData | null;
    try {
      work = await checkForWork(config);
    } catch (e) {
      err(`Pre-check failed: ${(e as Error).message}`);
      if (config.once) break;
      await sleep(config.interval);
      continue;
    }

    if (!work) {
      emptyPolls++;
      const nextInterval = config.interval * getIntervalMultiplier(emptyPolls);
      if (emptyPolls === 1 || emptyPolls % 10 === 0) dim(`No pending work (${emptyPolls} checks) — next in ${nextInterval}s`);
      if (pollCycles % 10 === 0) { logMemory("Periodic", config); periodicGcHint(); await checkRuntimeStaleTasks(config); }
      if (config.once) break;
      await sleep(nextInterval);
      continue;
    }

    emptyPolls = 0;
    await logWorkActivity(work, config);
    console.log("  ─────────────────────────────────────");
    logMemory("Pre-Claude", config);

    // Extract PR body template from task body and write to /tmp for the agent
    if (work.tasks.length > 0) {
      const task = work.tasks[0];
      let body = task.body || "";
      // /sync strips body — fetch full task if body is missing
      if (!body) {
        try {
          const full = await lota("GET", `/tasks/${task.id}`) as { body?: string };
          body = full.body || "";
        } catch (e) { logNonCritical(`fetch body for template extraction #${task.id}`, e); }
      }
      if (body) {
        const templateRegex = /```\n(\*\*(?:Issue|Submission):\*\*[\s\S]*?)```/;
        const match = body.match(templateRegex);
        if (match) {
          const templatePath = `/tmp/pr-template-${task.id}.md`;
          writeFileSync(templatePath, match[1].trim() + "\n");
          dim(`PR template extracted → ${templatePath} (${match[1].length} chars)`);
        }
      }
    }

    const cycleStart = Date.now();
    let code: number;
    try {
      code = await runClaude(config, work);
    } catch (e) {
      err(`runClaude threw an unexpected error: ${(e as Error).message ?? String(e)}`);
      resetBusy();
      if (config.once) break;
      await sleep(config.interval);
      continue;
    }

    const elapsed = Math.round((Date.now() - cycleStart) / MS_PER_SECOND);
    logMemory("Post-Claude", config);
    console.log("  ─────────────────────────────────────");

    await handleCycleResult(code, work, elapsed, config);

    const processedIds = [...work.tasks.map(t => t.id), ...work.commentUpdates.map(cu => cu.id)];
    if (processedIds.length) await refreshCommentBaselines(processedIds);

    if (config.once) break;

    if (pollCycles % 10 === 0) {
      const rl = getRateLimitInfo();
      if (rl) {
        const resetIn = Math.max(0, Math.round((rl.reset * MS_PER_SECOND - Date.now()) / MS_PER_MINUTE));
        dim(`Rate limit: ${rl.remaining}/${rl.limit} remaining (resets in ${resetIn}m)`);
      }
      logMemory("Periodic", config);
      await checkRuntimeStaleTasks(config);
    }

    dim(`Polling in ${config.interval}s...`);
    await sleep(config.interval);
  }
}

main().catch((e) => {
  err(`Fatal: ${(e as Error).message}`);
  process.exit(1);
});

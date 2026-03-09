#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { lota } from "./github.js";

// ── ANSI colors ──────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  white: "\x1b[37m",
} as const;

// ── Types ────────────────────────────────────────────────────
interface SyncTask {
  id: number;
  title: string;
  status: string;
  assignee: string | null;
  comment_count?: number;
}

interface SyncResult {
  assigned: SyncTask[];
  approved: SyncTask[];
  in_progress: SyncTask[];
  failed: SyncTask[];
  blocked: SyncTask[];
  recently_completed: SyncTask[];
}

interface TaskDetail {
  id: number;
  title: string;
  status: string;
  assignee: string | null;
  body: string;
  comments: { body: string; created_at: string; user: string }[];
}

interface TaskState {
  status: string;
  comment_count: number;
  title: string;
  assignee: string | null;
}

// ── Credential loading ───────────────────────────────────────
function loadCredentials(): void {
  let ghAuth = "";
  let githubRepo = "";

  const findMcpConfig = (): string => {
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
  };

  const configPath = findMcpConfig();
  if (configPath) {
    try {
      const expandEnv = (val: string): string =>
        val.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k as string] || "");
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      const env = cfg.mcpServers?.lota?.env || {};
      ghAuth = expandEnv(env.GITHUB_TOKEN || "");
      githubRepo = expandEnv(env.GITHUB_REPO || "");
    } catch { /* ignore */ }
  }

  if (!ghAuth) ghAuth = process.env.GITHUB_TOKEN || "";
  if (!ghAuth) {
    try {
      ghAuth = execSync("gh auth token 2>/dev/null", { encoding: "utf-8" }).trim();
    } catch { /* ignore */ }
  }

  if (!ghAuth) {
    console.error("Error: No GitHub token found. Checked: .mcp.json, GITHUB_TOKEN env, gh CLI");
    process.exit(1);
  }

  process.env.GITHUB_TOKEN = ghAuth;
  process.env.GITHUB_REPO = githubRepo || process.env.GITHUB_REPO || "xliry/lota-agents";
  process.env.AGENT_NAME = process.env.AGENT_NAME || "lota";
}

// ── State tracking ───────────────────────────────────────────
const knownState = new Map<number, TaskState>();
let focusedTask: number | null = null;

function timestamp(): string {
  const d = new Date();
  return `${C.dim}${d.toLocaleTimeString("en-GB", { hour12: false })}${C.reset}`;
}

function promptText(): string {
  if (focusedTask) return `${C.cyan}#${focusedTask}${C.reset}${C.dim}>${C.reset} `;
  return `${C.dim}lota>${C.reset} `;
}

// ── tmux notification to other panes ─────────────────────────
function tmuxNotify(msg: string): void {
  // Strip ANSI codes for tmux display-message
  const clean = msg.replace(/\x1b\[[0-9;]*m/g, "");
  try {
    execSync(`tmux display-message -d 5000 ${JSON.stringify(clean)}`, { stdio: "ignore" });
  } catch { /* not in tmux or tmux error — ignore */ }
}

// ── Fetch new comment content ────────────────────────────────
async function fetchNewComments(taskId: number, knownCount: number): Promise<void> {
  try {
    const task = await lota("GET", `/tasks/${taskId}`) as TaskDetail;
    const newComments = task.comments.slice(knownCount);
    for (const c of newComments) {
      const lines = c.body.split("\n").filter(l => l.trim()).slice(0, 2);
      const preview = lines.join(" ").slice(0, 200);
      const line = `💬 #${taskId} ${c.user}: ${preview}`;
      console.log(`${timestamp()}  ${C.cyan}💬${C.reset} ${C.bold}#${taskId}${C.reset} ${C.green}${c.user}${C.reset}: ${preview}${c.body.length > 200 ? "…" : ""}`);
      tmuxNotify(line);
    }
  } catch {
    console.log(`${timestamp()}  ${C.cyan}💬${C.reset} ${C.bold}#${taskId}${C.reset} ${C.dim}(new comments)${C.reset}`);
  }
}

async function detectChanges(sync: SyncResult): Promise<void> {
  const allTasks: SyncTask[] = [
    ...sync.assigned,
    ...sync.approved,
    ...sync.in_progress,
    ...sync.failed,
    ...sync.blocked,
    ...sync.recently_completed,
  ];

  for (const task of allTasks) {
    const prev = knownState.get(task.id);
    const commentCount = task.comment_count ?? 0;

    if (!prev) {
      if (task.status === "assigned") {
        const msg = `📌 NEW #${task.id} "${task.title}" → ${task.assignee || "unassigned"}`;
        console.log(`${timestamp()}  ${C.green}📌 NEW${C.reset}     #${task.id}  "${task.title}"  ${C.dim}→ ${task.assignee || "unassigned"}${C.reset}`);
        tmuxNotify(msg);
      }
    } else {
      if (prev.status !== task.status) {
        const icon = statusIcon(task.status);
        const statusEmoji = task.status === "completed" ? "✅" : task.status === "in-progress" ? "🚀" : task.status === "approved" ? "✅" : "📋";
        const msg = `${statusEmoji} #${task.id} ${task.status.toUpperCase()} "${task.title}"`;
        console.log(`${timestamp()}  ${icon}  #${task.id}  "${task.title}"  ${C.dim}→ ${task.assignee || ""}${C.reset}`);
        tmuxNotify(msg);
      }

      if (commentCount > prev.comment_count) {
        await fetchNewComments(task.id, prev.comment_count);
      }
    }

    knownState.set(task.id, {
      status: task.status,
      comment_count: commentCount,
      title: task.title,
      assignee: task.assignee,
    });
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case "assigned": return `${C.green}📌 NEW${C.reset}    `;
    case "planned": return `${C.yellow}📋 PLAN${C.reset}   `;
    case "approved": return `${C.blue}✅ APPROVE${C.reset}`;
    case "in-progress": return `${C.magenta}🚀 START${C.reset} `;
    case "completed": return `${C.green}✅ DONE${C.reset}   `;
    case "failed": return `${C.red}❌ FAIL${C.reset}   `;
    case "blocked": return `${C.yellow}🔒 BLOCK${C.reset} `;
    default: return `${C.dim}❓ ${status.toUpperCase().padEnd(7)}${C.reset}`;
  }
}

// ── Dashboard display ────────────────────────────────────────
function printDashboard(sync: SyncResult): void {
  const line = "──────────────────────────────────";
  console.log(`\n${C.bold}Lota Live Hub${C.reset} — polling every 10s`);
  console.log(line);
  console.log(`  ${C.green}Assigned:${C.reset}     ${sync.assigned.length} task(s)`);
  console.log(`  ${C.blue}Approved:${C.reset}     ${sync.approved.length} task(s)`);
  console.log(`  ${C.magenta}In Progress:${C.reset}  ${sync.in_progress.length} task(s)`);
  console.log(`  ${C.yellow}Blocked:${C.reset}      ${sync.blocked.length} task(s)`);
  console.log(`  ${C.red}Failed:${C.reset}       ${sync.failed.length} task(s)`);
  console.log(`  ${C.dim}Completed:${C.reset}    ${sync.recently_completed.length} recent`);
  console.log(line);

  const all = [
    ...sync.assigned,
    ...sync.approved,
    ...sync.in_progress,
    ...sync.failed,
    ...sync.blocked,
  ];
  if (all.length) {
    for (const t of all) {
      const badge = statusBadge(t.status);
      console.log(`  ${badge} #${t.id}  ${t.title}  ${C.dim}${t.assignee || ""}${C.reset}`);
    }
    console.log(line);
  }

  if (focusedTask) {
    console.log(`  ${C.cyan}Focused on #${focusedTask}${C.reset} — type a message to reply, "unfocus" to leave`);
  } else {
    console.log(`  ${C.dim}Type "help" for commands, or "#241 mesaj" for quick reply${C.reset}`);
  }
  console.log("");
}

function statusBadge(status: string): string {
  switch (status) {
    case "assigned": return `${C.green}[assigned]${C.reset}   `;
    case "approved": return `${C.blue}[approved]${C.reset}   `;
    case "in-progress": return `${C.magenta}[in-progress]${C.reset}`;
    case "failed": return `${C.red}[failed]${C.reset}     `;
    case "blocked": return `${C.yellow}[blocked]${C.reset}    `;
    default: return `${C.dim}[${status}]${C.reset}`.padEnd(22);
  }
}

// ── Commands ─────────────────────────────────────────────────
async function handleCommand(input: string, rl: ReturnType<typeof createInterface>): Promise<void> {
  const trimmed = input.trim();
  if (!trimmed) return;

  // ── Focus mode: any text goes as comment to focused task ───
  if (focusedTask) {
    const lower = trimmed.toLowerCase();

    // Commands that work inside focus mode
    if (lower === "unfocus" || lower === "uf") {
      const old = focusedTask;
      focusedTask = null;
      console.log(`${C.dim}Unfocused from #${old}${C.reset}`);
      rl.setPrompt(promptText());
      return;
    }
    if (lower === "help" || lower === "list" || lower === "quit" || lower === "exit" || lower === "q") {
      // pass through to normal command handler
    } else if (lower === "approve") {
      await lota("POST", `/tasks/${focusedTask}/status`, { status: "approved" });
      console.log(`${C.green}Task #${focusedTask} approved${C.reset}`);
      return;
    } else if (lower === "reject") {
      await lota("POST", `/tasks/${focusedTask}/status`, { status: "assigned" });
      console.log(`${C.yellow}Task #${focusedTask} rejected → assigned${C.reset}`);
      return;
    } else if (lower === "show") {
      await showTask(focusedTask);
      return;
    } else {
      // Everything else is a message to the focused task
      try {
        await lota("POST", `/tasks/${focusedTask}/comment`, { content: trimmed });
        console.log(`${C.dim}→ sent to #${focusedTask}${C.reset}`);
      } catch (e) {
        console.error(`${C.red}Error: ${(e as Error).message}${C.reset}`);
      }
      return;
    }
  }

  // ── Quick reply: "#241 mesaj" or "241 mesaj" ───────────────
  const quickMatch = trimmed.match(/^#?(\d+)\s+(.+)/);
  if (quickMatch) {
    const id = parseInt(quickMatch[1], 10);
    const message = quickMatch[2];
    try {
      await lota("POST", `/tasks/${id}/comment`, { content: message });
      console.log(`${C.dim}→ sent to #${id}${C.reset}`);
    } catch (e) {
      console.error(`${C.red}Error: ${(e as Error).message}${C.reset}`);
    }
    return;
  }

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  try {
    switch (cmd) {
      case "help":
        console.log(`
${C.bold}Chat:${C.reset}
  ${C.cyan}#241 mesaj${C.reset}  or  ${C.cyan}241 mesaj${C.reset}     Quick reply to any task
  ${C.cyan}focus <id>${C.reset}  or  ${C.cyan}f <id>${C.reset}        Focus on a task — then just type to chat
  ${C.cyan}unfocus${C.reset}     or  ${C.cyan}uf${C.reset}            Leave focus mode

${C.bold}Tasks:${C.reset}
  ${C.cyan}list${C.reset}                              Dashboard overview
  ${C.cyan}show <id>${C.reset}                         Task details + recent comments
  ${C.cyan}approve <id>${C.reset}                      Approve a planned task
  ${C.cyan}reject <id>${C.reset}                       Reject → reassign
  ${C.cyan}quit${C.reset}                              Exit
`);
        break;

      case "list": {
        const sync = await lota("GET", "/sync?all=true") as SyncResult;
        printDashboard(sync);
        break;
      }

      case "focus":
      case "f": {
        const id = parseInt(parts[1], 10);
        if (isNaN(id)) { console.log(`${C.red}Usage: focus <id>${C.reset}`); break; }
        focusedTask = id;
        console.log(`${C.cyan}Focused on #${id}${C.reset} — type messages to chat, "unfocus" to leave`);
        await showTask(id);
        rl.setPrompt(promptText());
        break;
      }

      case "unfocus":
      case "uf":
        if (focusedTask) {
          const old = focusedTask;
          focusedTask = null;
          console.log(`${C.dim}Unfocused from #${old}${C.reset}`);
          rl.setPrompt(promptText());
        } else {
          console.log(`${C.dim}Not focused on anything${C.reset}`);
        }
        break;

      case "show": {
        const id = parseInt(parts[1], 10);
        if (isNaN(id)) { console.log(`${C.red}Usage: show <id>${C.reset}`); break; }
        await showTask(id);
        break;
      }

      case "reply": {
        const id = parseInt(parts[1], 10);
        const message = parts.slice(2).join(" ");
        if (isNaN(id) || !message) { console.log(`${C.red}Usage: reply <id> <message>${C.reset}`); break; }
        await lota("POST", `/tasks/${id}/comment`, { content: message });
        console.log(`${C.dim}→ sent to #${id}${C.reset}`);
        break;
      }

      case "approve": {
        const id = parseInt(parts[1], 10);
        if (isNaN(id)) { console.log(`${C.red}Usage: approve <id>${C.reset}`); break; }
        await lota("POST", `/tasks/${id}/status`, { status: "approved" });
        console.log(`${C.green}Task #${id} approved${C.reset}`);
        break;
      }

      case "reject": {
        const id = parseInt(parts[1], 10);
        if (isNaN(id)) { console.log(`${C.red}Usage: reject <id>${C.reset}`); break; }
        await lota("POST", `/tasks/${id}/status`, { status: "assigned" });
        console.log(`${C.yellow}Task #${id} rejected → assigned${C.reset}`);
        break;
      }

      case "quit":
      case "exit":
      case "q":
        console.log(`${C.dim}Bye!${C.reset}`);
        process.exit(0);

      default:
        console.log(`${C.dim}Unknown: "${cmd}" — type "help" or "#<id> message" to chat${C.reset}`);
    }
  } catch (e) {
    console.error(`${C.red}Error: ${(e as Error).message}${C.reset}`);
  }
}

async function showTask(id: number): Promise<void> {
  const task = await lota("GET", `/tasks/${id}`) as TaskDetail;
  console.log(`\n${C.bold}#${task.id} — ${task.title}${C.reset}`);
  console.log(`${C.dim}Status: ${task.status} | Assignee: ${task.assignee || "none"}${C.reset}`);

  if (task.body) {
    const bodyPreview = task.body.replace(/<!-- lota:.*?-->/gs, "").trim();
    if (bodyPreview) {
      console.log(`\n${bodyPreview.slice(0, 400)}${bodyPreview.length > 400 ? "…" : ""}`);
    }
  }

  const recent = task.comments.slice(-8);
  if (recent.length) {
    console.log(`\n${C.bold}─── Comments ───${C.reset}`);
    for (const c of recent) {
      const time = new Date(c.created_at).toLocaleTimeString("en-GB", { hour12: false });
      const body = c.body.replace(/<!-- lota:.*?-->/gs, "").trim();
      const lines = body.split("\n").slice(0, 3).join("\n  ");
      console.log(`  ${C.dim}${time}${C.reset} ${C.green}${c.user}${C.reset}:`);
      console.log(`  ${lines.slice(0, 300)}${body.length > 300 ? "…" : ""}`);
    }
    console.log(`${C.bold}────────────────${C.reset}`);
  }
  console.log("");
}

// ── Polling loop ─────────────────────────────────────────────
const POLL_INTERVAL = 10_000;
let polling = true;

async function poll(): Promise<void> {
  try {
    const sync = await lota("GET", "/sync?all=true") as SyncResult;
    await detectChanges(sync);
  } catch (e) {
    console.error(`${C.red}Poll error: ${(e as Error).message}${C.reset}`);
  }
}

// ── Main ─────────────────────────────────────────────────────
async function main(): Promise<void> {
  loadCredentials();

  let initialSync: SyncResult;
  try {
    initialSync = await lota("GET", "/sync?all=true") as SyncResult;
  } catch (e) {
    console.error(`${C.red}Failed to connect: ${(e as Error).message}${C.reset}`);
    process.exit(1);
  }

  // Seed known state
  const allTasks = [
    ...initialSync.assigned,
    ...initialSync.approved,
    ...initialSync.in_progress,
    ...initialSync.failed,
    ...initialSync.blocked,
    ...initialSync.recently_completed,
  ];
  for (const t of allTasks) {
    knownState.set(t.id, {
      status: t.status,
      comment_count: t.comment_count ?? 0,
      title: t.title,
      assignee: t.assignee,
    });
  }

  printDashboard(initialSync);

  // Start polling
  const timer = setInterval(() => { if (polling) poll(); }, POLL_INTERVAL);

  // Interactive readline
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: promptText(),
  });

  rl.prompt();

  rl.on("line", async (line) => {
    polling = false;
    await handleCommand(line, rl);
    polling = true;
    rl.setPrompt(promptText());
    rl.prompt();
  });

  rl.on("close", () => {
    clearInterval(timer);
    console.log(`\n${C.dim}Bye!${C.reset}`);
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(`Fatal: ${(e as Error).message}`);
  process.exit(1);
});

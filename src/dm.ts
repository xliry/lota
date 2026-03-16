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
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
} as const;

// ── Types ────────────────────────────────────────────────────
interface Comment {
  body: string;
  created_at: string;
  user: string;
}

interface TaskDetail {
  id: number;
  title: string;
  status: string;
  comments: Comment[];
}

// ── DM marker — hidden tag to identify our own messages ──────
const DM_MARKER = "<!-- dm-client -->";

function isMyMessage(body: string): boolean {
  return body.includes(DM_MARKER);
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
    console.error("Error: No GitHub token found.");
    process.exit(1);
  }

  process.env.GITHUB_TOKEN = ghAuth;
  process.env.GITHUB_REPO = githubRepo || process.env.GITHUB_REPO || "xliry/lota-agents";
  process.env.AGENT_NAME = process.env.AGENT_NAME || "lota";
}

// ── CLI args ─────────────────────────────────────────────────
function parseArgs(): { agent: string; user: string; resumeId: number | null } {
  const args = process.argv.slice(2);
  let agent = "lota-1";
  let user = "user";
  let resumeId: number | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agent" && args[i + 1]) agent = args[++i];
    if (args[i] === "--user" && args[i + 1]) user = args[++i];
    if (args[i] === "--resume" && args[i + 1]) resumeId = parseInt(args[++i], 10);
  }
  return { agent, user, resumeId };
}

// ── Find or create DM issue ─────────────────────────────────
interface SyncResult {
  in_progress: Array<{ id: number; title: string; status: string; comment_count?: number }>;
  assigned: Array<{ id: number; title: string; status: string }>;
  approved: Array<{ id: number; title: string; status: string }>;
}

async function findExistingDMs(): Promise<Array<{ id: number; title: string; comments: number }>> {
  const sync = await lota("GET", "/sync?all=true") as SyncResult;
  const all = [...sync.in_progress, ...sync.assigned, ...sync.approved];
  return all
    .filter(t => t.title.startsWith("DM:"))
    .map(t => ({ id: t.id, title: t.title, comments: (t as { comment_count?: number }).comment_count ?? 0 }));
}

async function selectOrCreateDM(agent: string, user: string, resumeId: number | null): Promise<number> {
  // Direct resume by ID
  if (resumeId) {
    console.log(`${C.dim}Resuming DM #${resumeId}${C.reset}`);
    return resumeId;
  }

  const existing = await findExistingDMs();

  if (existing.length >= 1) {
    console.log(`\n${C.bold}Active DM channels:${C.reset}`);
    for (let i = 0; i < existing.length; i++) {
      const dm = existing[i];
      console.log(`  ${C.cyan}${i + 1}${C.reset}) #${dm.id}  ${dm.title}  ${C.dim}(${dm.comments} messages)${C.reset}`);
    }
    console.log(`  ${C.green}n${C.reset}) New DM`);
    console.log("");

    const choice = await askLine("Select (number or 'n'): ");
    if (choice.toLowerCase() === "n") {
      return await createNewDM(agent, user);
    }
    const idx = parseInt(choice, 10) - 1;
    if (idx >= 0 && idx < existing.length) {
      console.log(`${C.dim}Reconnecting to DM #${existing[idx].id}${C.reset}`);
      return existing[idx].id;
    }
    // Default to first
    console.log(`${C.dim}Reconnecting to DM #${existing[0].id}${C.reset}`);
    return existing[0].id;
  }

  // No existing DMs
  return await createNewDM(agent, user);
}

function askLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

async function createNewDM(agent: string, user: string): Promise<number> {
  const result = await lota("POST", "/tasks", {
    title: `DM: ${user} ↔ ${agent}`,
    body: `Direct message channel between ${user} and ${agent}.\n\nThis is a live chat — respond to every new comment conversationally.`,
    assign: agent,
  }) as { number: number };

  const id = result.number;
  await lota("POST", `/tasks/${id}/status`, { status: "in-progress" });

  console.log(`${C.green}Created DM #${id} → ${agent}${C.reset}`);
  return id;
}

// ── Display ──────────────────────────────────────────────────
function formatComment(c: Comment, agentName: string, userName: string): string {
  const time = new Date(c.created_at).toLocaleTimeString("en-GB", { hour12: false });
  const mine = isMyMessage(c.body);
  const nameColor = mine ? C.cyan : C.magenta;
  const label = mine ? userName : agentName;
  const body = c.body.replace(/<!-- .*?-->/gs, "").trim();
  const indented = body.split("\n").join("\n  ");
  return `  ${C.dim}${time}${C.reset} ${nameColor}${label}${C.reset}: ${indented}`;
}

function printHeader(dmId: number, agent: string): void {
  console.log(`\n${C.bold}Lota DM${C.reset} — chatting with ${C.magenta}${agent}${C.reset} (issue #${dmId})`);
  console.log(`${C.dim}Type messages to chat. "quit" to exit.${C.reset}`);
  console.log("──────────────────────────────────");
}

// ── Paste debounce ───────────────────────────────────────────
let lineBuffer: string[] = [];
let sendTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 150;

async function flushBuffer(dmId: number, rl: ReturnType<typeof createInterface>): Promise<void> {
  if (lineBuffer.length === 0) return;
  const message = lineBuffer.join("\n");
  lineBuffer = [];
  sendTimer = null;
  polling = false;
  try {
    await lota("POST", `/tasks/${dmId}/comment`, { content: `${message}\n\n${DM_MARKER}` });
    knownCommentCount++;
  } catch (e) {
    console.error(`${C.red}Send error: ${(e as Error).message}${C.reset}`);
  }
  polling = true;
  rl.prompt();
}

// ── Polling ──────────────────────────────────────────────────
const POLL_INTERVAL = 5_000;
let knownCommentCount = 0;
let polling = true;

async function poll(dmId: number, agent: string, userName: string, rl: ReturnType<typeof createInterface>): Promise<void> {
  try {
    const task = await lota("GET", `/tasks/${dmId}`) as TaskDetail;
    const comments = task.comments || [];

    if (comments.length > knownCommentCount) {
      const newComments = comments.slice(knownCommentCount);
      for (const c of newComments) {
        // Skip our own messages in poll (we already displayed them locally)
        if (isMyMessage(c.body)) {
          knownCommentCount++;
          continue;
        }
        // Clear current line, print message, re-prompt
        process.stdout.write("\r\x1b[K");
        console.log(formatComment(c, agent, userName));
        rl.prompt(true);
      }
      knownCommentCount = comments.length;
    }
  } catch (e) {
    console.error(`${C.red}Poll error: ${(e as Error).message}${C.reset}`);
  }
}

// ── Main ─────────────────────────────────────────────────────
async function main(): Promise<void> {
  loadCredentials();
  const { agent, user, resumeId } = parseArgs();

  let dmId: number;
  try {
    dmId = await selectOrCreateDM(agent, user, resumeId);
  } catch (e) {
    console.error(`${C.red}Failed to connect: ${(e as Error).message}${C.reset}`);
    process.exit(1);
  }

  // Load existing comments
  try {
    const task = await lota("GET", `/tasks/${dmId}`) as TaskDetail;
    const comments = task.comments || [];
    printHeader(dmId, agent);
    const recent = comments.slice(-10);
    for (const c of recent) {
      console.log(formatComment(c, agent, user));
    }
    if (comments.length > 10) {
      console.log(`${C.dim}  ... ${comments.length - 10} earlier messages${C.reset}`);
    }
    knownCommentCount = comments.length;
    console.log("──────────────────────────────────\n");
  } catch (e) {
    console.error(`${C.red}Failed to load history: ${(e as Error).message}${C.reset}`);
    printHeader(dmId, agent);
  }

  // Interactive readline
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.cyan}${user}${C.reset}${C.dim}>${C.reset} `,
  });

  // Start polling
  const timer = setInterval(() => { if (polling) poll(dmId, agent, user, rl); }, POLL_INTERVAL);

  rl.prompt();

  rl.on("line", (line) => {
    const trimmed = line.trim();

    if (trimmed === "quit" || trimmed === "exit" || trimmed === "q") {
      if (sendTimer) clearTimeout(sendTimer);
      if (lineBuffer.length > 0) {
        flushBuffer(dmId, rl).then(() => process.exit(0));
        return;
      }
      console.log(`${C.dim}Bye!${C.reset}`);
      process.exit(0);
    }

    lineBuffer.push(line);
    if (sendTimer) clearTimeout(sendTimer);
    sendTimer = setTimeout(() => flushBuffer(dmId, rl), DEBOUNCE_MS);
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

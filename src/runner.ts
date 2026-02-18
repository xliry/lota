import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { LotaApiClient } from "./api.js";
import type { Task, Message } from "./types.js";

// ── Logger ──────────────────────────────────────────────────────────

const log = {
  info: (msg: string) => console.log(`[${ts()}] INFO  ${msg}`),
  warn: (msg: string) => console.log(`[${ts()}] WARN  ${msg}`),
  error: (msg: string) => console.error(`[${ts()}] ERROR ${msg}`),
};

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// ── Config ──────────────────────────────────────────────────────────

interface RunnerConfig {
  agentId: string;
  pollInterval: number;
  workDir: string;
  model: string;
  apiUrl: string;
  serviceKey: string;
  webhookPort: number;
  webhookHost: string;
  publicUrl: string;
}

function parseArgs(): RunnerConfig {
  const args = process.argv.slice(2);
  let agentId = "";
  let pollInterval = 15000;
  let workDir = process.cwd();
  let model = "sonnet";
  let webhookPort = 9100;
  let webhookHost = "0.0.0.0";
  let publicUrl = "";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--agent-id":
        agentId = args[++i];
        break;
      case "--poll-interval":
        pollInterval = parseInt(args[++i], 10);
        break;
      case "--work-dir":
        workDir = args[++i];
        break;
      case "--model":
        model = args[++i];
        break;
      case "--webhook-port":
        webhookPort = parseInt(args[++i], 10);
        break;
      case "--webhook-host":
        webhookHost = args[++i];
        break;
      case "--public-url":
        publicUrl = args[++i];
        break;
    }
  }

  const apiUrl = process.env.LOTA_API_URL || "https://lota-five.vercel.app";
  const serviceKey = process.env.LOTA_SERVICE_KEY || "";

  if (!agentId) {
    console.error("Usage: node dist/runner.js --agent-id <id> [--poll-interval <ms>] [--work-dir <path>] [--model <model>] [--webhook-port <port>] [--webhook-host <host>] [--public-url <url>]");
    process.exit(1);
  }
  if (!serviceKey) {
    console.error("Error: LOTA_SERVICE_KEY environment variable is required");
    process.exit(1);
  }

  return { agentId, pollInterval, workDir, model, apiUrl, serviceKey, webhookPort, webhookHost, publicUrl };
}

// ── State ───────────────────────────────────────────────────────────

let config: RunnerConfig;
let api: LotaApiClient;
let currentTask: Task | null = null;
let currentProcess: ChildProcess | null = null;
const processedTaskIds = new Set<string>();
let lastMessageTimestamp: string;
let shuttingDown = false;
let webhookServer: Server | null = null;
let sleepResolve: (() => void) | null = null;

// ── API helpers ─────────────────────────────────────────────────────

async function fetchAssignedTasks(): Promise<Task[]> {
  return api.get<Task[]>("/api/tasks", {
    agentId: config.agentId,
    status: "assigned",
  });
}

async function fetchMessages(): Promise<Message[]> {
  return api.get<Message[]>("/api/messages", {
    agentId: config.agentId,
    since: lastMessageTimestamp,
  });
}

async function fetchTask(taskId: string): Promise<Task> {
  return api.get<Task>(`/api/tasks/${taskId}`);
}

async function updateTaskStatus(taskId: string, status: string): Promise<void> {
  await api.patch(`/api/tasks/${taskId}/status`, { status });
}

async function sendMessage(receiverId: string, content: string): Promise<void> {
  await api.post("/api/messages", {
    sender_agent_id: config.agentId,
    receiver_agent_id: receiverId,
    content,
  });
}

// ── Prompt builders ─────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return [
    `You are agent "${config.agentId}" on the LOTA platform.`,
    `You have access to LOTA MCP tools for task management, reporting, and messaging.`,
    `When you finish your work, you MUST call submit_report with the task_id to mark it complete.`,
    `Your agent_id is "${config.agentId}" — use it when calling tools that accept agent_id.`,
    `Work directory: ${config.workDir}`,
  ].join("\n");
}

function buildTaskPrompt(task: Task): string {
  const parts = [
    `# Task: ${task.title}`,
    `Task ID: ${task.id}`,
    `Priority: ${task.priority}`,
  ];

  if (task.brief) {
    parts.push("", "## Brief", task.brief);
  }

  if (task.technical_plan) {
    const plan = task.technical_plan;
    parts.push("", "## Technical Plan");
    if (plan.goals.length > 0) {
      parts.push("### Goals");
      for (const g of plan.goals) {
        parts.push(`- [${g.completed ? "x" : " "}] ${g.title}`);
      }
    }
    if (plan.affected_files.length > 0) {
      parts.push("### Affected Files");
      for (const f of plan.affected_files) {
        parts.push(`- ${f}`);
      }
    }
    if (plan.notes) {
      parts.push("### Notes", plan.notes);
    }
  }

  parts.push(
    "",
    "## Instructions",
    "1. Read and understand the task above.",
    "2. Do the work described in the brief/plan.",
    "3. When finished, call the `submit_report` tool with:",
    `   - task_id: "${task.id}"`,
    `   - agent_id: "${config.agentId}"`,
    "   - summary: a brief summary of what you did",
    "   - deliverables, new_files, modified_files as appropriate",
  );

  return parts.join("\n");
}

// ── MCP config ──────────────────────────────────────────────────────

function writeTempMcpConfig(): string {
  const configPath = join(config.workDir, `.mcp-runner-${config.agentId}.json`);
  const mcpConfig = {
    mcpServers: {
      lota: {
        command: "node",
        args: [join(config.workDir, "dist/index.js")],
        env: {
          LOTA_API_URL: config.apiUrl,
          LOTA_SERVICE_KEY: config.serviceKey,
          LOTA_AGENT_ID: config.agentId,
        },
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2));
  return configPath;
}

function cleanupMcpConfig(configPath: string): void {
  try {
    if (existsSync(configPath)) unlinkSync(configPath);
  } catch {
    // ignore cleanup errors
  }
}

// ── Claude subprocess ───────────────────────────────────────────────

function spawnClaude(prompt: string, mcpConfigPath: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const args = [
      "--print",
      "--model", config.model,
      "--mcp-config", mcpConfigPath,
      "--system-prompt", buildSystemPrompt(),
      prompt,
    ];

    log.info(`Spawning: claude ${args.slice(0, 3).join(" ")} ...`);

    // Remove Claude Code session env vars to avoid nested session errors
    const cleanEnv = { ...process.env };
    for (const key of Object.keys(cleanEnv)) {
      if (key.startsWith("CLAUDE_CODE") || key === "CLAUDECODE" || key === "CLAUDE_SHELL_SESSION_ID") {
        delete cleanEnv[key];
      }
    }

    const child = spawn("claude", args, {
      cwd: config.workDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanEnv,
    });

    currentProcess = child;

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("close", (code) => {
      currentProcess = null;
      resolve({ code, stdout, stderr });
    });

    child.on("error", (err) => {
      currentProcess = null;
      resolve({ code: 1, stdout, stderr: stderr + "\n" + err.message });
    });
  });
}

// ── Task executor ───────────────────────────────────────────────────

async function executeTask(task: Task): Promise<void> {
  if (processedTaskIds.has(task.id)) return;
  if (currentTask) {
    log.warn(`Already working on task ${currentTask.id}, skipping ${task.id}`);
    return;
  }

  processedTaskIds.add(task.id);
  currentTask = task;
  log.info(`Starting task: ${task.id} — ${task.title}`);

  try {
    await updateTaskStatus(task.id, "in_progress");
  } catch (e) {
    log.error(`Failed to update task status: ${(e as Error).message}`);
  }

  const mcpConfigPath = writeTempMcpConfig();

  try {
    const prompt = buildTaskPrompt(task);
    const result = await spawnClaude(prompt, mcpConfigPath);

    if (result.code === 0) {
      log.info(`Task ${task.id} subprocess exited successfully`);
    } else {
      log.error(`Task ${task.id} subprocess exited with code ${result.code}`);
      // Try to notify about failure
      try {
        if (task.delegated_from) {
          await sendMessage(
            task.delegated_from,
            `Task "${task.title}" (${task.id}) failed — subprocess exited with code ${result.code}`
          );
        }
      } catch {
        // ignore notification errors
      }
    }
  } finally {
    cleanupMcpConfig(mcpConfigPath);
    currentTask = null;
  }
}

// ── Message handler ─────────────────────────────────────────────────

async function handleMessage(message: Message): Promise<void> {
  const content = message.content.trim().toLowerCase();
  log.info(`Message from ${message.sender_id}: ${message.content.trim()}`);

  // Pattern: "start working on task <id>"
  const startMatch = content.match(/start\s+(?:working\s+on\s+)?task\s+(\S+)/);
  if (startMatch) {
    const taskId = startMatch[1];
    log.info(`Received request to start task: ${taskId}`);

    try {
      const task = await fetchTask(taskId);

      if (processedTaskIds.has(task.id)) {
        log.warn(`Task ${taskId} was already processed this session`);
        return;
      }

      if (currentTask) {
        log.warn(`Busy with task ${currentTask.id}, queueing ${taskId} for next poll`);
        return;
      }

      await executeTask(task);
    } catch (e) {
      log.error(`Failed to handle task request: ${(e as Error).message}`);
    }
    return;
  }

  // Pattern: "status" — reply with current status
  if (content === "status" || content === "what are you doing") {
    try {
      const reply = currentTask
        ? `Working on task ${currentTask.id}: "${currentTask.title}"`
        : "Idle, waiting for tasks.";
      if (message.sender_id) {
        await sendMessage(message.sender_id, reply);
      }
    } catch (e) {
      log.error(`Failed to send status reply: ${(e as Error).message}`);
    }
    return;
  }

  log.info(`Unrecognized message, ignoring.`);
}

// ── Poll functions ──────────────────────────────────────────────────

async function pollForTasks(): Promise<void> {
  if (currentTask) return; // busy

  try {
    const tasks = await fetchAssignedTasks();
    for (const task of tasks) {
      if (!processedTaskIds.has(task.id)) {
        await executeTask(task);
        break; // one at a time
      }
    }
  } catch (e) {
    log.error(`Poll tasks error: ${(e as Error).message}`);
  }
}

async function pollForMessages(): Promise<void> {
  try {
    const messages = await fetchMessages();
    for (const msg of messages) {
      await handleMessage(msg);
      // Update timestamp to the latest message we've seen
      if (msg.created_at > lastMessageTimestamp) {
        lastMessageTimestamp = msg.created_at;
      }
    }
  } catch (e) {
    log.error(`Poll messages error: ${(e as Error).message}`);
  }
}

async function pollCycle(): Promise<void> {
  await pollForMessages();
  await pollForTasks();
}

// ── Shutdown ────────────────────────────────────────────────────────

function setupShutdownHandlers(): void {
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down...`);

    // Close webhook server
    if (webhookServer) {
      webhookServer.close();
      webhookServer = null;
    }

    // Wake up the sleep so the main loop can exit
    wakeUp();

    if (currentProcess) {
      log.info("Waiting for active subprocess to finish...");
      currentProcess.kill("SIGTERM");
      // Give it 30s to finish
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (currentProcess) {
            log.warn("Subprocess did not exit in time, killing...");
            currentProcess.kill("SIGKILL");
          }
          resolve();
        }, 30000);

        const check = setInterval(() => {
          if (!currentProcess) {
            clearInterval(check);
            clearTimeout(timeout);
            resolve();
          }
        }, 500);
      });
    }

    log.info("Goodbye.");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  config = parseArgs();

  // Create API client with runner credentials
  api = new LotaApiClient();
  // The constructor reads env vars, but we set agentId explicitly
  api.setAgentId(config.agentId);

  lastMessageTimestamp = new Date().toISOString();

  setupShutdownHandlers();

  log.info("╔══════════════════════════════════════╗");
  log.info("║       LOTA Agent Runner Started      ║");
  log.info("╚══════════════════════════════════════╝");
  log.info(`Agent:    ${config.agentId}`);
  log.info(`API:      ${config.apiUrl}`);
  log.info(`Work dir: ${config.workDir}`);
  log.info(`Model:    ${config.model}`);
  log.info(`Poll:     ${config.pollInterval}ms`);
  log.info(`Webhook:  ${config.webhookHost}:${config.webhookPort}`);
  if (config.publicUrl) log.info(`Public:   ${config.publicUrl}`);
  log.info("");

  // Verify connectivity
  try {
    const tasks = await fetchAssignedTasks();
    log.info(`Connected. Found ${tasks.length} assigned task(s).`);
  } catch (e) {
    log.error(`Failed to connect to LOTA API: ${(e as Error).message}`);
    process.exit(1);
  }

  // Start webhook server
  webhookServer = startWebhookServer(config.webhookHost, config.webhookPort);

  // Register webhook URL if public URL is provided
  if (config.publicUrl) {
    await registerWebhookUrl(config.publicUrl);
  }

  // Main loop
  log.info("Entering poll loop...");
  while (!shuttingDown) {
    await pollCycle();
    await sleep(config.pollInterval);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    sleepResolve = resolve;
    setTimeout(() => {
      sleepResolve = null;
      resolve();
    }, ms);
  });
}

function wakeUp(): void {
  if (sleepResolve) {
    const resolve = sleepResolve;
    sleepResolve = null;
    resolve();
  }
}

// ── Webhook server ─────────────────────────────────────────────────

function startWebhookServer(host: string, port: number): Server {
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/webhook") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const payload = JSON.parse(body);
          log.info(`Webhook received: ${payload.event}${payload.task_id ? ` (task: ${payload.task_id})` : ""}${payload.message_id ? ` (message: ${payload.message_id})` : ""}`);
        } catch {
          log.info("Webhook received (unparseable payload)");
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        // Wake up the poll loop immediately
        wakeUp();
      });
    } else if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", agent: config.agentId, busy: !!currentTask }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, host, () => {
    log.info(`Webhook server listening on ${host}:${port}`);
  });

  return server;
}

async function registerWebhookUrl(publicUrl: string): Promise<void> {
  const webhookUrl = publicUrl.replace(/\/$/, "") + "/webhook";
  try {
    await api.patch(`/api/members/${config.agentId}/webhook`, { webhook_url: webhookUrl });
    log.info(`Registered webhook URL: ${webhookUrl}`);
  } catch (e) {
    log.error(`Failed to register webhook URL: ${(e as Error).message}`);
  }
}

main().catch((e) => {
  log.error(`Fatal: ${(e as Error).message}`);
  process.exit(1);
});

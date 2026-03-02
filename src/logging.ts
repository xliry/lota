import { existsSync, mkdirSync, statSync, createWriteStream, renameSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, ClaudeEvent } from "./types.js";

// ── Early name detection (before log init) ──────────────────────
function _earlyGetName(): string {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "--name" || args[i] === "-n") return args[i + 1];
  }
  return "";
}
const _EARLY_AGENT_NAME = _earlyGetName();

// ── Constants ────────────────────────────────────────────────────
export const LOG_DIR = join(process.env.HOME || "~", "lota");
export const LOG_FILE = (_EARLY_AGENT_NAME && _EARLY_AGENT_NAME !== "lota")
  ? join(LOG_DIR, `agent-${_EARLY_AGENT_NAME}.log`)
  : join(LOG_DIR, "agent.log");

const BYTES_PER_MB = 1024 * 1024;
const LOG_MAX_BYTES = 5 * BYTES_PER_MB;
const MEMORY_WARNING_MB = 500;
const MEMORY_CRITICAL_MB = 800;

mkdirSync(LOG_DIR, { recursive: true });

// ── Log rotation ─────────────────────────────────────────────────
function rotateLogs(): void {
  if (existsSync(`${LOG_FILE}.1`)) renameSync(`${LOG_FILE}.1`, `${LOG_FILE}.2`);
  if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 0) renameSync(LOG_FILE, `${LOG_FILE}.1`);
}

rotateLogs();

let logStream: WriteStream = createWriteStream(LOG_FILE, { flags: "a" });
logStream.on("error", () => {});

// Write startup banner to mark new session
logStream.write(`\n${"=".repeat(60)}\n[SESSION START] ${new Date().toISOString()}\n${"=".repeat(60)}\n`);

// ── Log rotation check ───────────────────────────────────────────
function checkRotate(): void {
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size >= LOG_MAX_BYTES) {
      logStream.end();
      rotateLogs();
      logStream = createWriteStream(LOG_FILE, { flags: "a" });
      logStream.on("error", () => {});
    }
  } catch (e) { logNonCritical("log rotation", e); }
}

// ── Core logging functions ───────────────────────────────────────
const time = () => new Date().toLocaleTimeString("en-US", { hour12: false });
const PRE = "\x1b[36m[lota]\x1b[0m";

export function writeLog(msg: string, plain: string): void {
  checkRotate();
  console.log(msg);
  logStream.write(`${plain}\n`);
}

export function writeToLog(text: string): void {
  logStream.write(text);
}

export function closeLog(): void {
  logStream.end();
}

export const log = (msg: string) => writeLog(`${PRE} \x1b[90m${time()}\x1b[0m ${msg}`, `[${time()}] ${msg}`);
export const ok = (msg: string) => writeLog(`${PRE} \x1b[90m${time()}\x1b[0m \x1b[32m✓ ${msg}\x1b[0m`, `[${time()}] ✓ ${msg}`);
export const dim = (msg: string) => writeLog(`${PRE} \x1b[90m${time()} ${msg}\x1b[0m`, `[${time()}] ${msg}`);
export const err = (msg: string) => writeLog(`${PRE} \x1b[90m${time()}\x1b[0m \x1b[31m✗ ${msg}\x1b[0m`, `[${time()}] ✗ ${msg}`);

/** Log a non-critical error that should not halt execution. */
export const logNonCritical = (op: string, e: unknown) =>
  dim(`[non-critical] ${op}: ${(e as Error).message}`);

// ── Periodic GC hint ──────────────────────────────────────────────
let lastGcTime = Date.now();
const MS_PER_MINUTE = 60_000;
const GC_INTERVAL_MS = 30 * MS_PER_MINUTE;

export function periodicGcHint(): void {
  const now = Date.now();
  if (now - lastGcTime < GC_INTERVAL_MS) return;
  lastGcTime = now;
  const maybeGc = (global as { gc?: () => void }).gc;
  if (typeof maybeGc === "function") {
    const before = Math.round(process.memoryUsage().heapUsed / BYTES_PER_MB);
    maybeGc();
    const after = Math.round(process.memoryUsage().heapUsed / BYTES_PER_MB);
    dim(`Periodic GC: freed ${before - after}MB (heap ${before}→${after}MB)`);
  }
}

// ── Memory monitoring ────────────────────────────────────────────
export function logMemory(label: string, config: AgentConfig): void {
  const mem = process.memoryUsage();
  const heapUsedMb = Math.round(mem.heapUsed / BYTES_PER_MB);
  const heapTotalMb = Math.round(mem.heapTotal / BYTES_PER_MB);
  const rssMb = Math.round(mem.rss / BYTES_PER_MB);

  if (heapUsedMb > MEMORY_CRITICAL_MB) {
    err(`🔴 Critical memory [${label}]: ${heapUsedMb}MB heap used / ${heapTotalMb}MB total, RSS: ${rssMb}MB — consider restarting`);
    const maybeGc = (global as { gc?: () => void }).gc;
    if (typeof maybeGc === "function") {
      maybeGc();
      const afterMb = Math.round(process.memoryUsage().heapUsed / BYTES_PER_MB);
      dim(`  GC freed ${heapUsedMb - afterMb}MB (heap now ${afterMb}MB)`);
    }
  } else if (heapUsedMb > MEMORY_WARNING_MB) {
    log(`⚠️ High memory [${label}]: ${heapUsedMb}MB heap used / ${heapTotalMb}MB total, RSS: ${rssMb}MB`);
  } else {
    dim(`Memory [${label}]: heap ${heapUsedMb}/${heapTotalMb}MB, RSS: ${rssMb}MB`);
  }

  if (rssMb > config.maxRssMb) {
    err(`🔴 RSS ${rssMb}MB exceeds limit ${config.maxRssMb}MB — graceful exit (code 42)`);
    process.exit(42);
  }
}

// ── Event formatter (stream-json → readable log) ────────────────
export function formatEvent(event: ClaudeEvent): void {
  const t = time();
  const write = (icon: string, msg: string) => {
    const plain = `[${t}] ${icon} ${msg}`;
    const colored = `${PRE} \x1b[90m${t}\x1b[0m ${icon} ${msg}`;
    console.log(colored);
    logStream.write(`${plain}\n`);
  };

  if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
    write("🔧", `Tool: ${event.content_block.name || "unknown"}`);
    return;
  }

  if (event.type === "result" && event.subtype === "tool_result") return;

  if (event.type === "assistant" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "tool_use") {
        const name = block.name || "";
        const input = block.input || {};
        if (name === "Write" || name === "Edit") {
          write("📝", `${name}: ${input.file_path || ""}`);
        } else if (name === "Read") {
          write("📖", `Read: ${input.file_path || ""}`);
        } else if (name === "Bash") {
          write("💻", `Bash: ${String(input.command || "").slice(0, 120)}`);
        } else if (name === "Glob" || name === "Grep") {
          write("🔍", `${name}: ${input.pattern || ""}`);
        } else if (name === "Task") {
          const bg = input.run_in_background ? " [bg]" : "";
          write("🤖", `Subagent (${input.subagent_type || ""}): ${input.description || ""}${bg}`);
        } else if (name.startsWith("mcp__lota")) {
          write("🔗", `LOTA: ${input.method || ""} ${input.path || ""}`);
        } else {
          write("🔧", name);
        }
      } else if (block.type === "text") {
        const text = (block.text || "").slice(0, 200);
        if (text.trim()) write("💬", text.replace(/\n/g, " ").trim());
      }
    }
    return;
  }

  if (event.type === "result") {
    const cost = event.cost_usd ? `$${event.cost_usd.toFixed(4)}` : "";
    const dur = event.duration_ms ? `${(event.duration_ms / 1000).toFixed(1)}s` : "";
    write("✅", `Done — ${event.num_turns || 0} turns, ${dur}, ${cost}`);
  }
}

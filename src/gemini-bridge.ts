/**
 * Gemini Bridge — reliable headless video/audio analysis via Gemini CLI.
 *
 * Spawns `echo '@./file prompt' | gemini -y -o json > output.json` with a
 * 10-minute timeout. Output is always redirected to a file to avoid pipe
 * truncation issues that plague the Claude agent's Bash tool.
 *
 * Usage from prompt.ts: agent is told to call the bridge script instead of
 * raw gemini commands.
 */

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { dim, ok, err, logNonCritical } from "./logging.js";

// ── Config ───────────────────────────────────────────────────────────

const STAGING_DIR = join(process.env.HOME || "/root", "gemini-staging");
const GEMINI_TIMEOUT_MS = 600_000; // 10 minutes

// ── Types ────────────────────────────────────────────────────────────

export interface GeminiRequest {
  videoPath: string;
  taskId: number;
  prompt?: string;
}

export interface GeminiResult {
  success: boolean;
  outputFile: string;
  error?: string;
  durationMs: number;
}

// ── Default prompt ───────────────────────────────────────────────────

function buildAnalysisPrompt(): string {
  return [
    "Analyze this video. Extract and output as JSON:",
    "1) Full transcript with timestamps per sentence (keep slang intact, do not correct to formal language)",
    "2) Visual scene descriptions: colors (hex codes), all text visible on screen, layout style, design patterns",
    "3) Transition types between scenes",
    "4) Template extraction: color palette, font styles, layout patterns, animation types, subtitle style",
  ].join("\n");
}

// ── Stage video ──────────────────────────────────────────────────────

function stageVideo(videoPath: string, taskId: number): string {
  mkdirSync(STAGING_DIR, { recursive: true });

  // Use simple filename without spaces or special chars
  const ext = videoPath.match(/\.\w+$/)?.[0] || ".mp4";
  const stagedName = `video-${taskId}${ext}`;
  const stagedPath = join(STAGING_DIR, stagedName);

  if (!existsSync(stagedPath)) {
    try {
      execSync(`cp "${videoPath}" "${stagedPath}"`, { timeout: 30_000 });
      dim(`Staged video: ${stagedPath} (${formatSize(videoPath)})`);
    } catch (e) {
      throw new Error(`Failed to stage video: ${(e as Error).message}`);
    }
  }

  return stagedName;
}

function formatSize(path: string): string {
  try {
    const bytes = statSync(path).size;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  } catch { return "?"; }
}

// ── Run Gemini ───────────────────────────────────────────────────────

export function runGeminiAnalysis(req: GeminiRequest): Promise<GeminiResult> {
  const outputFile = `/tmp/gemini-raw-${req.taskId}.json`;
  const prompt = req.prompt || buildAnalysisPrompt();

  let stagedName: string;
  try {
    stagedName = stageVideo(req.videoPath, req.taskId);
  } catch (e) {
    return Promise.resolve({
      success: false,
      outputFile,
      error: (e as Error).message,
      durationMs: 0,
    });
  }

  ok(`Gemini bridge: analyzing ${stagedName} (timeout: ${GEMINI_TIMEOUT_MS / 1000}s)`);

  const startTime = Date.now();

  // The ONLY working method for headless Gemini video analysis:
  // echo '@./file prompt' | gemini -y -o json > output.json
  const cmd = `cd "${STAGING_DIR}" && echo '@./${stagedName} ${prompt.replace(/'/g, "'\\''")}' | gemini -y -o json > "${outputFile}" 2>/dev/null`;

  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", cmd], {
      cwd: STAGING_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    // 10 minute timeout
    const timer = setTimeout(() => {
      err(`Gemini bridge: timeout after ${GEMINI_TIMEOUT_MS / 1000}s — killing`);
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }, GEMINI_TIMEOUT_MS);

    let stderrBuf = "";
    child.stderr?.on("data", (d: Buffer) => { stderrBuf += d.toString(); });

    child.on("close", (code) => {
      clearTimeout(timer);
      const duration = Date.now() - startTime;

      if (code === 0 && existsSync(outputFile) && statSync(outputFile).size > 10) {
        ok(`Gemini bridge: done in ${(duration / 1000).toFixed(0)}s → ${outputFile}`);
        resolve({ success: true, outputFile, durationMs: duration });
      } else {
        const errMsg = stderrBuf.includes("exhausted your capacity")
          ? "Gemini rate limit — quota exhausted"
          : stderrBuf.includes("account verification")
            ? "Gemini account verification required — run 'gemini' interactively first"
            : `exit code ${code}, output size: ${existsSync(outputFile) ? statSync(outputFile).size : 0}`;
        err(`Gemini bridge: failed — ${errMsg}`);
        resolve({ success: false, outputFile, error: errMsg, durationMs: duration });
      }
    });

    child.on("error", (e) => {
      clearTimeout(timer);
      err(`Gemini bridge: spawn error — ${e.message}`);
      resolve({
        success: false,
        outputFile,
        error: e.message,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "./types.js";

const SHARED_SKILLS_DIR = join(process.env.HOME || "/root", ".lota", "shared", "skills");

// ── Shared skills injection ─────────────────────────────────────────
function loadSharedSkills(): string {
  try {
    const files = readdirSync(SHARED_SKILLS_DIR).filter(f => f.endsWith(".md"));
    if (!files.length) return "";
    const parts: string[] = ["\n\n--- SHARED SKILLS ---"];
    for (const file of files) {
      try {
        const content = readFileSync(join(SHARED_SKILLS_DIR, file), "utf-8");
        parts.push(`\n## ${file.replace(".md", "")}\n${content}`);
      } catch { /* skip unreadable files */ }
    }
    return parts.join("\n");
  } catch { return ""; }
}

// ── Build CLI command + args ────────────────────────────────────────
export function buildCliArgs(
  config: AgentConfig,
  prompt: string,
  options?: { injectSharedSkills?: boolean },
): { command: string; args: string[] } {
  const finalPrompt = options?.injectSharedSkills
    ? prompt + loadSharedSkills()
    : prompt;

  if (config.cli === "gemini") {
    return {
      command: "gemini",
      args: [
        "-p", finalPrompt,
        "-o", "stream-json",
        "-y",
        ...(config.model && config.model !== "auto" ? ["--model", config.model] : []),
      ],
    };
  }

  // claude (default)
  const isRoot = process.getuid?.() === 0;
  return {
    command: "claude",
    args: [
      "--print", "--verbose", "--output-format", "stream-json",
      ...(isRoot ? [] : ["--dangerously-skip-permissions"]),
      "--model", config.model,
      ...(config.configPath ? ["--mcp-config", config.configPath] : []),
      "-p", finalPrompt,
    ],
  };
}

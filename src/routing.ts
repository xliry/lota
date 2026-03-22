/**
 * Task-type agent routing — adapted from megaplan's DEFAULT_AGENT_ROUTING.
 *
 * Routes tasks to the best CLI (claude/gemini) based on content analysis.
 * Used by lota-hub for assignment suggestions and by the orchestrator for
 * automatic routing when no explicit CLI preference is set.
 */

import type { CliType } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────

export interface RoutingResult {
  cli: CliType;
  reason: string;
  confidence: "high" | "medium" | "low";
}

interface RoutingRule {
  pattern: RegExp;
  cli: CliType;
  reason: string;
  confidence: "high" | "medium";
}

// ── Routing Table ────────────────────────────────────────────────────
// Evaluated in priority order — first match wins.

const ROUTING_TABLE: RoutingRule[] = [
  // Video analysis → Gemini (multimodal native)
  {
    pattern: /\b(video|mp4|mkv|avi|mov)\b.*\b(analy[sz]|extract|timeline|transcri|scene)/i,
    cli: "gemini",
    reason: "Video analysis — Gemini has native multimodal video understanding",
    confidence: "high",
  },
  {
    pattern: /\b(analy[sz]|extract|timeline|transcri|scene).*\b(video|mp4|mkv|avi|mov)\b/i,
    cli: "gemini",
    reason: "Video analysis — Gemini has native multimodal video understanding",
    confidence: "high",
  },

  // Audio analysis → Gemini
  {
    pattern: /\b(audio|ses|mp3|wav|voice|voiceover)\b.*\b(analy[sz]|transcri|timeline|extract)/i,
    cli: "gemini",
    reason: "Audio analysis — Gemini has native audio understanding",
    confidence: "high",
  },
  {
    pattern: /\b(analy[sz]|transcri|timeline|extract).*\b(audio|ses|mp3|wav|voice)\b/i,
    cli: "gemini",
    reason: "Audio analysis — Gemini has native audio understanding",
    confidence: "high",
  },

  // Image analysis → Gemini
  {
    pattern: /\b(image|resim|screenshot|görsel|photo|jpg|png)\b.*\b(analy[sz]|descri|classif|detect)/i,
    cli: "gemini",
    reason: "Image analysis — Gemini multimodal",
    confidence: "high",
  },

  // Large context understanding → Gemini
  {
    pattern: /\b(summarize|özetle)\b.*\b(entire|tüm|whole|full)\b/i,
    cli: "gemini",
    reason: "Large context summarization — Gemini's 1M+ token context",
    confidence: "medium",
  },

  // Code generation → Claude
  {
    pattern: /\b(remotion|component|tsx|jsx|react|typescript)\b/i,
    cli: "claude",
    reason: "Code generation task — Claude excels at code and React/Remotion",
    confidence: "high",
  },

  // Debugging → Claude
  {
    pattern: /\b(debug|fix|bug|error|crash|refactor|migrate)\b/i,
    cli: "claude",
    reason: "Debugging/refactoring — Claude's structured reasoning",
    confidence: "high",
  },

  // Implementation → Claude
  {
    pattern: /\b(implement|build|create|develop|write|code)\b/i,
    cli: "claude",
    reason: "Implementation task — Claude for code generation",
    confidence: "medium",
  },
];

// ── Router ───────────────────────────────────────────────────────────

export function routeTask(title: string, body: string = ""): RoutingResult {
  const text = `${title} ${body}`;
  for (const rule of ROUTING_TABLE) {
    if (rule.pattern.test(text)) {
      return { cli: rule.cli, reason: rule.reason, confidence: rule.confidence };
    }
  }
  return { cli: "claude", reason: "Default routing — no specific pattern matched", confidence: "low" };
}

/**
 * Find the best available agent for a routing result.
 * Reads PID files to find agents matching the desired CLI type.
 */
export function findAgentForCli(
  desiredCli: CliType,
  agents: Array<{ name: string; cli: CliType; taskCount: number }>,
): string | null {
  const matching = agents
    .filter(a => a.cli === desiredCli)
    .sort((a, b) => a.taskCount - b.taskCount); // least loaded first
  return matching.length ? matching[0].name : null;
}

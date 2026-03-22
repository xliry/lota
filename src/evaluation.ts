/**
 * Plan quality evaluation — decision table pattern adapted from megaplan.
 *
 * Evaluates planned tasks before auto-approval to ensure quality gates.
 * The orchestrator and daemon use this to make approve/reject/escalate decisions.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────

export interface PlanSignals {
  hasGoals: boolean;
  hasAffectedFiles: boolean;
  hasSpecificPaths: boolean;
  effortEstimate: string;
  taskBodyLength: number;
  previousFailures: number;
  goalCount: number;
  fileCount: number;
}

export type Recommendation = "APPROVE" | "REJECT" | "ESCALATE";

export interface EvalResult {
  recommendation: Recommendation;
  confidence: "high" | "medium";
  rationale: string;
}

interface EvalRule {
  predicate: (s: PlanSignals) => boolean;
  recommendation: Recommendation;
  confidence: "high" | "medium";
  rationale: string | ((s: PlanSignals) => string);
}

// ── Decision Table ───────────────────────────────────────────────────
// Evaluated in priority order — first match wins (megaplan pattern).

const EVALUATION_TABLE: EvalRule[] = [
  // Hard reject: no goals AND no files
  {
    predicate: s => !s.hasGoals && !s.hasAffectedFiles,
    recommendation: "REJECT",
    confidence: "high",
    rationale: "Plan missing both goals and affected_files — too vague to execute.",
  },

  // Escalate: repeated failures on this workspace
  {
    predicate: s => s.previousFailures >= 2,
    recommendation: "ESCALATE",
    confidence: "high",
    rationale: s => `${s.previousFailures} previous failures — needs manual review before re-attempt.`,
  },

  // Reject: has goals but no files
  {
    predicate: s => s.hasGoals && !s.hasAffectedFiles,
    recommendation: "REJECT",
    confidence: "high",
    rationale: "Plan has goals but no affected_files listed — agent won't know which files to edit.",
  },

  // Reject: has files but no goals
  {
    predicate: s => !s.hasGoals && s.hasAffectedFiles,
    recommendation: "REJECT",
    confidence: "high",
    rationale: "Plan has affected_files but no goals — unclear what the agent should achieve.",
  },

  // High-confidence approve: goals + files + specific paths
  {
    predicate: s => s.hasGoals && s.hasAffectedFiles && s.hasSpecificPaths && s.goalCount >= 2,
    recommendation: "APPROVE",
    confidence: "high",
    rationale: "Plan has clear goals, specific file paths, and detailed scope.",
  },

  // Medium-confidence approve: goals + files but paths may be vague
  {
    predicate: s => s.hasGoals && s.hasAffectedFiles,
    recommendation: "APPROVE",
    confidence: "medium",
    rationale: "Plan has goals and files but paths could be more specific.",
  },

  // Fallback
  {
    predicate: () => true,
    recommendation: "APPROVE",
    confidence: "medium",
    rationale: "Plan meets minimum criteria.",
  },
];

// ── Signal extraction ────────────────────────────────────────────────

function hasSpecificPaths(files: string[]): boolean {
  if (!files.length) return false;
  // Specific = contains file extensions or directory separators
  return files.some(f => f.includes("/") || f.includes("."));
}

export function extractSignals(
  plan: { goals?: string[]; affected_files?: string[]; effort?: string } | undefined,
  taskBody: string,
  previousFailures: number,
): PlanSignals {
  const goals = plan?.goals || [];
  const files = plan?.affected_files || [];
  return {
    hasGoals: goals.length > 0,
    hasAffectedFiles: files.length > 0,
    hasSpecificPaths: hasSpecificPaths(files),
    effortEstimate: plan?.effort || "unknown",
    taskBodyLength: taskBody.length,
    previousFailures,
    goalCount: goals.length,
    fileCount: files.length,
  };
}

// ── Evaluation ───────────────────────────────────────────────────────

export function evaluatePlan(signals: PlanSignals): EvalResult {
  for (const rule of EVALUATION_TABLE) {
    if (rule.predicate(signals)) {
      return {
        recommendation: rule.recommendation,
        confidence: rule.confidence,
        rationale: typeof rule.rationale === "function" ? rule.rationale(signals) : rule.rationale,
      };
    }
  }
  return { recommendation: "APPROVE", confidence: "medium", rationale: "Default — no rule matched." };
}

// ── Crash history tracking ───────────────────────────────────────────

const CRASH_HISTORY_FILE = join(process.env.HOME || "/root", "lota", ".crash-history.json");

export function getFailureCount(workspace: string): number {
  try {
    if (!existsSync(CRASH_HISTORY_FILE)) return 0;
    const data = JSON.parse(readFileSync(CRASH_HISTORY_FILE, "utf-8")) as Record<string, number>;
    return data[workspace] || 0;
  } catch { return 0; }
}

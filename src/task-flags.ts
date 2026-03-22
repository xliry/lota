/**
 * Task-level flag/risk registry — adapted from megaplan's FlagRecord pattern.
 *
 * Tracks concerns, risks, and scope issues for each task. The orchestrator
 * reads flags when evaluating plans, and agents can raise flags during execution.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logNonCritical } from "./logging.js";

// ── Types ────────────────────────────────────────────────────────────

export interface TaskFlag {
  id: string;
  taskId: number;
  concern: string;
  category: "correctness" | "completeness" | "scope" | "performance" | "other";
  severity: "significant" | "minor";
  status: "open" | "addressed" | "verified";
  raisedBy: string;
  raisedAt: string;
}

export interface FlagRegistry {
  taskId: number;
  flags: TaskFlag[];
}

// ── Constants ────────────────────────────────────────────────────────

const FLAGS_DIR = join(process.env.HOME || "/root", "lota", ".flags");

const SCOPE_CREEP_TERMS = [
  "scope creep", "out of scope", "beyond original",
  "expanded scope", "beyond the original", "beyond user intent",
  "kapsam dışı", "kapsam genişlemesi",
];

// ── Flag file I/O ────────────────────────────────────────────────────

function flagFilePath(taskId: number): string {
  return join(FLAGS_DIR, `task-${taskId}.json`);
}

export function loadFlags(taskId: number): FlagRegistry {
  const path = flagFilePath(taskId);
  try {
    if (!existsSync(path)) return { taskId, flags: [] };
    const data = JSON.parse(readFileSync(path, "utf-8")) as FlagRegistry;
    return data;
  } catch {
    return { taskId, flags: [] };
  }
}

export function saveFlags(registry: FlagRegistry): void {
  try {
    const { mkdirSync } = require("node:fs");
    mkdirSync(FLAGS_DIR, { recursive: true });
    writeFileSync(flagFilePath(registry.taskId), JSON.stringify(registry, null, 2) + "\n");
  } catch (e) {
    logNonCritical(`save flags for task #${registry.taskId}`, e);
  }
}

// ── Flag operations ──────────────────────────────────────────────────

export function addFlag(
  registry: FlagRegistry,
  flag: Omit<TaskFlag, "id" | "raisedAt">,
): TaskFlag {
  const nextNum = registry.flags.length + 1;
  const newFlag: TaskFlag = {
    ...flag,
    id: `FLAG-${String(nextNum).padStart(3, "0")}`,
    raisedAt: new Date().toISOString(),
  };
  registry.flags.push(newFlag);
  return newFlag;
}

export function resolveFlag(registry: FlagRegistry, flagId: string, status: "addressed" | "verified"): boolean {
  const flag = registry.flags.find(f => f.id === flagId);
  if (!flag) return false;
  flag.status = status;
  return true;
}

export function unresolvedFlags(registry: FlagRegistry): TaskFlag[] {
  return registry.flags.filter(f => f.status === "open");
}

export function significantFlags(registry: FlagRegistry): TaskFlag[] {
  return registry.flags.filter(f => f.severity === "significant" && f.status === "open");
}

// ── Scope creep detection ────────────────────────────────────────────
// Adapted from megaplan's scope_creep_flags and is_scope_creep_flag

export function detectScopeCreep(planGoals: string[], taskTitle: string, taskBody: string): boolean {
  const planText = planGoals.join(" ").toLowerCase();
  const taskText = `${taskTitle} ${taskBody}`.toLowerCase();

  // Check if plan goals contain scope creep language
  if (SCOPE_CREEP_TERMS.some(term => planText.includes(term))) {
    return true;
  }

  // Check if plan goals diverge significantly from task description
  // Simple heuristic: if goals mention topics not in the original task
  const taskWords = new Set(taskText.split(/\W+/).filter(w => w.length > 4));
  const goalWords = planGoals.join(" ").toLowerCase().split(/\W+/).filter(w => w.length > 4);
  const novelWords = goalWords.filter(w => !taskWords.has(w));

  // If more than 60% of goal words are novel, likely scope creep
  if (goalWords.length > 3 && novelWords.length / goalWords.length > 0.6) {
    return true;
  }

  return false;
}

// ── Summary for prompt injection ─────────────────────────────────────

export function flagSummary(registry: FlagRegistry): string {
  const open = unresolvedFlags(registry);
  const significant = significantFlags(registry);
  if (!open.length) return "No open flags.";

  const lines = [
    `${open.length} open flag(s) (${significant.length} significant):`,
    ...open.map(f => `  ${f.id} [${f.severity}] ${f.concern}`),
  ];
  return lines.join("\n");
}

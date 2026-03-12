import type { OrchestratorSnapshot, OrchestratorDelta } from "./types.js";

export function buildOrchestratorPrompt(
  agentName: string,
  dmId: number,
  snapshot: OrchestratorSnapshot,
  delta: OrchestratorDelta,
  config: { githubRepo: string },
): string {
  // Group tasks by status
  const byStatus = new Map<string, Array<{ id: number; title: string; assignee: string | null }>>();
  for (const [id, task] of snapshot.tasks) {
    const group = byStatus.get(task.status) || [];
    group.push({ id, title: task.title, assignee: task.assignee });
    byStatus.set(task.status, group);
  }

  const stateLines: string[] = [];
  for (const [status, tasks] of byStatus) {
    stateLines.push(`  [${status}]`);
    for (const t of tasks) {
      stateLines.push(`    #${t.id}: ${t.title}${t.assignee ? ` (agent: ${t.assignee})` : ""}`);
    }
  }

  const deltaLines: string[] = [];
  for (const t of delta.newTasks) deltaLines.push(`  NEW: #${t.id} "${t.title}" [${t.status}]`);
  for (const c of delta.statusChanges) deltaLines.push(`  STATUS: #${c.id} "${c.title}" ${c.from} → ${c.to}`);
  for (const c of delta.newComments) deltaLines.push(`  COMMENTS: #${c.id} "${c.title}" (+${c.count} new)`);
  for (const c of delta.completions) deltaLines.push(`  COMPLETED: #${c.id} "${c.title}"`);
  if (delta.agentChanges.online.length) deltaLines.push(`  AGENTS ONLINE: ${delta.agentChanges.online.join(", ")}`);
  if (delta.agentChanges.offline.length) deltaLines.push(`  AGENTS OFFLINE: ${delta.agentChanges.offline.join(", ")}`);

  const agentList = [...snapshot.agents].join(", ") || "(none)";

  return [
    `You are the orchestrator for Lota agents. Repo: ${config.githubRepo}`,
    "",
    "YOUR ROLE: You manage all agents. You act first and inform the user after.",
    "",
    "CURRENT STATE:",
    stateLines.join("\n") || "  (no tasks)",
    "",
    "WHAT CHANGED:",
    deltaLines.join("\n") || "  (nothing)",
    "",
    `LIVE AGENTS: ${agentList}`,
    "",
    "ALLOWED ACTIONS (use lota() MCP tool):",
    `  1. Approve: lota("POST", "/tasks/<id>/status", {status: "approved"})`,
    `  2. Assign: lota("POST", "/tasks/<id>/assign", {agent: "<name>"})`,
    `  3. Comment: lota("POST", "/tasks/<id>/comment", {content: "..."})`,
    `  4. Inform: lota("POST", "/tasks/${dmId}/comment", {content: "..."})`,
    "",
    "RULES:",
    "  - Take action on everything you can decide autonomously",
    "  - Approve plans that look reasonable",
    "  - Assign new tasks to idle agents",
    "  - Answer agent questions if the answer is clear from context",
    `  - Write ONE briefing message to DM #${dmId} summarizing what you did`,
    "  - If something needs user input, include it in the briefing as a question",
    "  - Do NOT post multiple messages. ONE briefing, at the end.",
    "  - Skip DM: prefixed tasks — those are chat channels, not work tasks",
  ].join("\n");
}

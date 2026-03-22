import { extractSignals, evaluatePlan, getFailureCount } from "./evaluation.js";
import type { OrchestratorSnapshot, OrchestratorDelta } from "./types.js";

export function buildOrchestratorPrompt(
  agentName: string,
  dmId: number,
  snapshot: OrchestratorSnapshot,
  delta: OrchestratorDelta,
  config: { githubRepo: string },
): string {
  // Group tasks by status (exclude DM channels)
  const byStatus = new Map<string, Array<{ id: number; title: string; assignee: string | null; workspace: string | null }>>();
  for (const [id, task] of snapshot.tasks) {
    if (task.title.startsWith("DM:")) continue;
    const group = byStatus.get(task.status) || [];
    group.push({ id, title: task.title, assignee: task.assignee, workspace: task.workspace });
    byStatus.set(task.status, group);
  }

  const stateLines: string[] = [];
  for (const [status, tasks] of byStatus) {
    stateLines.push(`  [${status}]`);
    for (const t of tasks) {
      const parts = [`#${t.id}: ${t.title}`];
      if (t.assignee) parts.push(`agent: ${t.assignee}`);
      if (t.workspace) parts.push(`workspace: ${t.workspace}`);
      stateLines.push(`    ${parts.join(" | ")}`);
    }
  }

  // Delta lines
  const deltaLines: string[] = [];
  for (const t of delta.newTasks) deltaLines.push(`  NEW: #${t.id} "${t.title}" [${t.status}]`);
  for (const c of delta.statusChanges) deltaLines.push(`  STATUS: #${c.id} "${c.title}" ${c.from} → ${c.to}`);
  for (const c of delta.newComments) {
    if (c.title.startsWith("DM:")) continue;  // defense layer — DM filtered in computeDelta too
    deltaLines.push(`  COMMENTS: #${c.id} "${c.title}" (+${c.count} new)`);
  }
  for (const c of delta.completions) deltaLines.push(`  COMPLETED: #${c.id} "${c.title}"`);
  if (delta.agentChanges.online.length) deltaLines.push(`  AGENTS ONLINE: ${delta.agentChanges.online.join(", ")}`);
  if (delta.agentChanges.offline.length) deltaLines.push(`  AGENTS OFFLINE: ${delta.agentChanges.offline.join(", ")}`);

  // Agent workload map
  const agentWorkload = new Map<string, Array<{ id: number; title: string; workspace: string | null }>>();
  for (const a of snapshot.agents) agentWorkload.set(a, []);
  for (const [id, task] of snapshot.tasks) {
    if (task.title.startsWith("DM:")) continue;
    if (!task.assignee) continue;
    if (task.status === "completed") continue;
    const list = agentWorkload.get(task.assignee) || [];
    list.push({ id, title: task.title, workspace: task.workspace });
    agentWorkload.set(task.assignee, list);
  }

  const workloadLines: string[] = [];
  for (const [agent, tasks] of agentWorkload) {
    if (tasks.length === 0) {
      workloadLines.push(`  ${agent}: IDLE`);
    } else {
      const taskStr = tasks.map(t => `#${t.id}${t.workspace ? ` (${t.workspace})` : ""}`).join(", ");
      workloadLines.push(`  ${agent}: ${tasks.length} task(s) — ${taskStr}`);
    }
  }

  // Occupied workspaces (active tasks only)
  const occupiedWorkspaces = new Map<string, { agent: string; taskId: number }>();
  for (const [id, task] of snapshot.tasks) {
    if (task.title.startsWith("DM:")) continue;
    if (!task.workspace || !task.assignee) continue;
    if (["assigned", "approved", "in-progress", "planned"].includes(task.status)) {
      occupiedWorkspaces.set(task.workspace, { agent: task.assignee, taskId: id });
    }
  }

  const workspaceLines: string[] = [];
  for (const [ws, info] of occupiedWorkspaces) {
    workspaceLines.push(`  ${ws} → ${info.agent} (#${info.taskId})`);
  }

  return [
    `You are the orchestrator for Lota agents. Repo: ${config.githubRepo}`,
    "",
    "YOUR ROLE: You manage all agents intelligently. You act first and inform the user after.",
    "You are the brain — not a relay. Make smart decisions based on context.",
    "",
    "CURRENT STATE:",
    stateLines.join("\n") || "  (no tasks)",
    "",
    "WHAT CHANGED:",
    deltaLines.join("\n") || "  (nothing)",
    "",
    "AGENT WORKLOAD:",
    workloadLines.join("\n") || "  (no agents)",
    "",
    "OCCUPIED WORKSPACES:",
    workspaceLines.join("\n") || "  (none)",
    "",
    "ALLOWED ACTIONS (use lota() MCP tool):",
    `  1. Approve: lota("POST", "/tasks/<id>/status", {status: "approved"})`,
    `  2. Assign: lota("POST", "/tasks/<id>/assign", {agent: "<name>"})`,
    `  3. Comment: lota("POST", "/tasks/<id>/comment", {content: "..."})`,
    `  4. Inform: lota("POST", "/tasks/${dmId}/comment", {content: "..."})`,
    `  5. Read task detail: lota("GET", "/tasks/<id>") — use this to read plans before approving`,
    "",
    "─── SMART RULES ───",
    "",
    "APPROVING PLANS (evaluation-guided):",
    "  - BEFORE approving a planned task, READ IT FIRST: lota(\"GET\", \"/tasks/<id>\")",
    "  - Check the plan comment for: clear goals, specific file paths, reasonable scope",
    "  - The daemon auto-evaluates plans using a decision table (megaplan pattern):",
    "    APPROVE: plan has goals + affected_files + specific paths",
    "    REJECT: plan is missing goals or affected_files — auto-rejected with feedback",
    "    ESCALATE: workspace has 2+ previous failures — needs manual review",
    "  - If a plan was auto-rejected, the agent will revise — no action needed from you",
    "  - If a plan was escalated, inform the user in your briefing",
    "  - Watch for SCOPE CREEP: if plan goals don't match the original task, flag it",
    "",
    "ASSIGNING TASKS:",
    "  - NEVER assign two different agents to the same workspace — this causes git conflicts",
    "  - Check OCCUPIED WORKSPACES above before assigning",
    "  - If a new task targets an occupied workspace, assign to the SAME agent already there",
    "  - Prefer IDLE agents (see AGENT WORKLOAD above)",
    "  - If all agents are busy, queue tasks — don't overload",
    "  - Round-robin across idle agents for tasks with different workspaces",
    "",
    "ANSWERING AGENT QUESTIONS:",
    "  - If an agent asks a question in a comment, try to answer from context",
    "  - If you need to read files to answer, use Read/Glob/Grep tools",
    "  - If the question truly needs the user, include it in the briefing",
    "",
    "─── OUTPUT RULES ───",
    "",
    `  - Write ONE briefing message to DM #${dmId} at the end`,
    "  - Structure: what you DID (actions taken), then what NEEDS USER INPUT (if any)",
    "  - Be concise — bullet points, not paragraphs",
    "  - If nothing actionable happened, keep briefing to 1-2 lines",
    "  - Skip DM: prefixed tasks — those are chat channels, not work tasks",
    "  - Do NOT post multiple messages. ONE briefing, at the end.",
  ].join("\n");
}

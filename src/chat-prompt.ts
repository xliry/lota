interface ChatMessage {
  body: string;
  created_at: string;
  user: string;
}

export function buildChatPrompt(
  agentName: string,
  dmId: number,
  messages: ChatMessage[],
  config: { githubRepo: string },
): string {
  const recent = messages.slice(-10);
  const conversationHistory = recent
    .map((m) => {
      const time = new Date(m.created_at).toLocaleTimeString("en-GB", { hour12: false });
      const body = m.body.replace(/<!-- .*?-->/gs, "").trim();
      return `[${time}] ${m.user}: ${body}`;
    })
    .join("\n");

  return [
    `You are ${agentName}, the orchestrator agent for the Lota system.`,
    `Repo: ${config.githubRepo}`,
    "",
    "YOUR ROLE:",
    "  - You are an intelligent assistant that chats with users via GitHub Issues.",
    "  - You can explore the codebase, create tasks, check agent status, and approve plans.",
    "  - You coordinate worker agents (lota-1, lota-2, etc.) by creating and assigning tasks.",
    "",
    "CAPABILITIES:",
    "  - Explore code: Use Read, Glob, Grep, Bash tools to understand the codebase.",
    '  - Create tasks: lota("POST", "/tasks", {title, body, assign, workspace})',
    '  - Check status: lota("GET", "/sync?all=true") — see all agents\' tasks',
    '  - Task detail: lota("GET", "/tasks/<id>") — full task with comments',
    '  - Approve plans: lota("POST", "/tasks/<id>/status", {status: "approved"})',
    "  - Agent discovery: Check ~/lota/.agents/*.pid for running agents",
    "",
    "TASK CREATION RULES:",
    `  - ALWAYS specify assign when creating tasks. Your name is ${agentName} — assign to yourself or a worker.`,
    `  - Example: lota("POST", "/tasks", {title: "...", body: "...", assign: "${agentName}", workspace: "~/project"})`,
    "  - Before creating a task, explore the workspace to understand the codebase.",
    "  - Include specific file paths and clear goals in the task body.",
    "  - One workspace = one agent. Don't assign multiple workspaces to the same task.",
    "  - Check ~/lota/.agents/*.pid for available agents and assign to one of them.",
    "",
    "REPLY FORMAT:",
    `  - Reply via: lota("POST", "/tasks/${dmId}/comment", {content: "..."})`,
    "  - Be concise, friendly, and helpful.",
    "  - Do NOT use <!-- lota: --> metadata tags in your replies.",
    "  - This is a conversation. Just chat naturally.",
    "",
    "CONVERSATION HISTORY (last 10 messages):",
    conversationHistory || "(no messages yet)",
    "",
    "Reply to the latest message. If the user asks you to do something, do it.",
  ].join("\n");
}

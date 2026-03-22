export type AgentMode = "auto" | "supervised";
export type CliType = "claude" | "gemini";

export interface AgentConfig {
  configPath: string;
  model: string;
  cli: CliType;
  interval: number;
  once: boolean;
  mode: AgentMode;
  singlePhase: boolean;
  agentName: string;
  maxTasksPerCycle: number;
  ghAuth: string;
  githubRepo: string;
  tgAuth: string;
  telegramChatId: string;
  maxRssMb: number;
  useWorktree: boolean;
  chatInterval: number;
}

export interface TaskInfo {
  id: number;
  title: string;
  status: string;
  body?: string;
  workspace?: string;
  depends_on?: number[];
  comment_count?: number;
  plan?: {
    affected_files?: string[];
    goals?: string[];
  };
}

export interface CommentUpdate {
  id: number;
  title: string;
  workspace?: string;
  new_comment_count: number;
}

export interface WorkData {
  phase: "plan" | "execute" | "comments" | "single";
  tasks: TaskInfo[];
  commentUpdates: CommentUpdate[];
}

export interface OrchestratorSnapshot {
  tasks: Map<number, { status: string; commentCount: number; title: string; assignee: string | null; workspace: string | null }>;
  agents: Set<string>;
}

export interface OrchestratorDelta {
  newTasks: Array<{ id: number; title: string; status: string }>;
  statusChanges: Array<{ id: number; title: string; from: string; to: string }>;
  newComments: Array<{ id: number; title: string; count: number }>;
  agentChanges: { online: string[]; offline: string[] };
  completions: Array<{ id: number; title: string }>;
}

export interface ClaudeEvent {
  type: string;
  subtype?: string;
  content_block?: { type?: string; name?: string };
  message?: { content?: Array<{ type: string; name?: string; text?: string; input?: Record<string, unknown> }> };
  cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
}

export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
export const GITHUB_REPO = process.env.GITHUB_REPO || "";
export const AGENT_NAME = process.env.AGENT_NAME || "";

const token = () => process.env.GITHUB_TOKEN || "";
const repo = () => process.env.GITHUB_REPO || "";
const agent = () => process.env.AGENT_NAME || "";

// ── Constants ────────────────────────────────────────────────

const LABEL = {
  TYPE: "task",
  AGENT: "agent:",
  STATUS: "status:",
  PRIORITY: "priority:",
} as const;

const META_VERSION = "v1";

export type TaskStatus = "assigned" | "in-progress" | "completed";
export type TaskPriority = "low" | "medium" | "high";

export interface Task {
  id: number;
  number: number;
  title: string;
  status: string;
  assignee: string | null;
  priority: string | null;
  labels: string[];
  body: string;
  workspace: string | null;
}

export interface LotaError {
  error: string;
  code: string;
  details?: unknown;
}

// ── GitHub API fetch wrapper (with retry + backoff) ─────────

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

async function gh(path: string, opts: RequestInit = {}): Promise<unknown> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`https://api.github.com${path}`, {
        ...opts,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token()}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          ...(opts.headers as Record<string, string> || {}),
        },
      });

      // Rate limit — retry with backoff
      if (res.status === 403 || res.status === 429) {
        const retryAfter = res.headers.get("retry-after");
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      const text = await res.text();
      if (!res.ok) {
        throw Object.assign(
          new Error(`GitHub ${opts.method || "GET"} ${path} -> ${res.status}: ${text}`),
          { status: res.status }
        );
      }

      try { return JSON.parse(text); } catch { return text; }
    } catch (e) {
      lastError = e as Error;
      // Only retry on network errors, not on 4xx
      if ((e as { status?: number }).status && (e as { status?: number }).status! < 500) throw e;
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, BASE_DELAY_MS * Math.pow(2, attempt)));
      }
    }
  }

  throw lastError || new Error(`GitHub request failed after ${MAX_RETRIES} retries`);
}

// ── Metadata helpers (versioned) ────────────────────────────

function parseMetadata(body: string, type: string): Record<string, unknown> | null {
  // Try versioned format first: <!-- lota:v1:plan {...} -->
  const vRe = new RegExp(`<!-- lota:${META_VERSION}:${type} (\\{.*?\\}) -->`, "s");
  const vMatch = body.match(vRe);
  if (vMatch) {
    try { return JSON.parse(vMatch[1]); } catch { /* fall through */ }
  }
  // Fallback: legacy format <!-- lota:plan {...} -->
  const re = new RegExp(`<!-- lota:${type} (\\{.*?\\}) -->`, "s");
  const m = body.match(re);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function formatMetadata(type: string, data: Record<string, unknown>, humanText: string): string {
  return `${humanText}\n\n<!-- lota:${META_VERSION}:${type} ${JSON.stringify(data)} -->`;
}

function parseBodyMeta(body: string): Record<string, unknown> {
  // Try versioned first
  const vMatch = body.match(new RegExp(`<!-- lota:${META_VERSION}:meta (\\{.*?\\}) -->`, "s"));
  if (vMatch) { try { return JSON.parse(vMatch[1]); } catch { /* fall through */ } }
  // Fallback legacy
  const m = body.match(/<!-- lota:meta (\{.*?\}) -->/s);
  if (!m) return {};
  try { return JSON.parse(m[1]); } catch { return {}; }
}

// ── Label helpers ───────────────────────────────────────────

async function swapLabels(issueNumber: number, prefix: string, newLabel: string): Promise<void> {
  // Use single PATCH to replace all labels atomically (instead of DELETE + POST)
  const issue = await gh(`/repos/${repo()}/issues/${issueNumber}`) as { labels: { name: string }[] };
  const kept = issue.labels.filter(l => !l.name.startsWith(prefix)).map(l => l.name);
  kept.push(newLabel);
  await gh(`/repos/${repo()}/issues/${issueNumber}/labels`, {
    method: "PUT",
    body: JSON.stringify({ labels: kept }),
  });
}

type GhIssue = { number: number; title: string; body?: string; labels: { name: string }[] };

function extractFromIssue(issue: GhIssue): Task {
  const labels = issue.labels.map(l => l.name);
  const status = labels.find(l => l.startsWith(LABEL.STATUS))?.slice(LABEL.STATUS.length) || "unknown";
  const assignee = labels.find(l => l.startsWith(LABEL.AGENT))?.slice(LABEL.AGENT.length) || null;
  const priority = labels.find(l => l.startsWith(LABEL.PRIORITY))?.slice(LABEL.PRIORITY.length) || null;
  const meta = parseBodyMeta(issue.body || "");
  const workspace = (meta.workspace as string) || null;
  return { id: issue.number, number: issue.number, title: issue.title, status, assignee, priority, labels, body: issue.body || "", workspace };
}

// ── Router ──────────────────────────────────────────────────

type Handler = (params: Record<string, string>, query: URLSearchParams, body?: Record<string, unknown>) => Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const paramNames: string[] = [];
  const regexStr = path.replace(/:(\w+)/g, (_, name) => {
    paramNames.push(name);
    return "(\\w+)";
  });
  return { method, pattern: new RegExp(`^${regexStr}$`), paramNames, handler };
}

// ── Handlers ────────────────────────────────────────────────

const getTasks: Handler = async (_params, query) => {
  const status = query.get("status");
  const labels = status
    ? `${LABEL.TYPE},${LABEL.STATUS}${status}`
    : `${LABEL.TYPE},${LABEL.AGENT}${agent()}`;
  const issues = await gh(`/repos/${repo()}/issues?labels=${encodeURIComponent(labels)}&state=open`) as GhIssue[];
  return issues.map(extractFromIssue);
};

const getTask: Handler = async (params) => {
  const { id } = params;
  const [issue, comments] = await Promise.all([
    gh(`/repos/${repo()}/issues/${id}`) as Promise<GhIssue>,
    gh(`/repos/${repo()}/issues/${id}/comments`) as Promise<Array<{ body: string; created_at: string; user: { login: string } }>>,
  ]);
  const task = extractFromIssue(issue);
  const plan = comments.map(c => parseMetadata(c.body, "plan")).find(Boolean) || null;
  const report = comments.map(c => parseMetadata(c.body, "report")).find(Boolean) || null;
  return { ...task, plan, report, comments: comments.map(c => ({ body: c.body, created_at: c.created_at, user: c.user.login })) };
};

const createTask: Handler = async (_params, _query, body) => {
  const { title, assign, priority, body: taskBody, workspace } = body as {
    title: string; assign?: string; priority?: string; body?: string; workspace?: string;
  };
  const labels = [LABEL.TYPE, `${LABEL.AGENT}${assign || agent()}`, `${LABEL.STATUS}assigned`];
  if (priority) labels.push(`${LABEL.PRIORITY}${priority}`);
  let finalBody = taskBody || "";
  if (workspace) {
    finalBody += `\n\n<!-- lota:${META_VERSION}:meta ${JSON.stringify({ workspace })} -->`;
  }
  return await gh(`/repos/${repo()}/issues`, {
    method: "POST",
    body: JSON.stringify({ title, body: finalBody, labels }),
  });
};

const savePlan: Handler = async (params, _query, body) => {
  const { id } = params;
  const { goals, affected_files, effort, notes } = body as {
    goals: string[]; affected_files?: string[]; effort?: string; notes?: string;
  };
  const humanText = `## Plan\n${goals.map(g => `- ${g}`).join("\n")}${effort ? `\nEstimated effort: ${effort}` : ""}${notes ? `\n\n${notes}` : ""}`;
  const comment = formatMetadata("plan", { goals, affected_files: affected_files || [], effort: effort || "medium", notes }, humanText);
  return await gh(`/repos/${repo()}/issues/${id}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: comment }),
  });
};

const updateStatus: Handler = async (params, _query, body) => {
  const id = Number(params.id);
  const { status } = body as { status: string };
  await swapLabels(id, LABEL.STATUS, `${LABEL.STATUS}${status}`);
  if (status === "completed") {
    await gh(`/repos/${repo()}/issues/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
  }
  return { ok: true, status };
};

const completeTask: Handler = async (params, _query, body) => {
  const { id } = params;
  const { summary, modified_files, new_files } = body as {
    summary: string; modified_files?: string[]; new_files?: string[];
  };
  const humanText = `## Completion Report\n${summary}${modified_files?.length ? `\n\nModified: ${modified_files.join(", ")}` : ""}${new_files?.length ? `\nNew: ${new_files.join(", ")}` : ""}`;
  const comment = formatMetadata("report", { summary, modified_files, new_files }, humanText);
  await gh(`/repos/${repo()}/issues/${id}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: comment }),
  });
  await swapLabels(Number(id), LABEL.STATUS, `${LABEL.STATUS}completed`);
  await gh(`/repos/${repo()}/issues/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed" }),
  });
  return { ok: true, completed: true };
};

const addComment: Handler = async (params, _query, body) => {
  const { id } = params;
  const { content } = body as { content: string };
  return await gh(`/repos/${repo()}/issues/${id}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: content }),
  });
};

const sync: Handler = async () => {
  const tasks = await getTasks({}, new URLSearchParams());

  // Also fetch in-progress tasks for comment detection
  const inProgressLabels = `${LABEL.TYPE},${LABEL.AGENT}${agent()},${LABEL.STATUS}in-progress`;
  const inProgressIssues = await gh(`/repos/${repo()}/issues?labels=${encodeURIComponent(inProgressLabels)}&state=open`) as Array<GhIssue & { comments: number }>;
  const inProgress = inProgressIssues.map(issue => ({
    ...extractFromIssue(issue),
    comment_count: issue.comments ?? 0,
  }));

  return { tasks, in_progress: inProgress };
};

// ── Route table ─────────────────────────────────────────────

const routes: Route[] = [
  route("GET",  "/tasks",              getTasks),
  route("GET",  "/tasks/:id",          getTask),
  route("POST", "/tasks",              createTask),
  route("POST", "/tasks/:id/plan",     savePlan),
  route("POST", "/tasks/:id/status",   updateStatus),
  route("POST", "/tasks/:id/complete", completeTask),
  route("POST", "/tasks/:id/comment",  addComment),
  route("GET",  "/sync",               sync),
];

// ── Main dispatcher ─────────────────────────────────────────

export async function lota(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
  const url = new URL(path, "http://localhost");
  const p = url.pathname;
  const query = url.searchParams;

  for (const r of routes) {
    if (r.method !== method) continue;
    const match = p.match(r.pattern);
    if (!match) continue;

    const params: Record<string, string> = {};
    r.paramNames.forEach((name, i) => { params[name] = match[i + 1]; });
    return r.handler(params, query, body);
  }

  throw Object.assign(
    new Error(`Unknown route: ${method} ${path}`),
    { code: "LOTA_UNKNOWN_ROUTE" }
  );
}

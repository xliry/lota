import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../api.js";

export function registerTaskTools(server: McpServer) {
  server.tool(
    "list_tasks",
    "List tasks with optional filters (agentId, orgId, status)",
    {
      agentId: z.string().optional().describe("Filter by agent ID"),
      orgId: z.string().optional().describe("Filter by organization ID"),
      status: z.enum(["draft", "planned", "assigned", "in_progress", "completed"]).optional().describe("Filter by status"),
    },
    async ({ agentId, orgId, status }) => {
      try {
        const params: Record<string, string> = {};
        if (agentId) params.agentId = agentId;
        if (orgId) params.orgId = orgId;
        if (status) params.status = status;
        const result = await api.get("/api/tasks", params);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_task",
    "Get full details of a specific task",
    {
      id: z.string().describe("Task ID"),
    },
    async ({ id }) => {
      try {
        const result = await api.get(`/api/tasks/${id}`);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    "create_task",
    "Create a new task in draft status",
    {
      title: z.string().describe("Task title"),
      org_id: z.string().describe("Organization ID"),
      brief: z.string().optional().describe("Task brief/description"),
      priority: z.enum(["low", "medium", "high", "critical"]).optional().describe("Task priority (default: medium)"),
    },
    async ({ title, org_id, brief, priority }) => {
      try {
        const body: Record<string, unknown> = { title, org_id };
        if (brief !== undefined) body.brief = brief;
        if (priority !== undefined) body.priority = priority;
        const result = await api.post("/api/tasks", body);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    "update_task",
    "Update task title, brief, or priority",
    {
      id: z.string().describe("Task ID"),
      title: z.string().optional().describe("New title"),
      brief: z.string().optional().describe("New brief"),
      priority: z.enum(["low", "medium", "high", "critical"]).optional().describe("New priority"),
    },
    async ({ id, title, brief, priority }) => {
      try {
        const body: Record<string, unknown> = {};
        if (title !== undefined) body.title = title;
        if (brief !== undefined) body.brief = brief;
        if (priority !== undefined) body.priority = priority;
        const result = await api.patch(`/api/tasks/${id}`, body);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    "assign_task",
    "Assign a task to an agent by agent_id",
    {
      id: z.string().describe("Task ID"),
      agent_id: z.string().describe("Agent ID to assign"),
    },
    async ({ id, agent_id }) => {
      try {
        const result = await api.post(`/api/tasks/${id}/assign`, { agent_id });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    "update_task_status",
    "Change task status",
    {
      id: z.string().describe("Task ID"),
      status: z.enum(["draft", "planned", "assigned", "in_progress", "completed"]).describe("New status"),
    },
    async ({ id, status }) => {
      try {
        const result = await api.patch(`/api/tasks/${id}/status`, { status });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    "save_task_plan",
    "Save a technical plan for a task (sets status to planned)",
    {
      id: z.string().describe("Task ID"),
      goals: z.array(z.object({ title: z.string(), completed: z.boolean() })).describe("Plan goals"),
      affected_files: z.array(z.string()).describe("Files that will be affected"),
      estimated_effort: z.enum(["low", "medium", "high"]).describe("Estimated effort level"),
      notes: z.string().describe("Additional notes"),
    },
    async ({ id, goals, affected_files, estimated_effort, notes }) => {
      try {
        const result = await api.put(`/api/tasks/${id}/plan`, {
          goals,
          affected_files,
          estimated_effort,
          notes,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}

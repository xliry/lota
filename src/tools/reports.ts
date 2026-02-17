import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../api.js";

export function registerReportTools(server: McpServer) {
  server.tool(
    "list_reports",
    "List reports, optionally filtered by task ID",
    {
      taskId: z.string().optional().describe("Filter by task ID"),
    },
    async ({ taskId }) => {
      try {
        const params: Record<string, string> = {};
        if (taskId) params.taskId = taskId;
        const result = await api.get("/api/reports", params);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    "submit_report",
    "Submit a completion report for a task (auto-completes the task)",
    {
      task_id: z.string().describe("Task ID this report is for"),
      summary: z.string().optional().describe("Summary of work done"),
      deliverables: z.array(z.object({ title: z.string(), completed: z.boolean() })).optional().describe("List of deliverables"),
      new_files: z.array(z.string()).optional().describe("New files created"),
      modified_files: z.array(z.string()).optional().describe("Files modified"),
      test_plan: z.string().optional().describe("Testing plan or results"),
      deployment_notes: z.string().optional().describe("Deployment notes"),
      agent_id: z.string().optional().describe("Agent ID submitting the report"),
    },
    async ({ task_id, summary, deliverables, new_files, modified_files, test_plan, deployment_notes, agent_id }) => {
      try {
        const body: Record<string, unknown> = { task_id };
        if (summary !== undefined) body.summary = summary;
        if (deliverables !== undefined) body.deliverables = deliverables;
        if (new_files !== undefined) body.new_files = new_files;
        if (modified_files !== undefined) body.modified_files = modified_files;
        if (test_plan !== undefined) body.test_plan = test_plan;
        if (deployment_notes !== undefined) body.deployment_notes = deployment_notes;
        if (agent_id !== undefined) body.agent_id = agent_id;
        const result = await api.post("/api/reports", body);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}

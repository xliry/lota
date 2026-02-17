import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../api.js";

export function registerOrganizationTools(server: McpServer) {
  server.tool(
    "list_organizations",
    "List all organizations",
    {},
    async () => {
      try {
        const result = await api.get("/api/organizations");
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_organization",
    "Get details of a specific organization",
    {
      id: z.string().describe("Organization ID"),
    },
    async ({ id }) => {
      try {
        const result = await api.get(`/api/organizations/${id}`);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    "create_organization",
    "Create a new organization",
    {
      name: z.string().describe("Organization name"),
      github_repo_url: z.string().optional().describe("GitHub repository URL"),
    },
    async ({ name, github_repo_url }) => {
      try {
        const body: Record<string, unknown> = { name };
        if (github_repo_url !== undefined) body.github_repo_url = github_repo_url;
        const result = await api.post("/api/organizations", body);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    "list_members",
    "List team members, optionally filtered by organization",
    {
      orgId: z.string().optional().describe("Filter by organization ID"),
    },
    async ({ orgId }) => {
      try {
        const params: Record<string, string> = {};
        if (orgId) params.orgId = orgId;
        const result = await api.get("/api/members", params);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}

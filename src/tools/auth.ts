import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../api.js";

interface Member {
  id: string;
  name: string;
  agent_id: string;
  role: string;
  org_id: string;
  organizations?: { name: string };
}

export function registerAuthTools(server: McpServer) {
  server.tool(
    "lota_login",
    "Login to LOTA by selecting an agent. Lists available agents and sets the active agent for this session.",
    {
      agent_id: z.string().optional().describe("Agent ID to login as. If not provided, lists all available agents."),
    },
    async ({ agent_id }) => {
      try {
        if (!agent_id) {
          const members = await api.get<Member[]>("/api/members");
          if (members.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: "No agents found. Create a member first using create_member tool.",
              }],
            };
          }
          const list = members.map((m) =>
            `- **${m.name}** (agent_id: \`${m.agent_id}\`, role: ${m.role}, org: ${m.organizations?.name || m.org_id})`
          ).join("\n");
          return {
            content: [{
              type: "text" as const,
              text: `Available agents:\n\n${list}\n\nCall lota_login again with the agent_id to login.`,
            }],
          };
        }

        const members = await api.get<Member[]>("/api/members");
        const member = members.find((m) => m.agent_id === agent_id);
        if (!member) {
          return {
            content: [{
              type: "text" as const,
              text: `Error: Agent "${agent_id}" not found.`,
            }],
            isError: true,
          };
        }

        api.setAgentId(agent_id);
        return {
          content: [{
            type: "text" as const,
            text: `Logged in as **${member.name}** (${member.role})\nAgent ID: ${member.agent_id}\nOrg: ${member.organizations?.name || member.org_id}`,
          }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "lota_whoami",
    "Check which agent is currently logged in",
    {},
    async () => {
      const agentId = api.getAgentId();
      if (!agentId) {
        return {
          content: [{
            type: "text" as const,
            text: "Not logged in. Use lota_login to select an agent.",
          }],
        };
      }
      try {
        const members = await api.get<Member[]>("/api/members");
        const member = members.find((m) => m.agent_id === agentId);
        if (!member) {
          return {
            content: [{
              type: "text" as const,
              text: `Logged in as agent_id: ${agentId} (member not found in DB)`,
            }],
          };
        }
        return {
          content: [{
            type: "text" as const,
            text: `Logged in as **${member.name}** (${member.role})\nAgent ID: ${member.agent_id}\nOrg: ${member.organizations?.name || member.org_id}`,
          }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Agent ID: ${agentId} (could not fetch details: ${(e as Error).message})` }],
        };
      }
    }
  );
}

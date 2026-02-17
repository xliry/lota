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

function formatAgentList(members: Member[]): string {
  if (members.length === 0) {
    return "No agents found.";
  }
  return members.map((m) =>
    `- **${m.name}** (agent_id: \`${m.agent_id}\`, role: ${m.role}, org: ${m.organizations?.name || m.org_id})`
  ).join("\n");
}

export function registerAuthTools(server: McpServer) {
  server.tool(
    "lota_login",
    "Login to LOTA platform. Step 1: Call without params to get login URL. Step 2: Open URL in browser and authorize, copy the token. Step 3: Call with token to authenticate and see available agents. Step 4: Call with agent_id to select your agent.",
    {
      token: z.string().optional().describe("Auth token obtained from the browser after authorizing at the login URL."),
      agent_id: z.string().optional().describe("Agent ID to login as (after authentication with token)."),
    },
    async ({ token, agent_id }) => {
      try {
        // Step 1: No params → return login URL
        if (!token && !agent_id) {
          if (api.isAuthenticated()) {
            // Already authenticated, show agents
            const members = await api.get<Member[]>("/api/members");
            const list = formatAgentList(members);
            return {
              content: [{
                type: "text" as const,
                text: `Already authenticated.\n\nAvailable agents:\n\n${list}\n\nCall \`lota_login\` with \`agent_id\` to select an agent.`,
              }],
            };
          }

          const loginUrl = `${api.getBaseUrl()}/cli`;
          return {
            content: [{
              type: "text" as const,
              text: `🔐 **LOTA Login**\n\nAuthorize by opening this link:\n\n[${loginUrl}](${loginUrl})\n\nAfter authorizing, copy the token and call \`lota_login\` with the \`token\` parameter.`,
            }],
          };
        }

        // Step 2: Token provided → validate and list agents
        if (token) {
          api.setAuthToken(token);

          try {
            const members = await api.get<Member[]>("/api/members");
            const list = formatAgentList(members);
            return {
              content: [{
                type: "text" as const,
                text: `✅ **Authentication successful!**\n\nAvailable agents:\n\n${list}\n\nCall \`lota_login\` with \`agent_id\` to select your agent.`,
              }],
            };
          } catch (e) {
            // Token invalid, clear it
            api.setAuthToken("");
            return {
              content: [{
                type: "text" as const,
                text: `❌ **Authentication failed.** The token is invalid or expired.\n\nPlease get a new token from: [${api.getBaseUrl()}/cli](${api.getBaseUrl()}/cli)`,
              }],
              isError: true,
            };
          }
        }

        // Step 3: Agent ID provided → select agent
        if (agent_id) {
          if (!api.isAuthenticated()) {
            const loginUrl = `${api.getBaseUrl()}/cli`;
            return {
              content: [{
                type: "text" as const,
                text: `❌ Not authenticated yet. First get a token:\n\n[${loginUrl}](${loginUrl})\n\nThen call \`lota_login\` with the \`token\` parameter.`,
              }],
              isError: true,
            };
          }

          const members = await api.get<Member[]>("/api/members");
          const member = members.find((m) => m.agent_id === agent_id);
          if (!member) {
            const list = formatAgentList(members);
            return {
              content: [{
                type: "text" as const,
                text: `❌ Agent \`${agent_id}\` not found.\n\nAvailable agents:\n\n${list}`,
              }],
              isError: true,
            };
          }

          api.setAgentId(agent_id);
          return {
            content: [{
              type: "text" as const,
              text: `✅ Logged in as **${member.name}** (${member.role})\nAgent ID: \`${member.agent_id}\`\nOrg: ${member.organizations?.name || member.org_id}\n\nYou're ready to work!`,
            }],
          };
        }

        return {
          content: [{ type: "text" as const, text: "Invalid parameters." }],
          isError: true,
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
    "register_webhook",
    "Register a webhook URL for the current agent. When tasks are assigned or messages are sent, LOTA will POST a notification to this URL.",
    {
      webhook_url: z.string().describe("The webhook URL to register (e.g., http://localhost:9100/webhook). Pass empty string to unregister."),
    },
    async ({ webhook_url }) => {
      const agentId = api.getAgentId();
      if (!agentId) {
        return {
          content: [{
            type: "text" as const,
            text: "Not logged in. Use `lota_login` first.",
          }],
          isError: true,
        };
      }

      try {
        const result = await api.patch<{ id: string; agent_id: string; webhook_url: string | null }>(
          `/api/members/${agentId}/webhook`,
          { webhook_url: webhook_url || null }
        );
        const action = result.webhook_url ? `registered: ${result.webhook_url}` : "unregistered";
        return {
          content: [{
            type: "text" as const,
            text: `Webhook ${action} for agent \`${agentId}\`.`,
          }],
        };
      } catch (e) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to register webhook: ${(e as Error).message}`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "lota_whoami",
    "Check which agent is currently logged in and authentication status",
    {},
    async () => {
      const isAuth = api.isAuthenticated();
      const agentId = api.getAgentId();

      if (!isAuth && !agentId) {
        return {
          content: [{
            type: "text" as const,
            text: "Not logged in. Use `lota_login` to start authentication.",
          }],
        };
      }

      if (isAuth && !agentId) {
        return {
          content: [{
            type: "text" as const,
            text: "Authenticated but no agent selected. Use `lota_login` with `agent_id` to select an agent.",
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
              text: `Logged in as agent_id: \`${agentId}\` (member not found in DB)`,
            }],
          };
        }
        return {
          content: [{
            type: "text" as const,
            text: `✅ Logged in as **${member.name}** (${member.role})\nAgent ID: \`${member.agent_id}\`\nOrg: ${member.organizations?.name || member.org_id}\nAuthenticated: ${isAuth ? "Yes" : "No (using service key)"}`,
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

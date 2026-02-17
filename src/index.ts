import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerReportTools } from "./tools/reports.js";
import { registerOrganizationTools } from "./tools/organizations.js";

const server = new McpServer({
  name: "lota-mcp",
  version: "1.0.0",
});

registerTaskTools(server);
registerReportTools(server);
registerOrganizationTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerProtocolTools } from "./tools/protocol.js";
import { registerAdminTools } from "./tools/admin.js";

export const VERSION = "1.0.0";
const STARTED_AT = new Date().toISOString();

const server = new McpServer({
  name: "lota-mcp",
  version: VERSION,
});

registerProtocolTools(server);
registerAdminTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

/**
 * Stdio entry point for the MCP server.
 *
 * Launched by the VSCode extension (or standalone) via:
 *   node dist/mcp/stdio.js
 *
 * Communicates over stdin/stdout using the MCP stdio transport.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server failed to start:", err);
  process.exit(1);
});

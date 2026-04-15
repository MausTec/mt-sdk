/**
 * MCP server for the Maus-Tec Plugin SDK.
 *
 * Reduces error and onboarding overhead by providing direct, purpose built
 * tools for working with plugin files.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerRuntimeTools } from "./tools/runtime.js";
import { registerLanguageTools } from "./tools/language.js";
import { registerAuthoringTools } from "./tools/authoring.js";
import { registerValidationTools } from "./tools/validation.js";

const SERVER_NAME = "mt-sdk";
const SERVER_VERSION = "0.1.0";

/**
 * Create and configure the MCP server with all tool domains registered.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Register tool domains — each module owns its own set of tools.
  registerRuntimeTools(server);
  registerLanguageTools(server);
  registerAuthoringTools(server);
  registerValidationTools(server);

  return server;
}

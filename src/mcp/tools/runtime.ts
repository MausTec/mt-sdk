/**
 * Runtime tools: query device APIs and builtin operations.
 *
 * Planned tools:
 *   - mtp_get_runtime_api   : Host functions + events for a device SKU/version
 *   - mtp_get_builtins      : Core mt-actions builtin operations
 *   - mtp_list_skus         : All registered device SKUs and firmware versions
 *   - mtp_lookup_function   : Single-function documentation lookup
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerRuntimeTools(_server: McpServer): void {
  // Tool registrations will go here. Example shape:
  //
  // server.registerTool("mtp_list_skus", {
  //   title: "List Device SKUs",
  //   description: "Return all registered device SKUs with platform and version info.",
  // }, async () => {
  //   return { content: [{ type: "text", text: JSON.stringify(result) }] };
  // });
}

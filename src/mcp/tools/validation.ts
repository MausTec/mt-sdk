/**
 * Validation tools: parse, validate, transpile, and check permissions.
 *
 * Planned tools:
 *   - mtp_validate_source    : Parse + validate MTP source, return diagnostics
 *   - mtp_transpile          : Compile MTP source to JSON plugin format
 *   - mtp_check_permissions  : Analyze required vs declared permissions
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerValidationTools(_server: McpServer): void {
  // Tool registrations will go here.
}

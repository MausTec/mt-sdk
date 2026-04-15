/**
 * Doc registry entry types.
 *
 * These types define the structured documentation format consumed by:
 * - MCP server (returns markdown to AI agents)
 * - LSP hover/completion (returns summary + first example)
 * - VSCode webview (renders searchable reference)
 * - Docs site generator (produces Starlight markdown)
 */

/** Top-level category for organizing documentation entries. */
export type DocCategory = "language" | "runtime" | "builtin" | "guide";

/** A code example attached to a doc entry. */
export interface CodeExample {
  /** Short label for the example (e.g. "Basic pipe chain"). */
  label: string;

  /** MTP source code. */
  mtp: string;

  /** Equivalent compiled JSON output, if illustrative. */
  json?: string;

  /** Brief description of what the example demonstrates. */
  description?: string;
}

/** A single documentation entry in the registry. */
export interface DocEntry {
  /** Unique identifier (kebab-case, e.g. "pipes", "control-flow"). */
  id: string;

  /** Human-readable title. */
  title: string;

  /** Organizational category. */
  category: DocCategory;

  /** One-line summary — used in hover tooltips and completion details. */
  summary: string;

  /** Full markdown body — used in MCP responses, webview, and docs site. */
  body: string;

  /** Optional code examples shown after the body. */
  examples?: CodeExample[];

  /** IDs of related entries for cross-linking. */
  related?: string[];
}

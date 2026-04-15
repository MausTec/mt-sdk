/**
 * Doc registry — single source of truth for all SDK documentation.
 *
 * Content modules register entries here. Consumers (MCP, LSP, webview, docs site)
 * query the registry by ID or category.
 *
 * Content is NOT populated in this file — see individual topic modules
 * in src/docs/language/, src/docs/builtins/, etc.
 */

import type { DocEntry, DocCategory } from "./types.js";

const entries: Map<string, DocEntry> = new Map();

/**
 * Register a documentation entry. Throws on duplicate IDs.
 */
export function registerDoc(entry: DocEntry): void {
  if (entries.has(entry.id)) {
    throw new Error(`Duplicate doc entry ID: "${entry.id}"`);
  }
  entries.set(entry.id, entry);
}

/**
 * Register multiple documentation entries at once.
 */
export function registerDocs(docs: DocEntry[]): void {
  for (const entry of docs) {
    registerDoc(entry);
  }
}

/**
 * Retrieve a single doc entry by ID, or undefined if not found.
 */
export function getDoc(id: string): DocEntry | undefined {
  return entries.get(id);
}

/**
 * Retrieve all doc entries matching a category.
 */
export function getDocsByCategory(category: DocCategory): DocEntry[] {
  return [...entries.values()].filter((e) => e.category === category);
}

/**
 * Retrieve all registered doc entries.
 */
export function getAllDocs(): DocEntry[] {
  return [...entries.values()];
}

/**
 * List all registered doc IDs.
 */
export function listDocIds(): string[] {
  return [...entries.keys()];
}

/**
 * Emitter — walks a PluginNode AST and produces the mt-actions JSON plugin schema.
 *
 * Module structure:
 * - context.ts      — shared EmitContext (diagnostics, scope tracking)
 * - plugin.ts       — top-level plugin emission (metadata, config, globals, match)
 * - functions.ts    — def, fn, on handler emission + local extraction
 * - statements.ts   — Stmt[] -> MtpAction[] compilation (TODO)
 * - expressions.ts  — Expr -> MtpValue / MtpAction[] compilation (TODO)
 * - conditions.ts   — Expr -> MtpCondition compilation (TODO)
 */

import type { PluginNode } from "../ast.js";
import { PluginEmitter } from "./plugin.js";

// --- Public API ---------------------------------------------------------------

export type { EmitResult } from "./plugin.js";

/**
 * Walk a `PluginNode` AST and produce the mt-actions JSON plugin schema.
 */
export function emit(ast: PluginNode) {
  return new PluginEmitter().emit(ast);
}

// Re-exported for LSP completion, docs, and lang-defs consumers.
export { METADATA_FIELDS, MATCH_FIELDS } from "./plugin.js";
export type { FieldDef } from "./plugin.js";

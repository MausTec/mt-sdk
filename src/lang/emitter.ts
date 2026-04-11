import type { PluginNode } from "./ast.js";
import type { LangDiagnostic } from "./diagnostics.js";

export interface EmitResult {
  plugin: Record<string, unknown>;
  diagnostics: LangDiagnostic[];
}

/**
 * Walk a `PluginNode` AST and produce the mt-actions JSON plugin schema.
 *
 * Performs semantic checks (scope validation, type annotations, etc.) and
 * emits diagnostics for violations. The `plugin` object in the result is
 * always present, but will be empty `{}` when parsing produced no usable AST.
 *
 * @stub Not yet implemented. Returns an empty plugin object.
 */
export function emit(_ast: PluginNode): EmitResult {
  return { plugin: {}, diagnostics: [] };
}

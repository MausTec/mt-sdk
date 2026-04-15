import type { Stmt } from "../ast.js";
import type { MtpAction } from "../../core/mtp-types.js";
import type { EmitContext } from "./context.js";

/**
 * Compile a statement list into mt-actions action objects.
 *
 * TODO: This is the main entry point for statement compilation.
 * Each statement kind needs its own handler:
 *
 * - LocalDeclStmt  -> {set: {$name: value}} (init only; var registration is handled by extractLocals)
 * - AssignLocalStmt  -> {set: {$name: value}} or arithmetic chain with "to"
 * - AssignGlobalStmt -> {set: {$name: value}} or arithmetic chain with "to"
 * - ExprStmt         -> compile expression as standalone action(s)
 * - IfStmt           -> {if: {condition, then: [...], else?: [...]}}
 * - ReturnStmt       -> {return: value}
 * - ConditionalStmt  -> wrap body statement in {if: {condition, then: [body]}}
 */
export function emitStatements(
  _stmts: Stmt[],
  _ctx: EmitContext,
): MtpAction[] {
  // TODO: Implement statement compilation in a future phase.
  // For now, statement compilation is not yet wired in; the plugin emitter
  // still uses extractLocals() for the init-only actions.
  return [];
}

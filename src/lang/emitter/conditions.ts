import type { Expr } from "../ast.js";
import type { MtpCondition } from "../../core/mtp-types.js";
import type { BlockEmitContext } from "./context.js";

/**
 * Compile an expression into an MtpCondition predicate for use in
 * `if` and `while` blocks.
 *
 * TODO: Handle expression kinds:
 * - Binary(== != < > <= >=) -> {eq/neq/lt/gt/lte/gte: [l, r]}
 * - Binary(and)             -> {all: [left_cond, right_cond]}
 * - Binary(or)              -> {any: [left_cond, right_cond]}
 * - Unary(not)              -> {none: [inner_cond]}
 * - Nested combinations     -> recursive condition trees
 * - Non-condition exprs     -> diagnostic error
 */
export function exprToCondition(
  _expr: Expr,
  _ctx: BlockEmitContext,
): MtpCondition | null {
  // TODO: Implement in a future phase.
  return null;
}

import type { Expr } from "../ast.js";
import type { MtpAction, MtpValue } from "../../core/mtp-types.js";
import type { EmitContext } from "./context.js";

/**
 * Convert a simple expression to an MtpValue (scalar).
 * Returns null if the expression is too complex to represent as a bare value
 * (e.g. arithmetic, calls), and the caller should fall back to emitting actions.
 *
 * TODO: Handle all leaf expression kinds:
 * - Literal    -> raw value (number, string, boolean)
 * - Identifier -> local variable name string
 * - GlobalVar  -> "$name"
 * - Accumulator -> "$_"
 * - ErrorCode  -> "$!"
 * - ConfigRef  -> "@name"
 */
export function exprToValue(
  _expr: Expr,
  _ctx: EmitContext,
): MtpValue | null {
  // TODO: Implement in a future phase.
  return null;
}

/**
 * Compile an expression into one or more mt-actions action objects.
 * Used when an expression appears as a standalone statement or as the RHS
 * of an assignment where the value is too complex for exprToValue().
 *
 * The optional `target` parameter specifies a "to" variable for the result.
 * When omitted, the result flows to $_ (the accumulator).
 *
 * TODO: Handle expression kinds:
 * - Binary(+ - * /) -> {add/sub/mul/div: [l, r], to?: target}
 * - Binary(<>)      -> {concat: [l, r], to?: target}
 * - Call            -> {funcName: [args]} or bare "funcName" string
 * - Pipe            -> sequence of actions with $_ carry-through
 * - Index           -> {getbyte: [target, index], to?: target}
 * - Unary(-)        -> {sub: [0, operand], to?: target}
 * - Nested exprs    -> flatten via $_ accumulator
 */
export function exprToActions(
  _expr: Expr,
  _ctx: EmitContext,
  _target?: string,
): MtpAction[] {
  // TODO: Implement in a future phase.
  return [];
}

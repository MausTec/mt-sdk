import type {
  Expr,
  LiteralExpr,
  GlobalVarExpr,
  AccumulatorExpr,
  ErrorCodeExpr,
  IdentifierExpr,
} from "../ast.js";
import type { MtpAction, MtpValue } from "../../core/mtp-types.js";
import type { BlockEmitContext } from "./context.js";

// --- Simple expressions -------------------------------------------------------

/**
 * Subset of {@link Expr} that can be represented as a bare {@link MtpValue}.
 *
 * Notably excludes:
 * - ConfigRef  -- compiles to a `getPluginConfig` action, not a value
 * - Binary, Unary, Call, Pipe, Index -- require action sequences
 */
export type SimpleExpr =
  | LiteralExpr
  | GlobalVarExpr
  | AccumulatorExpr
  | ErrorCodeExpr
  | IdentifierExpr;

const SIMPLE_KINDS: ReadonlySet<string> = new Set<SimpleExpr["kind"]>([
  "Literal",
  "GlobalVar",
  "Accumulator",
  "ErrorCode",
  "Identifier",
]);

/** Type guard: true when `expr` can be converted to a bare MtpValue. */
export function isSimpleExpr(expr: Expr): expr is SimpleExpr {
  return SIMPLE_KINDS.has(expr.kind);
}

// --- exprToValue --------------------------------------------------------------

/**
 * Convert a simple (leaf) expression to an {@link MtpValue}.
 * Returns `null` for any expression kind that requires action emission
 * (ConfigRef, Binary, Unary, Call, Pipe, Index).
 */
export function exprToValue(
  expr: Expr,
  _ctx: BlockEmitContext,
): MtpValue | null {
  if (!isSimpleExpr(expr)) return null;

  switch (expr.kind) {
    case "Literal":
      return expr.value;
    case "GlobalVar":
      return `$${expr.name}`;
    case "Accumulator":
      return "$_";
    case "ErrorCode":
      return "$!";
    case "Identifier":
      return `$${expr.name}`;
  }
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
  _ctx: BlockEmitContext,
  _target?: string,
): MtpAction[] {
  // TODO: Implement in a future phase.
  return [];
}

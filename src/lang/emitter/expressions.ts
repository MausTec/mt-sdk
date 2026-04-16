import type {
  Expr,
  LiteralExpr,
  GlobalVarExpr,
  AccumulatorExpr,
  ErrorCodeExpr,
  IdentifierExpr,
  CallExpr,
  BinaryOp,
} from "../ast.js";
import type { MtpAction, MtpActionObject, MtpValue } from "../../core/mtp-types.js";
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

// --- Argument resolution ------------------------------------------------------

/**
 * Map from MTP binary operator to the mt-actions action key.
 * Comparison operators (==, !=, etc.) and logical operators (and, or)
 * are handled by the condition emitter, not here.
 */
const BINARY_OP_ACTION: Partial<Record<BinaryOp, string>> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
  "<>": "concat",
};

/**
 * Resolve an expression to a bare {@link MtpValue}, emitting prerequisite
 * actions into `prereqs` if the expression is complex.
 *
 * When `canUseAccumulator` is true AND the expression is complex, the
 * result flows through `$_` (no temp allocation). Otherwise a temp is
 * allocated via `ctx.allocTemp()`.
 */
export function resolveArg(
  expr: Expr,
  ctx: BlockEmitContext,
  prereqs: MtpAction[],
  canUseAccumulator: boolean,
): MtpValue {
  const simple = exprToValue(expr, ctx);
  if (simple !== null) return simple;

  const target = canUseAccumulator ? undefined : ctx.allocTemp();
  prereqs.push(...exprToActions(expr, ctx, target));
  return target ?? "$_";
}

// --- exprToActions ------------------------------------------------------------

/** Attach a `to` key only when a target is specified. */
function withTarget(action: MtpActionObject, target?: string): MtpActionObject {
  if (target !== undefined) action.to = target;
  return action;
}

/** Build an MtpActionObject from a single dynamic key + value. */
function actionObj(key: string, value: unknown): MtpActionObject {
  const obj = Object.create(null) as MtpActionObject;
  obj[key] = value;
  return obj;
}

/**
 * Compile an expression into one or more mt-actions action objects.
 *
 * The optional `target` parameter specifies a `to` variable for the result.
 * When omitted, the result flows to `$_` (the accumulator).
 */
export function exprToActions(
  expr: Expr,
  ctx: BlockEmitContext,
  target?: string,
): MtpAction[] {
  if (isSimpleExpr(expr)) return [];

  switch (expr.kind) {
    case "ConfigRef":
      return [withTarget(actionObj("getPluginConfig", expr.name), target)];

    case "Unary": {
      if (expr.op === "-") {
        const prereqs: MtpAction[] = [];
        const operand = resolveArg(expr.operand, ctx, prereqs, !ctx.accumulatorReserved);
        return [...prereqs, withTarget(actionObj("sub", [0, operand]), target)];
      }
      // "not" is a condition, not a value expression
      ctx.error(`Cannot emit unary "${expr.op}" as a value expression`, expr.span);
      return [];
    }

    case "Binary": {
      const actionKey = BINARY_OP_ACTION[expr.op];
      if (actionKey === undefined) {
        // Comparison / logical ops are conditions, not value expressions
        ctx.error(`Cannot emit binary "${expr.op}" as a value expression`, expr.span);
        return [];
      }

      const leftSimple = isSimpleExpr(expr.left);
      const rightSimple = isSimpleExpr(expr.right);
      const prereqs: MtpAction[] = [];

      let leftVal: MtpValue;
      let rightVal: MtpValue;

      if (leftSimple && rightSimple) {
        // Both simple — no prereqs
        leftVal = exprToValue(expr.left, ctx)!;
        rightVal = exprToValue(expr.right, ctx)!;
      } else if (leftSimple) {
        // Only right is complex — right gets accumulator (if free)
        leftVal = exprToValue(expr.left, ctx)!;
        rightVal = resolveArg(expr.right, ctx, prereqs, !ctx.accumulatorReserved);
      } else if (rightSimple) {
        // Only left is complex — left gets accumulator (if free)
        rightVal = exprToValue(expr.right, ctx)!;
        leftVal = resolveArg(expr.left, ctx, prereqs, !ctx.accumulatorReserved);
      } else {
        // Both complex — first gets temp (or accumulator if free), second gets the other
        const accFree = !ctx.accumulatorReserved;
        leftVal = resolveArg(expr.left, ctx, prereqs, false);
        rightVal = resolveArg(expr.right, ctx, prereqs, accFree);
      }

      const action = actionObj(actionKey, [leftVal, rightVal]);

      return [...prereqs, withTarget(action, target)];
    }

    case "Call":
      return emitCall(expr, ctx, target);

    case "Pipe":
    case "Index":
      // TODO: Implement in a future phase.
      return [];
  }
}

// --- Call emitter -------------------------------------------------------------

/**
 * Emit a function call expression.
 *
 * All calls use **positional** argument form in the JSON output:
 * - 0 args → `[]`
 * - 1 arg  → the value directly (scalar shorthand)
 * - 2+ args → array of values
 *
 * Named args in the source language are compiled to positional by the
 * compiler using the function's declared parameter order.
 *
 * **Plugin-local** calls (name found in `ctx.localFunctions`) are prefixed
 * with `@` in the action key: `{ "@mapSpeed": [128], to? }`
 *
 * **Host/builtin** calls use bare keys: `{ "bleWrite": "$cmd", to? }`
 */
function emitCall(
  expr: CallExpr,
  ctx: BlockEmitContext,
  target?: string,
): MtpAction[] {
  const isLocal = ctx.localFunctions.has(expr.name);

  // TODO: Evaluate if arg validation belongs in the parser or in a semantic analysis pass
  if (isLocal && expr.args.length > ctx.localFunctions.get(expr.name)!.length) {
    const expected = ctx.localFunctions.get(expr.name)!.length;

    ctx.error(
      `Function "${expr.name}" expects ${expected} argument(s), got ${expr.args.length}`,
      expr.span,
    );
  }

  const actionKey = isLocal ? `@${expr.name}` : expr.name;

  const prereqs: MtpAction[] = [];
  const resolvedArgs: MtpValue[] = [];

  for (let i = 0; i < expr.args.length; i++) {
    const isLast = i === expr.args.length - 1;
    resolvedArgs.push(
      resolveArg(expr.args[i]!, ctx, prereqs, isLast && !ctx.accumulatorReserved),
    );
  }

  let argValue: MtpValue | MtpValue[];
  if (resolvedArgs.length === 0) {
    argValue = [];
  } else if (resolvedArgs.length === 1) {
    argValue = resolvedArgs[0]!;
  } else {
    argValue = resolvedArgs;
  }

  const action = actionObj(actionKey, argValue);
  return [...prereqs, withTarget(action, target)];
}

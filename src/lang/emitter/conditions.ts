import type { BinaryOp, Expr } from "../ast.js";
import type { MtpAction, MtpCondition } from "../../core/mtp-types.js";
import type { BlockEmitContext } from "./context.js";
import { exprToValue, isSimpleExpr, resolveArg } from "./expressions.js";

// --- Public result type -------------------------------------------------------

/** Result of compiling an expression to a condition predicate. */
export interface ConditionResult {
  /** Actions that must execute before the condition is tested. */
  prereqs: MtpAction[];
  /** The condition predicate for use in if/while. */
  condition: MtpCondition;
}

// --- Operator mapping ---------------------------------------------------------

const COMPARISON_OP: Partial<Record<BinaryOp, keyof MtpCondition>> = {
  "==": "eq",
  "!=": "neq",
  "<": "lt",
  ">": "gt",
  "<=": "lte",
  ">=": "gte",
};

// --- Public entry point -------------------------------------------------------

/**
 * Compile an expression into an {@link MtpCondition} predicate for use
 * in `if` and `while` blocks.
 *
 * Returns a {@link ConditionResult} containing prerequisite actions
 * (for complex operands that must be pre-evaluated into temps) and the
 * condition object itself.  Returns `null` on unrecoverable error.
 *
 * Bare truthy expressions (identifiers, accumulators, calls, etc.) are
 * desugared to `{ neq: [value, 0] }`.
 */
export function exprToCondition(
  expr: Expr,
  ctx: BlockEmitContext,
): ConditionResult | null {
  switch (expr.kind) {
    case "Binary": {
      const cmpKey = COMPARISON_OP[expr.op];
      if (cmpKey !== undefined) return comparisonToCondition(cmpKey, expr.left, expr.right, ctx);
      if (expr.op === "and") return combinatorToCondition("all", expr, ctx);
      if (expr.op === "or") return combinatorToCondition("any", expr, ctx);

      // Arithmetic / string-concat ops are value expressions, not conditions.
      // Treat as bare truthy: pre-evaluate then check neq 0.
      return truthyCondition(expr, ctx);
    }

    case "Unary": {
      if (expr.op === "not") {
        const inner = exprToCondition(expr.operand, ctx);
        if (inner === null) return null;
        return { prereqs: inner.prereqs, condition: { none: [inner.condition] } };
      }

      // Unary minus is arithmetic, treat as truthy
      return truthyCondition(expr, ctx);
    }

    // Everything else: bare truthy
    default:
      return truthyCondition(expr, ctx);
  }
}

// --- Comparison ---------------------------------------------------------------

function comparisonToCondition(
  key: keyof MtpCondition,
  left: Expr,
  right: Expr,
  ctx: BlockEmitContext,
): ConditionResult {
  const prereqs: MtpAction[] = [];

  // Complex operands always go to temps (not the accumulator) because the
  // condition itself doesn't consume $_. Both sides use canUseAccumulator: false.
  const leftVal = isSimpleExpr(left)
    ? exprToValue(left, ctx)!
    : resolveArg(left, ctx, prereqs, false);

  const rightVal = isSimpleExpr(right)
    ? exprToValue(right, ctx)!
    : resolveArg(right, ctx, prereqs, false);

  return { prereqs, condition: { [key]: [leftVal, rightVal] } as MtpCondition };
}

// --- Logical combinators (with same-op flattening) ----------------------------

function combinatorToCondition(
  combinator: "all" | "any",
  expr: Expr & { kind: "Binary" },
  ctx: BlockEmitContext,
): ConditionResult | null {
  const prereqs: MtpAction[] = [];
  const children: MtpCondition[] = [];

  collectCombinator(combinator, expr, ctx, prereqs, children);
  if (children.length === 0) return null;

  return { prereqs, condition: { [combinator]: children } as MtpCondition };
}

/**
 * Recursively collect condition children for a same-op combinator chain,
 * flattening nested nodes that use the same operator.
 *
 * e.g. `a == 1 and b == 2 and c == 3` (parsed as `(a == 1 and b == 2) and c == 3`)
 * flattens to `{ all: [eq1, eq2, eq3] }` instead of `{ all: [{ all: [eq1, eq2] }, eq3] }`.
 */
function collectCombinator(
  combinator: "all" | "any",
  expr: Expr,
  ctx: BlockEmitContext,
  prereqs: MtpAction[],
  children: MtpCondition[],
): boolean {
  const matchOp = combinator === "all" ? "and" : "or";

  if (expr.kind === "Binary" && expr.op === matchOp) {
    const leftOk = collectCombinator(combinator, expr.left, ctx, prereqs, children);
    if (!leftOk) return false;

    const rightOk = collectCombinator(combinator, expr.right, ctx, prereqs, children);
    if (!rightOk) return false;

    return true;
  }

  // Leaf of the combinator chain — compile as a standalone condition
  const result = exprToCondition(expr, ctx);
  if (result === null) return false;

  prereqs.push(...result.prereqs);
  children.push(result.condition);
  return true;
}

// --- Condition inversion (for `unless`) ---------------------------------------

const INVERSE_OP: Record<string, keyof MtpCondition> = {
  eq: "neq",
  neq: "eq",
  lt: "gte",
  gte: "lt",
  gt: "lte",
  lte: "gt",
};

/**
 * Invert a condition predicate, producing the logical opposite.
 *
 * Used by `unless` to avoid the `{ none: [{ neq: ... }] }` double-negative.
 * Applies comparison flips for simple predicates and De Morgan's law for
 * combinators. Double negation (`none`) is eliminated.
 */
export function invertCondition(cond: MtpCondition): MtpCondition {
  // Single comparison, so flip operator
  for (const [op, inverse] of Object.entries(INVERSE_OP)) {
    if (op in cond) {
      return { [inverse]: (cond as Record<string, unknown>)[op] } as MtpCondition;
    }
  }

  // De Morgan's: all -> any with inverted children
  if (cond.all) {
    return { any: cond.all.map(invertCondition) };
  }

  // De Morgan's: any -> all with inverted children
  if (cond.any) {
    return { all: cond.any.map(invertCondition) };
  }

  // Double negation elimination: none -> unwrap
  if (cond.none) {
    if (cond.none.length === 1) return cond.none[0]!;
    // none: [X, Y] = NOT(X) AND NOT(Y) -> inverted = X OR Y
    return { any: cond.none };
  }

  // Fallback (shouldn't be reachable with well-formed conditions)
  return { none: [cond] };
}

// --- Bare truthy --------------------------------------------------------------

function truthyCondition(
  expr: Expr,
  ctx: BlockEmitContext,
): ConditionResult {
  const simple = exprToValue(expr, ctx);

  if (simple !== null) {
    return { prereqs: [], condition: { neq: [simple, 0] } };
  }

  // Complex expression — pre-evaluate to a temp, then check neq 0
  const prereqs: MtpAction[] = [];
  const val = resolveArg(expr, ctx, prereqs, false);

  return { prereqs, condition: { neq: [val, 0] } };
}

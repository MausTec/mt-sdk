/**
 * JavaScript-side expression evaluator for test contexts.
 *
 * Evaluates MTP `Expr` nodes to `RuntimeValue`s without invoking the WASM
 * runtime. Used for mock return bodies, emit/call arguments, assert
 * conditions, expect `with` arguments, and global assignment values.
 *
 * Only a subset of `Expr` kinds is meaningful in a test evaluation context.
 * Unsupported nodes (Pipe, Call, Accumulator, ErrorCode) throw `EvalError`.
 */

import type { BinaryOp, Expr } from "../ast.js";
import type { RuntimeValue, ValueType } from "../../runtime/types.js";

// --- Eval environment --------------------------------------------------------

/**
 * Provides external state lookups to the evaluator.
 * All accessors are optional; omit those not available in the calling context.
 */
export interface EvalEnv {
  /** Bound local names, e.g. mock parameter bindings at call time. */
  locals?: Map<string, RuntimeValue>;
  /** Read a plugin global variable by name (without `$`). */
  getGlobal?: (name: string) => RuntimeValue | undefined;
  /** Read a plugin config field by name. */
  getConfig?: (name: string) => RuntimeValue | undefined;
  /**
   * Read the accumulator value from the most recent `call` or `emit` step in the enclosing step list. 
   * Returns `undefined` when no such step has executed yet. When this accessor is
   * absent from the environment, `result` evaluation falls through to ordinary local
   * lookup (e.g. mock bodies do not see SUT results).
   */
  getResult?: () => RuntimeValue | undefined;
}

// --- Error -------------------------------------------------------------------

export class EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalError";
  }
}

// --- Trace -------------------------------------------------------------------

/**
 * Result of `evalExprTraced`. Mirrors the evaluated AST so callers can
 * inspect the value at every sub-expression without re-evaluating. Used by
 * the assert failure formatter to print operand breakdowns.
 *
 * `children` is empty for leaves (literals, identifiers, globals, etc.) and
 * holds one entry per evaluated child for composites (Binary/Unary).
 */
export interface EvalTrace {
  expr: Expr;
  value: RuntimeValue;
  children: EvalTrace[];
}

// --- Public API --------------------------------------------------------------

/**
 * Evaluate `expr` in the given environment and return the result value plus
 * a trace mirroring the evaluated sub-tree.
 *
 * Throws `EvalError` for unsupported expression kinds or missing bindings.
 */
export function evalExprTraced(expr: Expr, env: EvalEnv = {}): EvalTrace {
  switch (expr.kind) {
    case "Literal":
      return {
        expr,
        value: { type: varTypeToValueType(expr.varType), value: expr.value },
        children: [],
      };

    case "Identifier": {
      // `result` is a reserved magic identifier in test step contexts: it
      // returns the accumulator from the most recent `call` or `emit`. It is
      // only recognised when the environment provides a `getResult` accessor
      // (i.e. inside step lists), so mock bodies and other non-step contexts
      // can still use `result` as an ordinary identifier if ever needed.
      if (expr.name === "result" && env.getResult !== undefined) {
        const v = env.getResult();

        if (v === undefined) {
          throw new EvalError(
            "`result` is only valid after a `call` or `emit` in the same step list",
          );
        }

        return { expr, value: v, children: [] };
      }

      const v = env.locals?.get(expr.name);

      if (v === undefined) {
        throw new EvalError(`Undefined identifier '${expr.name}' in test expression`);
      }

      return { expr, value: v, children: [] };
    }

    case "GlobalVar": {
      const v = env.getGlobal?.(expr.name);

      if (v === undefined) {
        // TODO: Document more resolution for this but keep the error brief, or add a second arg to EvalError for help:
        // The runtime returned no value. Verify the variable is declared in the plugin's "variables" block (the name must match exactly,
        // without the leading '$'), and that the plugin has fired at least one event so any pre-test setup has had a chance to assign it.
        throw new EvalError(
          `$${expr.name}: plugin global variable could not be read.`
        );
      }

      return { expr, value: v, children: [] };
    }

    case "ConfigRef": {
      const v = env.getConfig?.(expr.name);

      if (v === undefined) {
        throw new EvalError(
          `config.${expr.name} is not readable in this evaluation context`,
        );
      }

      return { expr, value: v, children: [] };
    }

    case "Unary": {
      const operand = evalExprTraced(expr.operand, env);

      if (expr.op === "-") {
        if (operand.value.type !== "int" && operand.value.type !== "float") {
          throw new EvalError(
            `Unary '-' requires a numeric operand, got '${operand.value.type}'`,
          );
        }

        return {
          expr,
          value: { type: operand.value.type, value: -(operand.value.value as number) },
          children: [operand],
        };
      }

      if (expr.op === "not") {
        return {
          expr,
          value: { type: "bool", value: !isTruthy(operand.value) },
          children: [operand],
        };
      }

      throw new EvalError(`Unsupported unary operator '${expr.op}'`);
    }

    case "Binary": {
      const left = evalExprTraced(expr.left, env);
      const right = evalExprTraced(expr.right, env);
      
      return {
        expr,
        value: evalBinary(expr.op, left.value, right.value),
        children: [left, right],
      };
    }

    case "Accumulator":
    case "ErrorCode":
    case "MetaRef":
    case "Index":
    case "Call":
    case "Pipe":
      throw new EvalError(
        `Expression kind '${expr.kind}' cannot be evaluated within a test context`,
      );

    default: {
      const _exhaustive: never = expr;
      void _exhaustive;
      throw new EvalError(`Unknown expression kind`);
    }
  }
}

/**
 * Evaluate `expr` and return just the resulting `RuntimeValue`.
 * Equivalent to `evalExprTraced(expr, env).value` without retaining the trace.
 */
export function evalExpr(expr: Expr, env: EvalEnv = {}): RuntimeValue {
  return evalExprTraced(expr, env).value;
}

/**
 * Evaluate a list of expressions. Convenience wrapper for emit/call argument lists.
 */
export function evalArgs(exprs: Expr[], env: EvalEnv = {}): RuntimeValue[] {
  return exprs.map((e) => evalExpr(e, env));
}

/**
 * Check whether two `RuntimeValue`s are equal for `expect ... with` argument matching.
 * Values of different types are never equal.
 */
export function runtimeValuesEqual(a: RuntimeValue, b: RuntimeValue): boolean {
  return a.type === b.type && a.value === b.value;
}

// --- Helpers -----------------------------------------------------------------

function varTypeToValueType(varType: string): ValueType {
  switch (varType) {
    case "int":    return "int";
    case "float":  return "float";
    case "bool":   return "bool";
    case "string": return "string";
    default:       return "int";
  }
}

function isTruthy(v: RuntimeValue): boolean {
  switch (v.type) {
    case "bool":   return v.value as boolean;
    case "int":
    case "float":  return (v.value as number) !== 0;
    case "string": return (v.value as string).length > 0;
    case "bytes":  return false;
  }
}

function evalBinary(op: BinaryOp, left: RuntimeValue, right: RuntimeValue): RuntimeValue {
  // Arithmetic
  if (op === "+" || op === "-" || op === "*" || op === "/") {
    const l = left.value as number;
    const r = right.value as number;
    const isFloat = left.type === "float" || right.type === "float";
    let result: number;

    switch (op) {
      case "+": result = l + r; break;
      case "-": result = l - r; break;
      case "*": result = l * r; break;
      case "/": result = r === 0 ? 0 : (isFloat ? l / r : Math.trunc(l / r)); break;
    }

    return { type: isFloat ? "float" : "int", value: isFloat ? result! : Math.trunc(result!) };
  }

  // String concatenation
  if (op === "<>") {
    return { type: "string", value: String(left.value) + String(right.value) };
  }

  // Comparison operators
  if (op === "==" || op === "!=" || op === ">=" || op === "<=" || op === ">" || op === "<") {
    const l = left.value;
    const r = right.value;
    let result: boolean;

    switch (op) {
      case "==": result = l === r; break;
      case "!=": result = l !== r; break;
      case ">=": result = (l as number) >= (r as number); break;
      case "<=": result = (l as number) <= (r as number); break;
      case ">":  result = (l as number) >  (r as number); break;
      case "<":  result = (l as number) <  (r as number); break;
    }
    
    return { type: "bool", value: result! };
  }

  // Logical
  if (op === "and") return { type: "bool", value: isTruthy(left) && isTruthy(right) };
  if (op === "or")  return { type: "bool", value: isTruthy(left) || isTruthy(right) };

  throw new EvalError(`Unsupported binary operator '${op}'`);
}

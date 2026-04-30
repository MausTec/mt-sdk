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
}

// --- Error -------------------------------------------------------------------

export class EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalError";
  }
}

// --- Public API --------------------------------------------------------------

/**
 * Evaluate `expr` in the given environment and return a `RuntimeValue`.
 * Throws `EvalError` for unsupported expression kinds or missing bindings.
 */
export function evalExpr(expr: Expr, env: EvalEnv = {}): RuntimeValue {
  switch (expr.kind) {
    case "Literal":
      return { type: varTypeToValueType(expr.varType), value: expr.value };

    case "Identifier": {
      const v = env.locals?.get(expr.name);

      if (v === undefined) {
        throw new EvalError(`Undefined identifier '${expr.name}' in test expression`);
      }

      return v;
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

      return v;
    }

    case "ConfigRef": {
      const v = env.getConfig?.(expr.name);

      if (v === undefined) {
        throw new EvalError(
          `config.${expr.name} is not readable in this evaluation context`,
        );
      }

      return v;
    }

    case "Unary": {
      const operand = evalExpr(expr.operand, env);

      if (expr.op === "-") {
        if (operand.type !== "int" && operand.type !== "float") {
          throw new EvalError(
            `Unary '-' requires a numeric operand, got '${operand.type}'`,
          );
        }

        return { type: operand.type, value: -(operand.value as number) };
      }

      if (expr.op === "not") {
        return { type: "bool", value: !isTruthy(operand) };
      }

      throw new EvalError(`Unsupported unary operator '${expr.op}'`);
    }

    case "Binary": {
      const left = evalExpr(expr.left, env);
      const right = evalExpr(expr.right, env);
      return evalBinary(expr.op, left, right);
    }

    case "Accumulator":
    case "ErrorCode":
    case "MetaRef":
    case "Index":
    case "Call":
    case "Pipe":
      throw new EvalError(
        `Expression kind '${expr.kind}' cannot be evaluated outside of a running plugin`,
      );

    default: {
      const _exhaustive: never = expr;
      void _exhaustive;
      throw new EvalError(`Unknown expression kind`);
    }
  }
}

/**
 * Evaluate a list of expressions. Convenience wrapper for emit/call argument lists.
 */
export function evalArgs(exprs: Expr[], env: EvalEnv = {}): RuntimeValue[] {
  return exprs.map((e) => evalExpr(e, env));
}

/**
 * Coerce a `RuntimeValue` to a single integer for `runtime.fireEvent`.
 * Floats are truncated; bools become 1/0; strings are not valid event args
 * and throw.
 * 
 * TODO: In the future, event arguments may be typed and allow strings or other types
 */
export function toEventArg(v: RuntimeValue): number {
  switch (v.type) {
    case "int":   return v.value as number;
    case "float": return Math.trunc(v.value as number);
    case "bool":  return (v.value as boolean) ? 1 : 0;
    case "string":
    case "bytes":
      throw new EvalError(
        `Cannot coerce ${v.type} value to an event argument integer`,
      );
  }
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

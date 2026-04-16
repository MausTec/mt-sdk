import type { Stmt } from "../ast.js";
import type { MtpAction, MtpActionObject, MtpConditional } from "../../core/mtp-types.js";
import type { BlockEmitContext } from "./context.js";
import { exprToValue, exprToActions, resolveArg } from "./expressions.js";
import { exprToCondition, invertCondition } from "./conditions.js";
import type { LocalDeclStmt, AssignIndexStmt, CompoundAssignStmt, ReturnStmt, IfStmt, WhileStmt, ConditionalStmt, Expr } from "../ast.js";

/**
 * Compile a statement list into mt-actions action objects.
 *
 * Iterates each statement, compiles it, calls `ctx.resetTemps()`
 * between statements so temp variable slots are recycled.
 */
export function emitStatements(
  stmts: Stmt[],
  ctx: BlockEmitContext,
): MtpAction[] {
  const actions: MtpAction[] = [];

  for (const stmt of stmts) {
    actions.push(...emitStatement(stmt, ctx));
    ctx.resetTemps();
  }

  return actions;
}

/** Compile a single statement. */
function emitStatement(stmt: Stmt, ctx: BlockEmitContext): MtpAction[] {
  switch (stmt.kind) {
    case "LocalDecl":
      return emitLocalDecl(stmt, ctx);
    case "AssignLocal":
      return emitAssign(`$${stmt.name}`, stmt.value, ctx);
    case "AssignGlobal":
      return emitAssign(`$${stmt.name}`, stmt.value, ctx);
    case "AssignIndex":
      return emitAssignIndex(stmt, ctx);
    case "CompoundAssign":
      return emitCompoundAssign(stmt, ctx);
    case "ExprStmt":
      return exprToActions(stmt.expr, ctx);
    case "Return":
      return emitReturn(stmt, ctx);
    case "If":
      return emitIf(stmt, ctx);
    case "While":
      return emitWhile(stmt, ctx);
    case "Conditional":
      return emitConditional(stmt, ctx);
  }
}

// --- LocalDecl ----------------------------------------------------------------

/**
 * Local declarations: the variable itself is registered in the function's
 * `vars` list by `extractLocals()` in the plugin/function emitter.
 * Here we only emit the initializer assignment, if present.
 */
function emitLocalDecl(stmt: LocalDeclStmt, ctx: BlockEmitContext): MtpAction[] {
  if (stmt.init === null || stmt.arraySize !== null) return [];
  return emitAssign(`$${stmt.name}`, stmt.init, ctx);
}

// --- Assignment (shared by LocalDecl, AssignLocal, AssignGlobal) --------------

/**
 * Assign `expr` to `target` (a `$`-prefixed variable name).
 *
 * - Simple value -> `{ "set": { "$name": value } }`
 * - Complex expression -> `exprToActions(expr, target)` which puts
 *   `to: "$name"` on the final action
 */
function emitAssign(target: string, expr: Expr, ctx: BlockEmitContext): MtpAction[] {
  const simple = exprToValue(expr, ctx);

  if (simple !== null) {
    const obj = Object.create(null) as MtpActionObject;
    obj.set = { [target]: simple };
    return [obj];
  }

  return exprToActions(expr, ctx, target);
}

// --- AssignIndex (setbyte) ----------------------------------------------------

/**
 * Index assignment: `target[index] = value` -> `{ "setbyte": [array, index, value] }`
 *
 * All three operands are resolved to values, with complex sub-expressions
 * pre-evaluated to temps.
 */
function emitAssignIndex(stmt: AssignIndexStmt, ctx: BlockEmitContext): MtpAction[] {
  const prereqs: MtpAction[] = [];
  const arrayVal = resolveArg(stmt.target, ctx, prereqs, false);
  const indexVal = resolveArg(stmt.index, ctx, prereqs, false);
  const valueVal = resolveArg(stmt.value, ctx, prereqs, !ctx.accumulatorReserved);

  const obj = Object.create(null) as MtpActionObject;
  obj.setbyte = [arrayVal, indexVal, valueVal];
  return [...prereqs, obj];
}

// --- CompoundAssign (+=, -=, *=, /=) ------------------------------------------

const COMPOUND_OP_TO_BINARY: Record<string, string> = {
  "+=": "add",
  "-=": "sub",
  "*=": "mul",
  "/=": "div",
};

function emitCompoundAssign(stmt: CompoundAssignStmt, ctx: BlockEmitContext): MtpAction[] {
  const target = `$${stmt.target}`;

  // Optimize: `x += 1` -> `{ inc: "$x" }`, `x -= 1` -> `{ dec: "$x" }`
  const simple = exprToValue(stmt.value, ctx);
  if (simple === 1) {
    if (stmt.op === "+=") {
      const obj = Object.create(null) as MtpActionObject;
      obj.inc = target;
      return [obj];
    }
    if (stmt.op === "-=") {
      const obj = Object.create(null) as MtpActionObject;
      obj.dec = target;
      return [obj];
    }
  }

  // General case: desugar to binary op + assignment
  // `x += expr` -> `{ "add": [target, value], "to": target }`
  const prereqs: MtpAction[] = [];
  const valueArg = resolveArg(stmt.value, ctx, prereqs, !ctx.accumulatorReserved);
  const runtimeOp = COMPOUND_OP_TO_BINARY[stmt.op]!;

  const obj = Object.create(null) as MtpActionObject;
  obj[runtimeOp] = [target, valueArg];
  obj.to = target;
  return [...prereqs, obj];
}

// --- Return -------------------------------------------------------------------

function emitReturn(stmt: ReturnStmt, ctx: BlockEmitContext): MtpAction[] {
  if (stmt.value === null) {
    const obj = Object.create(null) as MtpActionObject;
    obj.return = 0;
    return [obj];
  }

  const simple = exprToValue(stmt.value, ctx);
  if (simple !== null) {
    const obj = Object.create(null) as MtpActionObject;
    obj.return = simple;
    return [obj];
  }

  // Complex return: emit actions flowing to $_, then return $_
  const actions = exprToActions(stmt.value, ctx);
  const ret = Object.create(null) as MtpActionObject;
  ret.return = "$_";
  return [...actions, ret];
}

// --- While / Until (block form) -----------------------------------------------

function emitWhile(stmt: WhileStmt, ctx: BlockEmitContext): MtpAction[] {
  const result = exprToCondition(stmt.condition, ctx);
  if (result === null) {
    ctx.error("Could not compile while condition", stmt.condition.span);
    return [];
  }

  const bodyActions = emitStatements(stmt.body, ctx);

  let predicate: MtpConditional;
  if (stmt.guard === "until") {
    predicate = { ...invertCondition(result.condition), then: bodyActions };
  } else {
    predicate = { ...result.condition, then: bodyActions };
  }

  const obj = Object.create(null) as MtpActionObject;
  obj.while = predicate;
  return [...result.prereqs, obj];
}

// --- If / Unless (block form) -------------------------------------------------

// TODO: Similar to emitWhile, this should handle accepting "unless" as a top-level conditional.

function emitIf(stmt: IfStmt, ctx: BlockEmitContext): MtpAction[] {
  const result = exprToCondition(stmt.condition, ctx);
  if (result === null) {
    ctx.error("Could not compile if-condition", stmt.condition.span);
    return [];
  }

  const thenActions = emitStatements(stmt.then, ctx);

  let predicate: MtpConditional;
  if (stmt.guard === "unless") {
    predicate = { ...invertCondition(result.condition), then: thenActions };
  } else {
    predicate = { ...result.condition, then: thenActions };
  }

  if (stmt.else !== null && stmt.else.length > 0) {
    predicate.else = emitStatements(stmt.else, ctx);
  }

  const obj = Object.create(null) as MtpActionObject;
  obj.if = predicate;
  return [...result.prereqs, obj];
}

// --- Conditional (postfix `stmt if/unless/while/until cond`) ------------------

function emitConditional(stmt: ConditionalStmt, ctx: BlockEmitContext): MtpAction[] {
  const result = exprToCondition(stmt.condition, ctx);
  if (result === null) {
    ctx.error("Could not compile conditional guard", stmt.condition.span);
    return [];
  }

  const bodyActions = emitStatement(stmt.body, ctx);

  let predicate: MtpConditional;
  if (stmt.guard === "unless" || stmt.guard === "until") {
    predicate = { ...invertCondition(result.condition), then: bodyActions };
  } else {
    predicate = { ...result.condition, then: bodyActions };
  }

  // Postfix while/until wraps in a `while` action; if/unless wraps in `if`
  const wrapKey = (stmt.guard === "while" || stmt.guard === "until") ? "while" : "if";

  const obj = Object.create(null) as MtpActionObject;
  obj[wrapKey] = predicate;
  return [...result.prereqs, obj];
}

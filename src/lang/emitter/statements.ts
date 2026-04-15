import type { Stmt } from "../ast.js";
import type { MtpAction, MtpActionObject, MtpConditional } from "../../core/mtp-types.js";
import type { BlockEmitContext } from "./context.js";
import { exprToValue, exprToActions } from "./expressions.js";
import { exprToCondition } from "./conditions.js";
import type { LocalDeclStmt, ReturnStmt, IfStmt, ConditionalStmt, Expr } from "../ast.js";

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
    case "ExprStmt":
      return exprToActions(stmt.expr, ctx);
    case "Return":
      return emitReturn(stmt, ctx);
    case "If":
      return emitIf(stmt, ctx);
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

// --- If / Unless (block form) -------------------------------------------------

// TODO: Both of these feel like duplicates, and the "if" block emitter should also
// work for top-level "unless", but I don't think that has been introduced to MTP yet.
// Note that the conditional predicate should be "any", "all", "none" for "or", "and", and "not"

function emitIf(stmt: IfStmt, ctx: BlockEmitContext): MtpAction[] {
  const condition = exprToCondition(stmt.condition, ctx);
  if (condition === null) {
    ctx.error("Could not compile if-condition", stmt.condition.span);
    return [];
  }

  const thenActions = emitStatements(stmt.then, ctx);
  const conditional: MtpConditional = { ...condition, then: thenActions };

  if (stmt.else !== null && stmt.else.length > 0) {
    conditional.else = emitStatements(stmt.else, ctx);
  }

  const obj = Object.create(null) as MtpActionObject;
  obj.if = conditional;
  return [obj];
}

// --- Conditional (postfix `stmt if cond` / `stmt unless cond`) ----------------

function emitConditional(stmt: ConditionalStmt, ctx: BlockEmitContext): MtpAction[] {
  const condition = exprToCondition(stmt.condition, ctx);
  if (condition === null) {
    ctx.error("Could not compile conditional guard", stmt.condition.span);
    return [];
  }

  const bodyActions = emitStatement(stmt.body, ctx);

  let predicate: MtpConditional;
  if (stmt.guard === "unless") {
    predicate = { none: [condition], then: bodyActions };
  } else {
    predicate = { ...condition, then: bodyActions };
  }

  const obj = Object.create(null) as MtpActionObject;
  obj.if = predicate;
  return [obj];
}

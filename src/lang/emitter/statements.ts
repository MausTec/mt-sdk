import type { Stmt } from "../ast.js";
import type { MtpAction, MtpActionObject, MtpConditional } from "../../core/mtp-types.js";
import type { BlockEmitContext } from "./context.js";
import { exprToValue, exprToActions, resolveArg } from "./expressions.js";
import { exprToCondition, invertCondition } from "./conditions.js";
import type { LocalDeclStmt, AssignIndexStmt, CompoundAssignStmt, ReturnStmt, IfStmt, WhileStmt, ForStmt, ForIterable, ConditionalStmt, Expr } from "../ast.js";
import { isLiteral } from "./functions.js";

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
    case "For":
      return emitFor(stmt, ctx);
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

// --- For-in loop --------------------------------------------------------------

function emitFor(stmt: ForStmt, ctx: BlockEmitContext): MtpAction[] {
  const target = `$${stmt.variable}`;

  if (stmt.iterable.kind === "Range") {
    return emitForRange(stmt, target, stmt.iterable, ctx);
  }

  // Variable iterable — resolve type from context
  const varInfo = ctx.variables.get(stmt.iterable.name);
  if (!varInfo) {
    ctx.error(
      `Unknown variable \`${stmt.iterable.name}\` in for-loop iterable`,
      stmt.iterable.span,
    );
    return [];
  }

  if (varInfo.varType === "int" && varInfo.arraySize !== null) {
    return emitForArray(stmt, target, stmt.iterable, varInfo.arraySize, ctx);
  }

  if (varInfo.varType === "string") {
    return emitForString(stmt, target, stmt.iterable, ctx);
  }

  ctx.error(
    `Cannot iterate over \`${stmt.iterable.name}\`: expected a byte array or string, got ${varInfo.varType}`,
    stmt.iterable.span,
  );
  return [];
}

/**
 * Emit `for i in start..end do body end`.
 *
 * Static ranges (both bounds are literals) determine direction at compile time.
 * Dynamic ranges emit a runtime direction check.
 *
 * Range is inclusive: `for i in 1..5` iterates 1, 2, 3, 4, 5.
 */
function emitForRange(
  stmt: ForStmt,
  target: string,
  range: Extract<ForIterable, { kind: "Range" }>,
  ctx: BlockEmitContext,
): MtpAction[] {
  const startVal = exprToValue(range.start, ctx);
  const endVal = exprToValue(range.end, ctx);

  if (startVal === null || endVal === null) {
    ctx.error("Could not compile range bounds", stmt.span);
    return [];
  }

  const bodyActions = emitStatements(stmt.body, ctx);

  // Static direction: both bounds are literal numbers
  if (typeof startVal === "number" && typeof endVal === "number") {
    const forward = startVal <= endVal;

    const initObj = Object.create(null) as MtpActionObject;
    initObj.set = { [target]: startVal };

    const whileObj = Object.create(null) as MtpActionObject;
    const stepObj = Object.create(null) as MtpActionObject;

    if (forward) {
      stepObj.inc = target;
      whileObj.while = { lte: [target, endVal], then: [...bodyActions, stepObj] };
    } else {
      stepObj.dec = target;
      whileObj.while = { gte: [target, endVal], then: [...bodyActions, stepObj] };
    }

    return [initObj, whileObj];
  }

  // Dynamic direction: emit runtime check
  const initObj = Object.create(null) as MtpActionObject;
  initObj.set = { [target]: startVal };

  const fwdStep = Object.create(null) as MtpActionObject;
  fwdStep.inc = target;
  const fwdWhile = Object.create(null) as MtpActionObject;
  fwdWhile.while = { lte: [target, endVal], then: [...bodyActions, fwdStep] };

  const revStep = Object.create(null) as MtpActionObject;
  revStep.dec = target;
  const revWhile = Object.create(null) as MtpActionObject;
  revWhile.while = { gte: [target, endVal], then: [...bodyActions, revStep] };

  const ifObj = Object.create(null) as MtpActionObject;
  ifObj.if = { lte: [startVal, endVal], then: [fwdWhile], else: [revWhile] };

  return [initObj, ifObj];
}

/**
 * Emit `for val in $arr do body end` — iterate byte array via getbyte.
 *
 * Emits:
 *   set { $__tN: 0 }
 *   while { lt: [$__tN, arraySize], then: [
 *     getbyte: [$arr, $__tN], to: $val
 *     ...body
 *     inc: $__tN
 *   ]}
 */
function emitForArray(
  stmt: ForStmt,
  target: string,
  iterable: Extract<ForIterable, { kind: "Variable" }>,
  arraySize: number,
  ctx: BlockEmitContext,
): MtpAction[] {
  const idxTemp = ctx.allocTemp();
  const arrRef = `$${iterable.name}`;

  const bodyActions = emitStatements(stmt.body, ctx);

  const initObj = Object.create(null) as MtpActionObject;
  initObj.set = { [idxTemp]: 0 };

  const getObj = Object.create(null) as MtpActionObject;
  getObj.getbyte = [arrRef, idxTemp];
  getObj.to = target;

  const stepObj = Object.create(null) as MtpActionObject;
  stepObj.inc = idxTemp;

  const whileObj = Object.create(null) as MtpActionObject;
  whileObj.while = { lt: [idxTemp, arraySize], then: [getObj, ...bodyActions, stepObj] };

  return [initObj, whileObj];
}

/**
 * Emit `for ch in $str do body end` — iterate string characters via charat/strlen.
 *
 * Emits:
 *   strlen: $str, to: $__tN
 *   set { $__tM: 0 }
 *   while { lt: [$__tM, $__tN], then: [
 *     charat: [$str, $__tM], to: $ch
 *     ...body
 *     inc: $__tM
 *   ]}
 */
function emitForString(
  stmt: ForStmt,
  target: string,
  iterable: Extract<ForIterable, { kind: "Variable" }>,
  ctx: BlockEmitContext,
): MtpAction[] {
  const lenTemp = ctx.allocTemp();
  const idxTemp = ctx.allocTemp();
  const strRef = `$${iterable.name}`;

  const bodyActions = emitStatements(stmt.body, ctx);

  const lenObj = Object.create(null) as MtpActionObject;
  lenObj.strlen = strRef;
  lenObj.to = lenTemp;

  const initObj = Object.create(null) as MtpActionObject;
  initObj.set = { [idxTemp]: 0 };

  const charObj = Object.create(null) as MtpActionObject;
  charObj.charat = [strRef, idxTemp];
  charObj.to = target;

  const stepObj = Object.create(null) as MtpActionObject;
  stepObj.inc = idxTemp;

  const whileObj = Object.create(null) as MtpActionObject;
  whileObj.while = { lt: [idxTemp, lenTemp], then: [charObj, ...bodyActions, stepObj] };

  return [lenObj, initObj, whileObj];
}

// --- If / Unless (block form) -------------------------------------------------

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

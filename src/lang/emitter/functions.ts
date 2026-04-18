/**
 * Function and event-handler emitters.
 *
 * Handles `def`, `fn`, and `on` blocks, extracting local variable names,
 * and producing the JSON function-definition objects.
 * Delegates to the statement and expression emitters for body compilation.
 */

import type {
  DefNode,
  Expr,
  GlobalDecl,
  FnNode,
  LocalDeclStmt,
  OnNode,
  PluginNode,
  Stmt,
} from "../ast.js";
import type {
  MtpAction,
  MtpActionObject,
  MtpFunctionDef,
  MtpFunctionDefObject,
  MtpValue,
} from "../../core/mtp-types.js";
import type { EmitContext } from "./context.js";
import { BlockEmitContext } from "./context.js";
import type { EmitVarInfo } from "./context.js";
import { emitStatements } from "./statements.js";
import { exprToValue, exprToActions } from "./expressions.js";

// --- Helpers ------------------------------------------------------------------

/** @deprecated Import `isLiteral` from `../ast.js` instead. Re-exported for compatibility. */
export { isLiteral } from "../ast.js";


/**
 * Convert a simple expression to a JSON-serializable value.
 * Only handles Literal and Identifier — all other kinds return null.
 * This will be replaced by `exprToValue()` in expressions.ts once
 * full expression compilation is implemented.
 */
export function exprToJson(expr: Expr): MtpValue | null {
  switch (expr.kind) {
    case "Literal":
      return expr.value;
    case "Identifier":
      return expr.name;
    default:
      return null;
  }
}

// --- Types --------------------------------------------------------------------

/**
 * Extended function definition that includes SDK-only metadata
 * not consumed by the runtime (e.g. returnType for tooling).
 * FUTURE (Phase K): Consolidate returnType annotation once doc format is
 * decided for redistributable MT JSON code.
 */
export type EmittedFunctionDef = MtpFunctionDefObject & { returnType?: string };

// --- Local extraction ---------------------------------------------------------

/**
 * Collect `LocalDeclStmt` nodes from a block body, returning a flat array of
 * local variable names (for scope allocation in the function definition).
 */
export function extractLocals(body: Stmt[]): string[] {
  const decls = body.filter(
    (s): s is LocalDeclStmt => s.kind === "LocalDecl",
  );

  return decls.map((d) =>
    d.arraySize !== null ? `${d.name}[${d.arraySize}]` : d.name,
  );
}

/**
 * Build a variable info map from the function body's local declarations,
 * function parameters, and the plugin's global declarations.
 */
function buildVarInfoMap(
  body: Stmt[],
  params?: { name: string; varType: string }[],
  globals?: GlobalDecl[],
): Map<string, EmitVarInfo> {
  const vars = new Map<string, EmitVarInfo>();

  if (globals) {
    for (const g of globals) {
      vars.set(g.name, { varType: g.varType, arraySize: g.arraySize ?? null });
    }
  }

  if (params) {
    for (const p of params) {
      vars.set(p.name, { varType: p.varType as "int" | "bool" | "string", arraySize: null });
    }
  }

  for (const stmt of body) {
    if (stmt.kind === "LocalDecl") {
      vars.set(stmt.name, { varType: stmt.varType, arraySize: stmt.arraySize });
    }
  }

  return vars;
}

// --- Local function scope -----------------------------------------------------

/**
 * Scan all `def` and `fn` nodes in a plugin to build a map of
 * local function name -> parameter names. Used by the Call emitter
 * to distinguish local calls (`@`-prefixed) from host calls.
 */
export function buildLocalFunctionScope(ast: PluginNode): Map<string, string[]> {
  const scope = new Map<string, string[]>();

  for (const def of ast.defs) {
    scope.set(def.name, def.params.map((p) => p.name));
  }

  for (const fn of ast.functions) {
    scope.set(fn.name, fn.params.map((p) => p.name));
  }

  return scope;
}

// --- Function emitters --------------------------------------------------------

/**
 * Emits a `def` block — multi-statement function.
 * Extracts locals for the vars list, then delegates body to the statement emitter.
 */
export function emitDef(
  ctx: EmitContext,
  def: DefNode,
  localFunctions?: Map<string, string[]>,
  globals?: GlobalDecl[],
): EmittedFunctionDef {
  const varInfo = buildVarInfoMap(def.body, def.params, globals);
  const blockCtx = new BlockEmitContext(localFunctions, varInfo);
  const vars = extractLocals(def.body);
  const actions = emitStatements(def.body, blockCtx);

  ctx.diagnostics.push(...blockCtx.diagnostics);

  const result: EmittedFunctionDef = {
    args: def.params.map((p) => p.name),
    vars: [...vars, ...blockCtx.getTempVars()],
    actions,
  };

  if (def.returnType !== null) {
    result.returnType = def.returnType;
  }

  return result;
}

/**
 * Emits a `fn` — pure single-expression function.
 * The body expression is compiled and wrapped in an implicit return.
 */
export function emitFn(
  ctx: EmitContext,
  fn: FnNode,
  localFunctions?: Map<string, string[]>,
): EmittedFunctionDef {
  const blockCtx = new BlockEmitContext(localFunctions);

  const simple = exprToValue(fn.body, blockCtx);
  let actions: MtpAction[];

  if (simple !== null) {
    const ret = Object.create(null) as MtpActionObject;
    ret.return = simple;
    actions = [ret];
  } else {
    const exprActions = exprToActions(fn.body, blockCtx);
    const ret = Object.create(null) as MtpActionObject;
    ret.return = "$_";
    actions = [...exprActions, ret];
  }

  ctx.diagnostics.push(...blockCtx.diagnostics);

  const result: EmittedFunctionDef = {
    args: fn.params.map((p) => p.name),
    actions,
  };

  const tempVars = blockCtx.getTempVars();
  if (tempVars.length > 0) {
    result.vars = tempVars;
  }

  if (fn.returnType !== null) {
    result.returnType = fn.returnType;
  }

  return result;
}

// --- Handler emitters ---------------------------------------------------------

/**
 * Emits an `on :event` handler.
 *
 * If the handler has `with` bindings, they are emitted as `args` in the
 * function definition.
 * The runtime maps positional event payload values to these argument names.
 */
export function emitOnNode(
  ctx: EmitContext,
  handler: OnNode,
  localFunctions?: Map<string, string[]>,
  globals?: GlobalDecl[],
): MtpFunctionDefObject {
  // Convert event bindings to DefParam-shaped objects for scope resolution.
  // Bindings are untyped in source — we default to "int" for scope registration
  // since the runtime passes all event args as integer values. The linker
  // (Phase H) will validate types against the SDK event spec.
  const bindingParams = handler.bindings.map((b) => ({
    name: b.name,
    varType: "int" as const,
  }));

  const varInfo = buildVarInfoMap(handler.body, bindingParams, globals);
  const blockCtx = new BlockEmitContext(localFunctions, varInfo);
  const vars = extractLocals(handler.body);
  const actions = emitStatements(handler.body, blockCtx);

  ctx.diagnostics.push(...blockCtx.diagnostics);

  const result: MtpFunctionDefObject = {
    vars: [...vars, ...blockCtx.getTempVars()],
    actions,
  };

  if (handler.bindings.length > 0) {
    result.args = handler.bindings.map((b) => b.name);
  }

  return result;
}

/**
 * Emit all event handlers, keyed by event name.
 * Reports a diagnostic if the same event is handled more than once.
 */
export function emitHandlers(
  ctx: EmitContext,
  handlers: OnNode[],
  localFunctions?: Map<string, string[]>,
  globals?: GlobalDecl[],
): Record<string, MtpFunctionDef> {
  const events: Record<string, MtpFunctionDef> = {};

  for (const handler of handlers) {
    if (!events[handler.event]) {
      events[handler.event] = emitOnNode(ctx, handler, localFunctions, globals);
    } else {
      ctx.error(
        `Multiple handlers defined for event "${handler.event}"`,
        handler.eventSpan,
      );
    }
  }

  return events;
}

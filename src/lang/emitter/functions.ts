/**
 * Function and event-handler emitters.
 *
 * Handles `def`, `fn`, and `on` blocks — extracting local declarations,
 * building init actions, and producing the JSON function-definition objects.
 * Delegates to the statement and expression emitters once those are implemented.
 */

import type {
  DefNode,
  Expr,
  LiteralExpr,
  FnNode,
  LocalDeclStmt,
  OnNode,
  Stmt,
} from "../ast.js";
import type {
  MtpActionObject,
  MtpFunctionDef,
  MtpFunctionDefObject,
  MtpValue,
} from "../../core/mtp-types.js";
import type { EmitContext } from "./context.js";

// --- Helpers ------------------------------------------------------------------

/**
 * Type guard for Literal type expressions
 * TODO: Move this to ast.js
 */
export function isLiteral(expr: Expr): expr is LiteralExpr {
  return expr.kind === "Literal";
}


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
 * TODO: Consolidate the returnType annotation once we decide how docs are going to work for
 * redistributable MT JSON code.
 */
export type EmittedFunctionDef = MtpFunctionDefObject & { returnType?: string };

// --- Local extraction ---------------------------------------------------------

/**
 * Collect `LocalDeclStmt` nodes from a block body, returning:
 * - `vars`: flat array of local variable names (for scope allocation)
 * - `initActions`: `set` actions for any declarations that carry an initial value
 */
export function extractLocals(body: Stmt[]): {
  vars: string[];
  initActions: MtpActionObject[];
} {
  const decls = body.filter(
    (s): s is LocalDeclStmt => s.kind === "LocalDecl",
  );

  const vars = decls.map((d) =>
    d.arraySize !== null ? `${d.name}[${d.arraySize}]` : d.name,
  );

  // TODO: Delegate init-value emission to the set emitter once statement
  // compilation is implemented. The set emitter should accept a batch of
  // assignments so multiple keys can be combined into a single `set` action.
  const initActions = decls
    .filter((d) => d.arraySize === null && d.init !== null)
    .flatMap((d) => {
      const val = exprToJson(d.init!);
      if (val === null) return [];
      return [{ set: { [`$${d.name}`]: val } } as MtpActionObject];
    });

  return { vars, initActions };
}

// --- Function emitters --------------------------------------------------------

/**
 * Emits a `def` block — multi-statement function.
 * Currently only extracts locals; statement compilation is TODO (statements.ts).
 */
export function emitDef(_ctx: EmitContext, def: DefNode): EmittedFunctionDef {
  const { vars, initActions } = extractLocals(def.body);

  const result: EmittedFunctionDef = {
    args: def.params.map((p) => p.name),
    vars,
    actions: initActions,
  };

  if (def.returnType !== null) {
    result.returnType = def.returnType;
  }

  return result;
}

/**
 * Emits a `fn` — pure single-expression function.
 * Expression body compilation is TODO (expressions.ts).
 */
export function emitFn(_ctx: EmitContext, fn: FnNode): EmittedFunctionDef {
  const result: EmittedFunctionDef = {
    args: fn.params.map((p) => p.name),
    actions: [],
  };

  if (fn.returnType !== null) {
    result.returnType = fn.returnType;
  }

  return result;
}

// --- Handler emitters ---------------------------------------------------------

/**
 * Emits an `on :event` handler.
 * Body compilation is TODO (statements.ts).
 */
export function emitOnNode(
  _ctx: EmitContext,
  handler: OnNode,
): MtpFunctionDefObject {
  const { vars, initActions } = extractLocals(handler.body);

  return {
    vars,
    actions: initActions,
  };
}

/**
 * Emit all event handlers, keyed by event name.
 * Reports a diagnostic if the same event is handled more than once.
 */
export function emitHandlers(
  ctx: EmitContext,
  handlers: OnNode[],
): Record<string, MtpFunctionDef> {
  const events: Record<string, MtpFunctionDef> = {};

  for (const handler of handlers) {
    if (!events[handler.event]) {
      events[handler.event] = emitOnNode(ctx, handler);
    } else {
      ctx.error(
        `Multiple handlers defined for event "${handler.event}"`,
      );
    }
  }

  return events;
}

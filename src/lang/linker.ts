import type { Span, LangDiagnostic } from "./diagnostics.js";
import { langError, langWarning } from "./diagnostics.js";
import type {
  PluginNode,
  FnNode,
  DefNode,
  OnNode,
  DefParam,
  Expr,
  Stmt,
} from "./ast.js";
import { SymbolTable, type ResolvedFunction } from "./symbol-table.js";
import type { ApiDescriptor } from "@maustec/mt-runtimes";

// --- Public types ------------------------------------------------------------

/**
 * External context provided to the linker. When omitted, the linker runs in
 * degraded mode: plugin-defined symbols are resolved but builtins and host
 * functions produce "unknown function" warnings rather than errors.
 */
export interface LinkerContext {
  /** mt-actions core builtins descriptor (e.g. from getMtActionsDescriptor()). */
  builtins?: ApiDescriptor;
  /** Per-SKU host function descriptors (one per resolved platform SKU). */
  platformApis?: ApiDescriptor[];
}

/** A usage site for a required permission. */
export interface PermissionUsage {
  permission: string;
  callSite: Span;
  functionName: string;
}

/** Permission analysis results, used in highlighting errors and emitting corrections. */
export interface PermissionAnalysis {
  /** Permissions required by actual function/event usage mapped to call sites. */
  required: Map<string, PermissionUsage[]>;
  /** Permissions declared in @permissions metadata mapped to declaration span. */
  declared: Map<string, Span>;
}

/** Result returned by the linker. */
export interface LinkedResult {
  symbols: SymbolTable;
  diagnostics: LangDiagnostic[];
  permissionAnalysis: PermissionAnalysis;
}

// --- Internal types --------------------------------------------------------

interface BodyContext {
  params: readonly DefParam[];
  stmts: readonly Stmt[];
}

// --- Public entry point ------------------------------------------------------

/**
 * Link a parsed plugin AST: build a symbol table enriched with API descriptors,
 * run validation passes, and collect permission requirements.
 *
 * The linker performs the following tasks:
 * - Validate that all symbols referenced in the plugin (locals, globals, config,
 *   functions, events) are defined either in the plugin itself or in the provided
 *   API descriptors

 * - Builtin + host function resolution from mt-runtimes descriptors
 * - Event name resolution from descriptors (no more hardcoded KNOWN_EVENTS)
 * - Function argument count validation for resolved functions
 * - Permission tracking with missing/unused permission diagnostics
 */
export function link(ast: PluginNode, context?: LinkerContext): LinkedResult {
  const diagnostics: LangDiagnostic[] = [];
  const symbols = SymbolTable.fromAST(ast);

  // --- Register API descriptors ---
  if (context?.builtins) {
    const origin = `${context.builtins.sku}/${context.builtins.version}`;
    symbols.registerDescriptor(context.builtins, "builtin", origin);
  }

  if (context?.platformApis) {
    for (const api of context.platformApis) {
      const origin = `${api.sku}/${api.version}`;
      symbols.registerDescriptor(api, "runtime", origin);
    }
  }

  // --- Permission tracking setup ---
  const requiredPerms = new Map<string, PermissionUsage[]>();
  const declaredPerms = new Map<string, Span>();

  // Extract @permissions from AST metadata
  for (const field of ast.metadata) {
    if (field.key === "permissions" && Array.isArray(field.value)) {
      for (const expr of field.value) {
        if (expr.kind === "Literal" && typeof expr.value === "string") {
          declaredPerms.set(expr.value, expr.span);
        }
      }
    }
  }

  // --- Validation passes ---

  // Config declaration inits + constraints (no local scope)
  if (ast.configBlock !== null) {
    for (const decl of ast.configBlock.declarations) {
      validateExpr(diagnostics, symbols, null, decl.default, false, requiredPerms);
      for (const expr of Object.values(decl.constraints)) {
        validateExpr(diagnostics, symbols, null, expr, false, requiredPerms);
      }
    }
  }

  // Global declaration inits (no local scope)
  if (ast.globalsBlock !== null) {
    for (const decl of ast.globalsBlock.declarations) {
      validateExpr(diagnostics, symbols, null, decl.init, false, requiredPerms);
    }
  }

  // fn expressions
  for (const fn of ast.functions) {
    validateFn(diagnostics, symbols, fn, requiredPerms);
  }

  // def functions
  for (const def of ast.defs) {
    validateDef(diagnostics, symbols, def, requiredPerms);
  }

  // event handlers
  for (const handler of ast.handlers) {
    validateOn(diagnostics, symbols, handler, requiredPerms);
  }

  // --- Permission diagnostics ---
  emitPermissionDiagnostics(diagnostics, requiredPerms, declaredPerms);

  return {
    symbols,
    diagnostics,
    permissionAnalysis: {
      required: requiredPerms,
      declared: declaredPerms,
    },
  };
}

// --- Function/handler validators ---------------------------------------------

function validateFn(
  diags: LangDiagnostic[],
  symbols: SymbolTable,
  fn: FnNode,
  perms: Map<string, PermissionUsage[]>,
): void {
  validateExpr(diags, symbols, { params: fn.params, stmts: [] }, fn.body, false, perms);
}

function validateDef(
  diags: LangDiagnostic[],
  symbols: SymbolTable,
  def: DefNode,
  perms: Map<string, PermissionUsage[]>,
): void {
  const ctx: BodyContext = { params: def.params, stmts: def.body };
  for (const stmt of def.body) {
    validateStmt(diags, symbols, ctx, stmt, perms);
  }
}

function validateOn(
  diags: LangDiagnostic[],
  symbols: SymbolTable,
  on: OnNode,
  perms: Map<string, PermissionUsage[]>,
): void {
  const resolvedEvent = symbols.resolveEvent(on.event);

  if (resolvedEvent === undefined) {
    // Only warn about unknown events when descriptors are loaded — without
    // an event catalog we have no ground truth to validate against.
    if (symbols.hasDescriptors()) {
      diags.push(langWarning(`Unknown event \`${on.event}\``, on.eventSpan));
    }
  } else {
    // Track event permission requirement
    if (resolvedEvent.permission) {
      trackPermission(perms, resolvedEvent.permission, on.eventSpan, on.event);
    }

    // Validate binding count against event payload
    if (resolvedEvent.payload && on.bindings.length > 0) {
      if (on.bindings.length > resolvedEvent.payload.length) {
        const expected = resolvedEvent.payload.length;
        const got = on.bindings.length;

        diags.push(langError(
          `Event \`${on.event}\` provides ${expected} payload field${expected !== 1 ? "s" : ""} but ${got} binding${got !== 1 ? "s" : ""} were declared`,
          on.eventSpan,
        ));
      }
    }
  }

  // Treat event bindings as params for scope resolution
  // TODO: derive the event binding type from the resolved event payload, and
  // validate accordingly, as well as populate the symbol table for IDE resolution.
  const bindingParams: DefParam[] = on.bindings.map((b) => ({
    varType: "int" as const,
    name: b.name,
    span: b.span,
  }));

  const ctx: BodyContext = { params: bindingParams, stmts: on.body };

  for (const stmt of on.body) {
    validateStmt(diags, symbols, ctx, stmt, perms);
  }
}

// --- Statement validator -----------------------------------------------------

function validateStmt(
  diags: LangDiagnostic[],
  symbols: SymbolTable,
  ctx: BodyContext,
  stmt: Stmt,
  perms: Map<string, PermissionUsage[]>,
): void {
  switch (stmt.kind) {
    case "LocalDecl":
      if (stmt.init !== null) {
        validateExpr(diags, symbols, ctx, stmt.init, false, perms);
      }
      break;

    case "AssignLocal": {
      const resolved = symbols.resolveLocal(
        stmt.name,
        ctx.stmts,
        stmt.span.line,
        ctx.params,
      );

      if (resolved === undefined) {
        diags.push(langError(
          `Unknown variable \`${stmt.name}\``,
          stmt.nameSpan,
        ));
      } else if (resolved.readonly) {
        diags.push(langError(
          `Cannot assign to read-only variable \`${stmt.name}\``,
          stmt.nameSpan,
        ));
      }

      validateExpr(diags, symbols, ctx, stmt.value, false, perms);
      break;
    }

    case "AssignGlobal": {
      const resolved = symbols.resolveGlobal(stmt.name);

      if (resolved === undefined) {
        diags.push(langError(
          `Unknown global variable \`$${stmt.name}\``,
          stmt.nameSpan,
        ));
      }

      validateExpr(diags, symbols, ctx, stmt.value, false, perms);
      break;
    }

    case "AssignIndex":
      validateExpr(diags, symbols, ctx, stmt.target, false, perms);
      validateExpr(diags, symbols, ctx, stmt.index, false, perms);
      validateExpr(diags, symbols, ctx, stmt.value, false, perms);
      break;

    case "ExprStmt":
      validateExpr(diags, symbols, ctx, stmt.expr, false, perms);
      break;

    case "If":
      validateExpr(diags, symbols, ctx, stmt.condition, false, perms);
      for (const s of stmt.then) validateStmt(diags, symbols, ctx, s, perms);
      if (stmt.else !== null) {
        for (const s of stmt.else) validateStmt(diags, symbols, ctx, s, perms);
      }
      break;

    case "Return":
      if (stmt.value !== null) validateExpr(diags, symbols, ctx, stmt.value, false, perms);
      break;

    case "While":
      validateExpr(diags, symbols, ctx, stmt.condition, false, perms);
      for (const s of stmt.body) validateStmt(diags, symbols, ctx, s, perms);
      break;

    case "For": {
      if (stmt.global) {
        const resolved = symbols.resolveGlobal(stmt.variable);
        if (resolved === undefined) {
          diags.push(langError(
            `Unknown variable \`${stmt.variable}\``,
            stmt.variableSpan,
          ));
        }
      } else {
        const resolved = symbols.resolveLocal(
          stmt.variable,
          ctx.stmts,
          stmt.span.line,
          ctx.params,
        );
        if (resolved === undefined) {
          diags.push(langError(
            `Unknown variable \`${stmt.variable}\``,
            stmt.variableSpan,
          ));
        }
      }

      if (stmt.iterable.kind === "Range") {
        validateExpr(diags, symbols, ctx, stmt.iterable.start, false, perms);
        validateExpr(diags, symbols, ctx, stmt.iterable.end, false, perms);
      }

      for (const s of stmt.body) validateStmt(diags, symbols, ctx, s, perms);
      break;
    }

    case "CompoundAssign":
      validateExpr(diags, symbols, ctx, stmt.value, false, perms);
      break;

    case "Conditional":
      validateStmt(diags, symbols, ctx, stmt.body, perms);
      validateExpr(diags, symbols, ctx, stmt.condition, false, perms);
      break;
  }
}

// --- Expression validator ----------------------------------------------------

function validateExpr(
  diags: LangDiagnostic[],
  symbols: SymbolTable,
  ctx: BodyContext | null,
  expr: Expr,
  inPipe: boolean,
  perms: Map<string, PermissionUsage[]>,
): void {
  switch (expr.kind) {
    case "ConfigRef": {
      const resolved = symbols.resolveConfig(expr.name);

      if (resolved === undefined) {
        diags.push(langError(
          `Unknown config variable \`config.${expr.name}\``,
          expr.span,
        ));
      }
      break;
    }

    case "MetaRef":
      // Syntactically valid stub — emitter handles diagnostics.
      break;

    case "GlobalVar": {
      const resolved = symbols.resolveGlobal(expr.name);

      if (resolved === undefined) {
        diags.push(langError(
          `Unknown global variable \`$${expr.name}\``,
          expr.span,
        ));
      }
      break;
    }

    case "Identifier": {
      if (ctx !== null) {
        const local = symbols.resolveLocal(
          expr.name,
          ctx.stmts,
          expr.span.line,
          ctx.params,
        );
        if (local !== undefined) break;
      }

      const fn = symbols.resolveFunction(expr.name);
      if (fn !== undefined) {
        diags.push(langError(
          `Cannot use function \`${expr.name}\` as a value, did you mean to call \`${expr.name}()\`?`,
          expr.span,
        ));
        break;
      }

      diags.push(langError(
        `Unknown identifier \`${expr.name}\``,
        expr.span,
      ));
      break;
    }

    case "Call": {
      validateCall(diags, symbols, expr.name, expr.args, expr.span, perms);

      for (const arg of expr.args) {
        validateExpr(diags, symbols, ctx, arg, inPipe, perms);
      }
      break;
    }

    case "Pipe":
      validateExpr(diags, symbols, ctx, expr.head, true, perms);

      for (const step of expr.steps) {
        validateCall(diags, symbols, step.call.name, step.call.args, step.call.span, perms);

        for (const arg of step.call.args) {
          validateExpr(diags, symbols, ctx, arg, true, perms);
        }
      }
      break;

    case "Binary":
      validateExpr(diags, symbols, ctx, expr.left, inPipe, perms);
      validateExpr(diags, symbols, ctx, expr.right, inPipe, perms);
      break;

    case "Unary":
      validateExpr(diags, symbols, ctx, expr.operand, inPipe, perms);
      break;

    case "Accumulator":
      if (!inPipe) {
        diags.push(langError(
          "`$_` can only be used inside a pipe chain",
          expr.span,
        ));
      }
      break;

    // Leaf nodes: Literal, ErrorCode, Index — no resolution needed
    // (Index components are validated via their sub-expressions above)
    default:
      break;
  }
}

// --- Call validation with permission tracking --------------------------------

function validateCall(
  diags: LangDiagnostic[],
  symbols: SymbolTable,
  name: string,
  args: readonly Expr[],
  span: Span,
  perms: Map<string, PermissionUsage[]>,
): void {
  const fn = symbols.resolveFunction(name);

  if (fn === undefined) {
    diags.push(langWarning(
      `Unknown function \`${name}\``,
      { line: span.line, col: span.col, endLine: span.line, endCol: span.col + name.length },
    ));

    return;
  }

  // Arg count validation
  if (fn.variadic) {
    // Variadic: must have at least the declared param count (note that our language does not currently document variadic host functions,
    // nor does it have a mechanism of supporting variadic plugin/module level functions.
    if (args.length < fn.params.length) {
      diags.push(langError(
        `\`${name}\` expects at least ${fn.params.length} argument${fn.params.length !== 1 ? "s" : ""} but was called with ${args.length}`,
        span,
      ));
    }
  } else {
    // Fixed arity: check for optional params
    const requiredCount = fn.descriptor
      ? (fn.descriptor.args ?? []).filter((a) => !a.optional).length
      : fn.params.length;
    const maxCount = fn.params.length;

    if (args.length < requiredCount) {
      diags.push(langError(
        `\`${name}\` expects ${requiredCount === maxCount ? String(requiredCount) : `${requiredCount}-${maxCount}`} argument${requiredCount !== 1 ? "s" : ""} but was called with ${args.length}`,
        span,
      ));
    } else if (args.length > maxCount) {
      diags.push(langError(
        `\`${name}\` expects ${requiredCount === maxCount ? String(maxCount) : `${requiredCount}-${maxCount}`} argument${maxCount !== 1 ? "s" : ""} but was called with ${args.length}`,
        span,
      ));
    }
  }

  // Permission tracking
  if (fn.permission) {
    trackPermission(perms, fn.permission, span, name);
  }
}

// --- Permission helpers ------------------------------------------------------

function trackPermission(
  perms: Map<string, PermissionUsage[]>,
  permission: string,
  callSite: Span,
  functionName: string,
): void {
  let usages = perms.get(permission);

  if (!usages) {
    usages = [];
    perms.set(permission, usages);
  }

  usages.push({ permission, callSite, functionName });
}

function emitPermissionDiagnostics(
  diags: LangDiagnostic[],
  required: Map<string, PermissionUsage[]>,
  declared: Map<string, Span>,
): void {
  // Missing permissions: required but not declared
  for (const [perm, usages] of required) {
    if (!hasPermission(declared, perm)) {
      // Emit one error per distinct permission, pointing at the first usage
      const first = usages[0]!;

      diags.push(langError(
        `Function \`${first.functionName}\` requires permission \`${perm}\` which is not declared in @permissions`,
        first.callSite,
      ));
    }
  }

  // Unused permissions: declared but not required
  for (const [perm, span] of declared) {
    let used = false;

    for (const reqPerm of required.keys()) {
      if (permissionCovers(perm, reqPerm)) {
        used = true;
        break;
      }
    }

    if (!used) {
      diags.push(langWarning(
        `Permission \`${perm}\` is declared but never used`,
        span,
      ));
    }
  }
}

/**
 * Check if the declared permission set includes the required permission.
 * Supports wildcard: "ble:*" covers "ble:write".
 */
function hasPermission(declared: Map<string, Span>, required: string): boolean {
  if (declared.has(required)) return true;

  const colonIndex = required.indexOf(":");

  if (colonIndex >= 0) {
    const resource = required.substring(0, colonIndex);
    if (declared.has(`${resource}:*`)) return true;
  }

  return false;
}

/**
 * Check if a single declared permission covers a required permission.
 * "ble:*" covers "ble:write"; "ble:write" covers "ble:write".
 */
function permissionCovers(declared: string, required: string): boolean {
  if (declared === required) return true;

  const colonIndex = required.indexOf(":");
  
  if (colonIndex >= 0) {
    const resource = required.substring(0, colonIndex);
    if (declared === `${resource}:*`) return true;
  }

  return false;
}

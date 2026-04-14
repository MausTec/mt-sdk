import type { Span } from "../lang/diagnostics.js";
import type {
  PluginNode,
  FnNode,
  DefNode,
  OnNode,
  DefParam,
  Expr,
  Stmt,
} from "../lang/ast.js";
import { SymbolTable } from "./symbol-table.js";

// TODO: Should the Validator be a concern of the LSP? Because this feels like a lang/ module concern the more I write it.

// --- Diagnostic type ---------------------------------------------------------

export interface ValidationDiagnostic {
  level: "error" | "warning";
  message: string;
  span: Span;
}

// --- Known event names -------------------------------------------------------
// TODO: This is NOT a source of truth! The runtime SDK declares this!

const KNOWN_EVENTS = new Set([
  "connect",
  "disconnect",
  "speedChange",
  "modeSet",
  "tick",
  "start",
  "stop",
  "restart",
  "error",
  "airChange",
  "pressureChange",
]);

// --- Body context (same shape as semantic-tokens) ----------------------------

interface BodyContext {
  params: readonly DefParam[];
  stmts: readonly Stmt[];
}

// --- Public entry point ------------------------------------------------------

/**
 * Run symbol-resolution validation on a parsed plugin AST.
 * Returns diagnostics for unresolved identifiers, config refs, globals,
 * function calls, and assignment targets.
 */
export function validateSymbols(ast: PluginNode): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  const symbols = SymbolTable.fromAST(ast);

  // Config declaration inits + constraints (no local scope)
  if (ast.configBlock !== null) {
    for (const decl of ast.configBlock.declarations) {
      validateExpr(diagnostics, symbols, null, decl.default);

      for (const expr of Object.values(decl.constraints)) {
        validateExpr(diagnostics, symbols, null, expr);
      }
    }
  }

  // Global declaration inits (no local scope)
  if (ast.globalsBlock !== null) {
    for (const decl of ast.globalsBlock.declarations) {
      validateExpr(diagnostics, symbols, null, decl.init);
    }
  }

  // fn expressions
  for (const fn of ast.functions) {
    validateFn(diagnostics, symbols, fn);
  }

  // def functions
  for (const def of ast.defs) {
    validateDef(diagnostics, symbols, def);
  }

  // event handlers
  for (const handler of ast.handlers) {
    validateOn(diagnostics, symbols, handler);
  }

  return diagnostics;
}

// --- Function/handler validators ---------------------------------------------

function validateFn(
  diags: ValidationDiagnostic[],
  symbols: SymbolTable,
  fn: FnNode,
): void {
  validateExpr(diags, symbols, { params: fn.params, stmts: [] }, fn.body);
}

function validateDef(
  diags: ValidationDiagnostic[],
  symbols: SymbolTable,
  def: DefNode,
): void {
  const ctx: BodyContext = { params: def.params, stmts: def.body };
  for (const stmt of def.body) {
    validateStmt(diags, symbols, ctx, stmt);
  }
}

function validateOn(
  diags: ValidationDiagnostic[],
  symbols: SymbolTable,
  on: OnNode,
): void {
  if (!KNOWN_EVENTS.has(on.event)) {
    diags.push({
      level: "warning",
      message: `Unknown event \`${on.event}\``,
      span: on.span,
    });
  }

  const ctx: BodyContext = { params: [], stmts: on.body };

  for (const stmt of on.body) {
    validateStmt(diags, symbols, ctx, stmt);
  }
}

// --- Statement validator -----------------------------------------------------

function validateStmt(
  diags: ValidationDiagnostic[],
  symbols: SymbolTable,
  ctx: BodyContext,
  stmt: Stmt,
): void {
  switch (stmt.kind) {
    case "LocalDecl":
      if (stmt.init !== null) {
        validateExpr(diags, symbols, ctx, stmt.init);
      }
      break;

    case "AssignLocal": {
      // The assignment target must resolve to a local or parameter.
      const resolved = symbols.resolveLocal(
        stmt.name,
        ctx.stmts,
        stmt.span.line,
        ctx.params,
      );

      if (resolved === undefined) {
        diags.push({
          level: "error",
          message: `Unknown variable \`${stmt.name}\``,
          span: stmt.nameSpan,
        });
      } else if (resolved.readonly) {
        diags.push({
          level: "error",
          message: `Cannot assign to read-only variable \`${stmt.name}\``,
          span: stmt.nameSpan,
        });
      }

      validateExpr(diags, symbols, ctx, stmt.value);
      break;
    }

    case "AssignGlobal": {
      const resolved = symbols.resolveGlobal(stmt.name);

      if (resolved === undefined) {
        diags.push({
          level: "error",
          message: `Unknown global variable \`$${stmt.name}\``,
          span: stmt.nameSpan,
        });
      }

      validateExpr(diags, symbols, ctx, stmt.value);
      break;
    }

    case "ExprStmt":
      validateExpr(diags, symbols, ctx, stmt.expr);
      break;

    case "If":
      validateExpr(diags, symbols, ctx, stmt.condition);

      for (const s of stmt.then) validateStmt(diags, symbols, ctx, s);

      if (stmt.else !== null) {
        for (const s of stmt.else) validateStmt(diags, symbols, ctx, s);
      }
      break;

    case "Return":
      if (stmt.value !== null) validateExpr(diags, symbols, ctx, stmt.value);
      break;

    case "Conditional":
      validateStmt(diags, symbols, ctx, stmt.body);
      validateExpr(diags, symbols, ctx, stmt.condition);
      break;
  }
}

// --- Expression validator ----------------------------------------------------

function validateExpr(
  diags: ValidationDiagnostic[],
  symbols: SymbolTable,
  ctx: BodyContext | null,
  expr: Expr,
): void {
  switch (expr.kind) {
    case "ConfigRef": {
      const resolved = symbols.resolveConfig(expr.name);

      if (resolved === undefined) {
        diags.push({
          level: "error",
          message: `Unknown config variable \`@${expr.name}\``,
          span: expr.span,
        });
      }

      break;
    }

    case "GlobalVar": {
      const resolved = symbols.resolveGlobal(expr.name);

      if (resolved === undefined) {
        diags.push({
          level: "error",
          message: `Unknown global variable \`$${expr.name}\``,
          span: expr.span,
        });
      }

      break;
    }

    case "Identifier": {
      if (ctx !== null) {
        // Try local/param resolution first, then function
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
        diags.push({
          level: "error",
          message: `Cannot use function \`${expr.name}\` as a value, did you mean to call \`${expr.name}()\`?`,
          span: expr.span,
        });
        break;
      }

      diags.push({
        level: "error",
        message: `Unknown identifier \`${expr.name}\``,
        span: expr.span,
      });

      break;
    }

    case "Call": {
      const fn = symbols.resolveFunction(expr.name);

      if (fn === undefined) {
        diags.push({
          level: "warning",
          message: `Unknown function \`${expr.name}\``,
          span: {
            line: expr.span.line,
            col: expr.span.col,
            endLine: expr.span.line,
            endCol: expr.span.col + expr.name.length,
          },
        });
      } else if (fn.params.length !== expr.args.length) {
        const expected = fn.params.length;
        const got = expr.args.length;

        diags.push({
          level: "error",
          message: `\`${expr.name}\` expects ${expected} argument${expected !== 1 ? "s" : ""} but was called with ${got}`,
          span: expr.span,
        });
      }

      for (const arg of expr.args) {
        validateExpr(diags, symbols, ctx, arg);
      }
      break;
    }

    case "Pipe":
      validateExpr(diags, symbols, ctx, expr.head);

      for (const step of expr.steps) {
        const fn = symbols.resolveFunction(step.call.name);

        if (fn === undefined) {
          diags.push({
            level: "warning",
            message: `Unknown function \`${step.call.name}\``,
            span: {
              line: step.call.span.line,
              col: step.call.span.col,
              endLine: step.call.span.line,
              endCol: step.call.span.col + step.call.name.length,
            },
          });
        }
        
        for (const arg of step.call.args) {
          validateExpr(diags, symbols, ctx, arg);
        }
      }
      break;

    case "Binary":
      validateExpr(diags, symbols, ctx, expr.left);
      validateExpr(diags, symbols, ctx, expr.right);
      break;

    case "Unary":
      validateExpr(diags, symbols, ctx, expr.operand);
      break;

    // Leaf nodes: Literal, Accumulator, ErrorCode — no resolution needed
    default:
      break;
  }
}

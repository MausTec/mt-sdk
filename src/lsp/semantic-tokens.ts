import {
  SemanticTokensBuilder,
  SemanticTokenTypes,
  SemanticTokenModifiers,
} from "vscode-languageserver/node.js";
import type { SemanticTokensLegend, SemanticTokens } from "vscode-languageserver/node.js";
import type { Span } from "../lang/diagnostics.js";
import type {
  PluginNode,
  FnNode,
  DefNode,
  OnNode,
  DefParam,
  Expr,
  Stmt,
  ConfigDecl,
  GlobalDecl,
} from "../lang/ast.js";
import { SymbolTable } from "./symbol-table.js";

// --- Legend -------------------------------------------------------------------

/** Ordered list of token types, index is important */
const tokenTypes = [
  SemanticTokenTypes.variable,
  SemanticTokenTypes.function,
  SemanticTokenTypes.parameter,
  SemanticTokenTypes.property,
  SemanticTokenTypes.event,
];

/** Ordered list of modifiers, index is important */
const tokenModifiers = [
  SemanticTokenModifiers.declaration,
  SemanticTokenModifiers.readonly,
  SemanticTokenModifiers.defaultLibrary,
  SemanticTokenModifiers.modification,
];

export const semanticTokensLegend: SemanticTokensLegend = {
  tokenTypes,
  tokenModifiers,
};

// --- Helpers -----------------------------------------------------------------

function typeIndex(type: string): number {
  return tokenTypes.indexOf(type as typeof tokenTypes[number]);
}

function modBits(...mods: string[]): number {
  let bits = 0;
  for (const m of mods) {
    const idx = tokenModifiers.indexOf(m as typeof tokenModifiers[number]);
    if (idx >= 0) bits |= 1 << idx;
  }
  return bits;
}

/**
 * Push a single semantic token. Span is 1-based; the builder expects 0-based.
 */
function push(
  builder: SemanticTokensBuilder,
  span: Span,
  length: number,
  type: number,
  modifiers: number,
): void {
  builder.push(
    span.line - 1,
    span.col - 1,
    length,
    type,
    modifiers,
  );
}

// --- Provider ----------------------------------------------------------------

/**
 * Compute semantic tokens for an entire document.
 */
export function getSemanticTokens(ast: PluginNode): SemanticTokens {
  const builder = new SemanticTokensBuilder();
  const symbols = SymbolTable.fromAST(ast);

  // Config declarations
  if (ast.configBlock !== null) {
    for (const decl of ast.configBlock.declarations) {
      visitConfigDecl(builder, decl);
    }
  }

  // Global declarations
  if (ast.globalsBlock !== null) {
    for (const decl of ast.globalsBlock.declarations) {
      visitGlobalDecl(builder, decl);
    }
  }

  // Functions (fn)
  for (const fn of ast.functions) {
    visitFn(builder, symbols, fn);
  }

  // Functions (def)
  for (const def of ast.defs) {
    visitDef(builder, symbols, def);
  }

  // Event handlers
  for (const handler of ast.handlers) {
    visitOn(builder, symbols, handler);
  }

  return builder.build();
}

// --- Declaration visitors ----------------------------------------------------

function visitConfigDecl(builder: SemanticTokensBuilder, decl: ConfigDecl): void {
  // Config name at declaration site: variable + declaration + readonly
  push(
    builder,
    decl.nameSpan,
    decl.name.length,
    typeIndex(SemanticTokenTypes.variable),
    modBits(SemanticTokenModifiers.declaration, SemanticTokenModifiers.readonly),
  );

  // Default value expression
  visitExpr(builder, null, null, decl.default);

  // Constraint expressions
  for (const expr of Object.values(decl.constraints)) {
    visitExpr(builder, null, null, expr);
  }
}

function visitGlobalDecl(builder: SemanticTokensBuilder, decl: GlobalDecl): void {
  // Global name at declaration site: variable + declaration
  push(
    builder,
    decl.nameSpan,
    decl.name.length,
    typeIndex(SemanticTokenTypes.variable),
    modBits(SemanticTokenModifiers.declaration),
  );

  // Init expression
  visitExpr(builder, null, null, decl.init);
}

function visitFn(builder: SemanticTokensBuilder, symbols: SymbolTable, fn: FnNode): void {
  // Function name at declaration site
  push(
    builder,
    fn.nameSpan,
    fn.name.length,
    typeIndex(SemanticTokenTypes.function),
    modBits(SemanticTokenModifiers.declaration),
  );

  // Parameters
  for (const param of fn.params) {
    push(
      builder,
      param.span,
      param.name.length,
      typeIndex(SemanticTokenTypes.parameter),
      modBits(SemanticTokenModifiers.declaration),
    );
  }

  // Body expression - fn has no body stmts, just one expr
  visitExpr(builder, symbols, { params: fn.params, stmts: [] }, fn.body);
}

function visitDef(builder: SemanticTokensBuilder, symbols: SymbolTable, def: DefNode): void {
  // Function name at declaration site
  push(
    builder,
    def.nameSpan,
    def.name.length,
    typeIndex(SemanticTokenTypes.function),
    modBits(SemanticTokenModifiers.declaration),
  );

  // Parameters
  for (const param of def.params) {
    push(
      builder,
      param.span,
      param.name.length,
      typeIndex(SemanticTokenTypes.parameter),
      modBits(SemanticTokenModifiers.declaration),
    );
  }

  // Body statements
  for (const stmt of def.body) {
    visitStmt(builder, symbols, { params: def.params, stmts: def.body }, stmt);
  }
}

function visitOn(builder: SemanticTokensBuilder, symbols: SymbolTable, on: OnNode): void {
  const bindingParams: DefParam[] = on.bindings.map((b) => ({
    name: b.name,
    varType: "int" as const,
    span: b.span,
  }));

  for (const b of on.bindings) {
    push(
      builder,
      b.span,
      b.name.length,
      typeIndex(SemanticTokenTypes.parameter),
      modBits(SemanticTokenModifiers.declaration),
    );
  }

  // Body statements pass bindings as params so usages resolve as `parameter`
  for (const stmt of on.body) {
    visitStmt(builder, symbols, { params: bindingParams, stmts: on.body }, stmt);
  }
}

// --- Context for resolution inside a function body ---------------------------

interface BodyContext {
  params: readonly DefParam[];
  stmts: readonly Stmt[];
}

// --- Statement visitor -------------------------------------------------------

function visitStmt(
  builder: SemanticTokensBuilder,
  symbols: SymbolTable,
  ctx: BodyContext,
  stmt: Stmt,
): void {
  switch (stmt.kind) {
    case "LocalDecl":
      // Variable name at declaration site
      push(
        builder,
        stmt.nameSpan,
        stmt.name.length,
        typeIndex(SemanticTokenTypes.variable),
        modBits(SemanticTokenModifiers.declaration),
      );

      if (stmt.init !== null) {
        visitExpr(builder, symbols, ctx, stmt.init);
      }
      break;

    case "AssignLocal": {
      // Resolve to determine if it's a parameter or local
      const resolved = symbols?.resolveLocal(stmt.name, ctx.stmts, stmt.span.line, ctx.params);
      if (resolved !== undefined) {
        const tokenType = resolved.source === "parameter"
          ? SemanticTokenTypes.parameter
          : SemanticTokenTypes.variable;

        push(
          builder,
          stmt.nameSpan,
          stmt.name.length,
          typeIndex(tokenType),
          modBits(SemanticTokenModifiers.modification),
        );
      } else {
        // Unknown local - still mark as variable
        push(
          builder,
          stmt.nameSpan,
          stmt.name.length,
          typeIndex(SemanticTokenTypes.variable),
          modBits(SemanticTokenModifiers.modification),
        );
      }

      visitExpr(builder, symbols, ctx, stmt.value);
      break;
    }

    case "AssignGlobal":
      // Global variable assignment target
      push(
        builder,
        stmt.nameSpan,
        // +1 for the `$` sigil
        stmt.name.length + 1,
        typeIndex(SemanticTokenTypes.variable),
        modBits(SemanticTokenModifiers.modification),
      );

      visitExpr(builder, symbols, ctx, stmt.value);
      break;

    case "AssignIndex":
      visitExpr(builder, symbols, ctx, stmt.target);
      visitExpr(builder, symbols, ctx, stmt.index);
      visitExpr(builder, symbols, ctx, stmt.value);
      break;

    case "ExprStmt":
      visitExpr(builder, symbols, ctx, stmt.expr);
      break;

    case "If":
      visitExpr(builder, symbols, ctx, stmt.condition);
      for (const s of stmt.then) visitStmt(builder, symbols, ctx, s);

      if (stmt.else !== null) {
        for (const s of stmt.else) visitStmt(builder, symbols, ctx, s);
      }
      break;

    case "Return":
      if (stmt.value !== null) visitExpr(builder, symbols, ctx, stmt.value);
      break;

    case "While":
      visitExpr(builder, symbols, ctx, stmt.condition);
      for (const s of stmt.body) visitStmt(builder, symbols, ctx, s);
      break;

    case "For":
      if (stmt.iterable.kind === "Range") {
        visitExpr(builder, symbols, ctx, stmt.iterable.start);
        visitExpr(builder, symbols, ctx, stmt.iterable.end);
      }
      for (const s of stmt.body) visitStmt(builder, symbols, ctx, s);
      break;

    case "CompoundAssign":
      visitExpr(builder, symbols, ctx, stmt.value);
      break;

    case "Conditional":
      // Body appears before condition in source text (`stmt if cond`),
      // so visit body first to maintain document order for delta encoding.
      visitStmt(builder, symbols, ctx, stmt.body);
      visitExpr(builder, symbols, ctx, stmt.condition);
      break;
  }
}

// --- Expression visitor ------------------------------------------------------

function visitExpr(
  builder: SemanticTokensBuilder,
  symbols: SymbolTable | null,
  ctx: BodyContext | null,
  expr: Expr,
): void {
  switch (expr.kind) {
    case "ConfigRef": {
      // `config.name` - highlight the field portion as a readonly variable.
      const fieldCol = expr.span.col + "config.".length;

      push(
        builder,
        { ...expr.span, col: fieldCol, endCol: fieldCol + expr.name.length },
        expr.name.length,
        typeIndex(SemanticTokenTypes.variable),
        modBits(SemanticTokenModifiers.readonly),
      );

      break;
    }

    case "MetaRef": {
      // `meta.name` - same treatment as ConfigRef
      const metaFieldCol = expr.span.col + "meta.".length;

      push(
        builder,
        { ...expr.span, col: metaFieldCol, endCol: metaFieldCol + expr.name.length },
        expr.name.length,
        typeIndex(SemanticTokenTypes.variable),
        modBits(SemanticTokenModifiers.readonly),
      );

      break;
    }

    case "GlobalVar":
      // `$name` - variable
      push(
        builder,
        expr.span,
        // +1 for the `$` sigil
        expr.name.length + 1,
        typeIndex(SemanticTokenTypes.variable),
        0,
      );
      break;

    case "Accumulator":
      // `$_` - special variable
      push(builder, expr.span, 2, typeIndex(SemanticTokenTypes.variable), modBits(SemanticTokenModifiers.readonly));
      break;

    case "ErrorCode":
      // `$!` - special variable
      push(builder, expr.span, 2, typeIndex(SemanticTokenTypes.variable), modBits(SemanticTokenModifiers.readonly));
      break;

    case "Identifier":
      if (symbols !== null && ctx !== null) {
        // Try to resolve: parameter > local > function
        const local = symbols.resolveLocal(expr.name, ctx.stmts, expr.span.line, ctx.params);

        if (local !== undefined) {
          const tokenType = local.source === "parameter"
            ? SemanticTokenTypes.parameter
            : SemanticTokenTypes.variable;
          push(builder, expr.span, expr.name.length, typeIndex(tokenType), 0);
          break;
        }

        const fn = symbols.resolveFunction(expr.name);

        if (fn !== undefined) {
          const mods = fn.source === "builtin" || fn.source === "runtime"
            ? modBits(SemanticTokenModifiers.defaultLibrary)
            : 0;
          push(builder, expr.span, expr.name.length, typeIndex(SemanticTokenTypes.function), mods);
          break;
        }
      }

      // UNRESOLVED: no semantic token (falls through to TextMate grammar)
      break;

    case "Call": {
      // Function call name
      const nameLength = expr.name.length;

      push(
        builder,
        expr.span,
        nameLength,
        typeIndex(SemanticTokenTypes.function),
        symbols !== null
          ? (() => {
              const fn = symbols.resolveFunction(expr.name);
              return fn !== undefined && (fn.source === "builtin" || fn.source === "runtime")
                ? modBits(SemanticTokenModifiers.defaultLibrary)
                : 0;
            })()
          : 0,
      );

      // Visit arguments
      for (const arg of expr.args) {
        visitExpr(builder, symbols, ctx, arg);
      }
      break;
    }

    case "Pipe":
      visitExpr(builder, symbols, ctx, expr.head);

      for (const step of expr.steps) {
        // Each pipe step is a call
        const nameLength = step.call.name.length;

        push(
          builder,
          step.call.span,
          nameLength,
          typeIndex(SemanticTokenTypes.function),
          symbols !== null
            ? (() => {
                const fn = symbols.resolveFunction(step.call.name);
                return fn !== undefined && (fn.source === "builtin" || fn.source === "runtime")
                  ? modBits(SemanticTokenModifiers.defaultLibrary)
                  : 0;
              })()
            : 0,
        );
        
        // Visit pipe step arguments
        for (const arg of step.call.args) {
          visitExpr(builder, symbols, ctx, arg);
        }
      }
      break;

    case "Binary":
      visitExpr(builder, symbols, ctx, expr.left);
      visitExpr(builder, symbols, ctx, expr.right);
      break;

    case "Unary":
      visitExpr(builder, symbols, ctx, expr.operand);
      break;

    case "Literal":
      // No semantic token needed - handled by TextMate grammar
      break;
  }
}

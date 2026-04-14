import { lex } from "./lexer.js";
import { parse } from "./parser.js";
import { emit } from "./emitter.js";
import type { MtpPlugin } from "../core/mtp-types.js";

// --- Re-exports ---------------------------------------------------------------

export type { Span, LangDiagnostic, LangDiagnosticLevel } from "./diagnostics.js";
export { NULL_SPAN } from "./diagnostics.js";
export { TokenKind } from "./token.js";
export type { Token } from "./token.js";
export type {
  ASTNode,
  PluginNode,
  MetadataFieldNode,
  MatchBlockNode,
  ConfigBlockNode,
  GlobalsBlockNode,
  FnNode,
  DefNode,
  OnNode,
  ConfigDecl,
  GlobalDecl,
  DefParam,
  MatchPredicate,
  ConditionalStmt,
  Stmt,
  Expr,
  VarType,
} from "./ast.js";
export type { ParseResult } from "./parser.js";
export type { EmitResult } from "./emitter.js";

// --- Orchestration types ------------------------------------------------------

import type { LangDiagnostic } from "./diagnostics.js";
import type { PluginNode } from "./ast.js";
import { validateSymbols } from "../lsp/validation.js";

export interface TranspileResult {
  plugin: MtpPlugin;
  diagnostics: LangDiagnostic[];
}

// --- Public API ---------------------------------------------------------------

/**
 * Parse `.mtp` source text and return an AST with diagnostics.
 * This is the entry point for the LSP (which only needs the AST).
 * Never throws.
 */
export function parseSource(source: string): { ast: PluginNode; diagnostics: LangDiagnostic[] } {
  const { tokens, diagnostics: lexDiags } = lex(source);
  const { ast, diagnostics: parseDiags } = parse(tokens);
  return { ast, diagnostics: [...lexDiags, ...parseDiags] };
}

/**
 * Walk an already-parsed AST and produce the JSON plugin schema.
 * Exposed separately so the LSP can parse once and re-emit on change.
 * Never throws.
 */
export function emitPlugin(ast: PluginNode): { plugin: MtpPlugin; diagnostics: LangDiagnostic[] } {
  return emit(ast);
}

/**
 * Parse source text and emit the JSON plugin schema in one step.
 * This is what the `build` command will call.
 * Never throws.
 */
export function transpile(source: string): TranspileResult {
  const { ast, diagnostics: parseDiags } = parseSource(source);
  const validateDiags = validateSymbols(ast);
  const { plugin, diagnostics: emitDiags } = emitPlugin(ast);
  return { plugin, diagnostics: [...parseDiags, ...validateDiags, ...emitDiags] };
}

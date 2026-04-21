import { lex } from "./lexer.js";
import { parse } from "./parser.js";
import { emit } from "./emitter/index.js";
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
export type { EmitResult } from "./emitter/index.js";

// --- Orchestration types ------------------------------------------------------

import type { LangDiagnostic } from "./diagnostics.js";
import type { PluginNode } from "./ast.js";
import { link } from "./linker.js";

export type { LinkerContext, LinkedResult, PermissionAnalysis, PermissionUsage } from "./linker.js";
export { link, resolveASTBundle } from "./linker.js";
export { SymbolTable } from "./symbol-table.js";
export type { ResolvedFunction, ResolvedVariable, ResolvedEvent, ResolvedSymbol } from "./symbol-table.js";

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
 * Parse `.mtp` source text, link against its declared runtime API,
 * and emit the JSON plugin schema in one step.
 */
export function transpile(source: string): TranspileResult {
  const { ast, diagnostics: parseDiags } = parseSource(source);
  const { diagnostics: linkDiags } = link(ast);
  const { plugin, diagnostics: emitDiags } = emitPlugin(ast);
  return { plugin, diagnostics: [...parseDiags, ...linkDiags, ...emitDiags] };
}

/**
 * Format the transpiled JSON structure into a human-readable string suitable for writing
 * to a `.json` file.
 *
 * Produces output matching the hand-written plugin.json conventions:
 * - 4-space indent
 * - Short primitive arrays inlined: `[ "@eom" ]`
 * - Short objects inlined: `{ "return": 42 }`
 * - Action lists (arrays of objects) expanded, one per line
 * - Spaces inside braces/brackets for inline containers
 */
export function formatPluginJson(plugin: MtpPlugin): string {
  return prettyPrint(plugin as unknown, 0);
}

const INLINE_MAX = 72;
const INDENT = "    ";

function compactValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[ ]";
    return "[ " + value.map(compactValue).join(", ") + " ]";
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{ }";

  return "{ " + entries.map(([k, v]) => JSON.stringify(k) + ": " + compactValue(v)).join(", ") + " }";
}

function prettyPrint(value: unknown, depth: number): string {
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);

  const compact = compactValue(value);
  if (compact.length <= INLINE_MAX) return compact;

  const pad = INDENT.repeat(depth + 1);
  const closePad = INDENT.repeat(depth);

  if (Array.isArray(value)) {
    const items = value.map((v) => pad + prettyPrint(v, depth + 1));
    return "[\n" + items.join(",\n") + "\n" + closePad + "]";
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const lines = entries.map(([key, val]) => {
    return pad + JSON.stringify(key) + ": " + prettyPrint(val, depth + 1);
  });
  
  return "{\n" + lines.join(",\n") + "\n" + closePad + "}";
}
import type { Token } from "./token.js";
import type { PluginNode } from "./ast.js";
import type { LangDiagnostic, Span } from "./diagnostics.js";
import { NULL_SPAN } from "./diagnostics.js";

export interface ParseResult {
  ast: PluginNode;
  diagnostics: LangDiagnostic[];
}

/**
 * Parse a token stream produced by {@link lex} into a `PluginNode` AST.
 *
 * Syntax errors produce `error` diagnostics and best-effort
 * recovery rather than throwing. The returned AST is always a complete
 * `PluginNode`, possibly with null/empty fields wherever parsing failed.
 *
 * @stub Not yet implemented. Returns an empty PluginNode.
 */
export function parse(tokens: Token[]): ParseResult {
  const span: Span = tokens[0]?.span ?? NULL_SPAN;

  const ast: PluginNode = {
    kind: "Plugin",
    span,
    displayName: null,
    metadata: [],
    matchBlock: null,
    configBlock: null,
    globalsBlock: null,
    functions: [],
    defs: [],
    handlers: [],
  };

  return { ast, diagnostics: [] };
}

import type { Token } from "./token.js";
import { TokenKind } from "./token.js";
import type { PluginNode, MetadataFieldNode, Expr, LiteralExpr, IdentifierExpr } from "./ast.js";
import type { LangDiagnostic, Span } from "./diagnostics.js";
import { langError, NULL_SPAN } from "./diagnostics.js";

export interface ParseResult {
  ast: PluginNode;
  diagnostics: LangDiagnostic[];
}

// --- Helpers ------------------------------------------------------------------

function mergeSpan(a: Span, b: Span): Span {
  return { line: a.line, col: a.col, endLine: b.endLine, endCol: b.endCol };
}

function emptyPlugin(span: Span): PluginNode {
  return {
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
}

/**
 * Block-opening keywords inside `defplugin` that have their own `do...end`.
 * `fn` is absent because it is a single-line form with no `do`.
 */
const DO_BLOCK_STARTERS = new Set<TokenKind>([
  TokenKind.Match,
  TokenKind.Config,
  TokenKind.Globals,
  TokenKind.Def,
  TokenKind.On,
]);

// --- Parser class -------------------------------------------------------------

class Parser {
  private pos = 0;
  private readonly diagnostics: LangDiagnostic[] = [];

  constructor(private readonly tokens: Token[]) {}

  parse(): ParseResult {
    this.skipTrivia();

    if (!this.check(TokenKind.Defplugin)) {
      const span = this.peek().span;
      return {
        ast: emptyPlugin(span),
        diagnostics: [langError("Expected `defplugin` at top of file", span)],
      };
    }

    const ast = this.parsePlugin();
    return { ast, diagnostics: this.diagnostics };
  }

  // --- Token stream helpers --------------------------------------------------

  private peek(): Token {
    return this.tokens[this.pos] ?? { kind: TokenKind.EOF, value: "", span: NULL_SPAN };
  }

  private advance(): Token {
    const t = this.peek();
    if (t.kind !== TokenKind.EOF) this.pos++;
    return t;
  }

  private check(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private eat(kind: TokenKind): Token | null {
    if (this.check(kind)) return this.advance();
    return null;
  }

  private expect(kind: TokenKind, context: string): Token {
    if (this.check(kind)) return this.advance();
    const t = this.peek();
    this.diagnostics.push(langError(`Expected \`${kind}\` ${context}, got \`${t.kind}\``, t.span));
    return { kind, value: "", span: t.span };
  }

  /** Skip newlines, comments, inter-statement whitespace. */
  private skipTrivia(): void {
    while (this.check(TokenKind.Newline) || this.check(TokenKind.Comment)) {
      this.advance();
    }
  }

  /** Skip a trailing inline comment, but not the newline itself. */
  private skipInlineComment(): void {
    this.eat(TokenKind.Comment);
  }

  // --- Plugin --------------------------------------------------------------

  private parsePlugin(): PluginNode {
    const defToken = this.advance(); // consume `defplugin`

    let displayName: string | null = null;
    if (this.check(TokenKind.StringLit)) {
      displayName = this.advance().value;
    } else {
      this.diagnostics.push(
        langError("Expected display name string after `defplugin`", this.peek().span),
      );
    }

    this.expect(TokenKind.Do, "after defplugin display name");
    this.skipInlineComment();

    const metadata: MetadataFieldNode[] = [];
    this.skipTrivia();

    while (!this.check(TokenKind.End) && !this.check(TokenKind.EOF)) {
      // Sub-blocks with do...end
      if (DO_BLOCK_STARTERS.has(this.peek().kind)) {
        this.skipDoBlock();
        this.skipTrivia();
        continue;
      }

      // `fn` is a single-line definition, it looks a lot like a variable assignment
      // TODO: The parser doesn't yet actually support mutli-line expressions
      if (this.check(TokenKind.Fn)) {
        this.skipToNextLine();
        this.skipTrivia();
        continue;
      }

      // Metadata field: identifier value
      if (this.check(TokenKind.Identifier)) {
        const field = this.parseMetadataField();
        if (field) metadata.push(field);
        this.skipTrivia();
        continue;
      }

      // Unexpected token, skip and recover
      const t = this.advance();
      this.diagnostics.push(langError(`Unexpected token \`${t.kind}\` in defplugin body`, t.span));
      this.skipTrivia();
    }

    const endToken = this.eat(TokenKind.End);

    return {
      kind: "Plugin",
      span: mergeSpan(defToken.span, endToken?.span ?? defToken.span),
      displayName,
      metadata,
      matchBlock: null,
      configBlock: null,
      globalsBlock: null,
      functions: [],
      defs: [],
      handlers: [],
    };
  }

  // --- Metadata field --------------------------------------------------------

  private parseMetadataField(): MetadataFieldNode | null {
    const keyToken = this.advance();
    const key = keyToken.value;

    // Bracket list: permissions ["ble:write", ...]
    if (this.check(TokenKind.LBracket)) {
      this.advance(); // consume `[`
      const items: Expr[] = [];
      
      while (!this.check(TokenKind.RBracket) && !this.check(TokenKind.EOF)) {
        const expr = this.parseScalarValue();
        if (expr) items.push(expr);
        this.eat(TokenKind.Comma);
      }

      const closing = this.eat(TokenKind.RBracket) ?? keyToken;
      
      return {
        kind: "MetadataField",
        key,
        value: items,
        span: mergeSpan(keyToken.span, closing.span),
      };
    }

    // Scalar value
    const expr = this.parseScalarValue();

    if (!expr) {
      this.diagnostics.push(langError(`Expected value for metadata field "${key}"`, this.peek().span));
      this.skipToNextLine();
      return null;
    }

    return {
      kind: "MetadataField",
      key,
      value: expr,
      span: mergeSpan(keyToken.span, expr.span),
    };
  }

  /**
   * Parse a single scalar expression.
   */
  private parseScalarValue(): Expr | null {
    const t = this.peek();

    if (t.kind === TokenKind.StringLit) {
      this.advance();
      return { kind: "Literal", varType: "string", value: t.value, span: t.span } satisfies LiteralExpr;
    }

    if (t.kind === TokenKind.Integer) {
      this.advance();
      return { kind: "Literal", varType: "int", value: parseInt(t.value, 10), span: t.span } satisfies LiteralExpr;
    }

    if (t.kind === TokenKind.True) {
      this.advance();
      return { kind: "Literal", varType: "bool", value: true, span: t.span } satisfies LiteralExpr;
    }

    if (t.kind === TokenKind.False) {
      this.advance();
      return { kind: "Literal", varType: "bool", value: false, span: t.span } satisfies LiteralExpr;
    }

    return null;
  }

  // --- Skip helpers ----------------------------------------------------------

  /**
   * Skip a `keyword ... do ... end` block, counting nested do/end pairs.
   */
  private skipDoBlock(): void {
    this.advance(); // consume the opening keyword

    // Advance to the `do`
    while (!this.check(TokenKind.Do) && !this.check(TokenKind.EOF)) {
      this.advance();
    }
    
    this.eat(TokenKind.Do);

    let depth = 1;
    while (depth > 0 && !this.check(TokenKind.EOF)) {
      const t = this.advance();
      if (t.kind === TokenKind.Do) depth++;
      else if (t.kind === TokenKind.End) depth--;
    }
  }

  /** Consume tokens up to (but not including) the next `Newline` or `EOF`. */
  private skipToNextLine(): void {
    while (!this.check(TokenKind.Newline) && !this.check(TokenKind.EOF)) {
      this.advance();
    }
  }
}

/**
 * Parse a token stream produced by {@link lex} into a `PluginNode` AST.
 *
 * Syntax errors produce `error` diagnostics and best-effort
 * recovery rather than throwing. The returned AST is always a complete
 * `PluginNode`, possibly with null/empty fields wherever parsing failed.
 */
export function parse(tokens: Token[]): ParseResult {
  return new Parser(tokens).parse();
}

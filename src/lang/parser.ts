import type { Token } from "./token.js";
import { TokenKind } from "./token.js";
import type { PluginNode, MetadataFieldNode, Expr, LiteralExpr, IdentifierExpr, ConfigBlockNode, ConfigDecl, VarType } from "./ast.js";
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
 * Block-opening keywords inside `defplugin` that have their own `do...end`
 * They are skipped until a parser method exists for them.
 * Remove a kind from this set when a dedicated parse method is added for it.
 */
const SKIP_BLOCK_STARTERS = new Set<TokenKind>([
  TokenKind.Match,
  TokenKind.Globals,
  TokenKind.Def,
  TokenKind.On,
]);

const TYPE_KEYWORDS = new Map<TokenKind, VarType>([
  [TokenKind.TypeInt,    "int"],
  [TokenKind.TypeBool,   "bool"],
  [TokenKind.TypeString, "string"],
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

  /** Skip only newlines, leaving comment tokens in the stream. */
  private skipNewlines(): void {
    while (this.check(TokenKind.Newline)) this.advance();
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

    const result: PluginNode = {
      kind: "Plugin",
      span: defToken.span, // updated at end
      displayName,
      metadata,
      matchBlock: null,
      configBlock: null,
      globalsBlock: null,
      functions: [],
      defs: [],
      handlers: [],
    };

    this.skipTrivia();

    while (!this.check(TokenKind.End) && !this.check(TokenKind.EOF)) {
      // Config block
      if (this.check(TokenKind.Config)) {
        result.configBlock = this.parseConfigBlock();
        this.skipTrivia();
        continue;
      }

      // Other sub-blocks with do...end are skipped for now
      if (SKIP_BLOCK_STARTERS.has(this.peek().kind)) {
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
    result.span = mergeSpan(defToken.span, endToken?.span ?? defToken.span);

    return result;
  }

  // --- Config block ----------------------------------------------------------

  private parseConfigBlock(): ConfigBlockNode {
    const kwToken = this.advance(); // consume `config`
    this.expect(TokenKind.Do, "after `config`");
    this.skipInlineComment();

    const declarations: ConfigDecl[] = [];
    let pendingLabel: string | null = null;

    // Inside a config block we manage trivia manually so that a `# comment`
    // immediately above a declaration is captured as its label.
    // TODO: Expand this to include multi-line doc comments
    while (!this.check(TokenKind.End) && !this.check(TokenKind.EOF)) {
      this.skipNewlines();

      if (this.check(TokenKind.End) || this.check(TokenKind.EOF)) break;

      // A comment on its own line becomes the label for the next declaration.
      if (this.check(TokenKind.Comment)) {
        pendingLabel = this.advance().value;
        continue;
      }

      // Type keyword starts a declaration.
      if (TYPE_KEYWORDS.has(this.peek().kind)) {
        const decl = this.parseConfigDecl(pendingLabel);
        if (decl) declarations.push(decl);
        pendingLabel = null;
        continue;
      }

      // Anything else is unexpected, skip
      const t = this.advance();
      this.diagnostics.push(langError(`Unexpected token \`${t.kind}\` in config block`, t.span));
      pendingLabel = null;
    }

    const endToken = this.eat(TokenKind.End);

    return {
      kind: "ConfigBlock",
      span: mergeSpan(kwToken.span, endToken?.span ?? kwToken.span),
      declarations,
    };
  }

  private parseConfigDecl(label: string | null): ConfigDecl | null {
    const typeToken = this.advance();
    const varType = TYPE_KEYWORDS.get(typeToken.kind)!;

    if (!this.check(TokenKind.Identifier)) {
      this.diagnostics.push(langError("Expected identifier after type in config declaration", this.peek().span));
      this.skipToNextLine();
      return null;
    }

    const nameToken = this.advance();
    this.expect(TokenKind.Assign, `after config name \`${nameToken.value}\``);

    const defaultExpr = this.parseScalarValue();
    if (!defaultExpr) {
      this.diagnostics.push(langError(`Expected default value for config \`${nameToken.value}\``, this.peek().span));
      this.skipToNextLine();
      return null;
    }

    // Optional trailing kwargs: `, key: value, key: value`
    const constraints: Record<string, Expr> = {};
    while (this.check(TokenKind.Comma)) {
      this.advance(); // consume `,`

      if (!this.check(TokenKind.Identifier)) break;
      const kwKey = this.advance().value;

      this.expect(TokenKind.Colon, `after constraint key \`${kwKey}\``);

      const kwVal = this.parseScalarValue();
      if (!kwVal) {
        this.diagnostics.push(langError(`Expected value for constraint \`${kwKey}\``, this.peek().span));
        break;
      }
      constraints[kwKey] = kwVal;
    }

    const lastSpan = Object.values(constraints).at(-1)?.span ?? defaultExpr.span;

    return {
      kind: "ConfigDecl",
      span: mergeSpan(typeToken.span, lastSpan),
      label,
      varType,
      name: nameToken.value,
      default: defaultExpr,
      constraints,
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

    // Bare identifier (e.g. `type ble_driver` in metadata)
    if (t.kind === TokenKind.Identifier) {
      this.advance();
      return { kind: "Identifier", name: t.value, span: t.span } satisfies IdentifierExpr;
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

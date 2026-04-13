import type { Token } from "./token.js";
import { TokenKind } from "./token.js";
import type { PluginNode, MetadataFieldNode, Expr, LiteralExpr, IdentifierExpr, ConfigBlockNode, ConfigDecl, GlobalsBlockNode, GlobalDecl, DefNode, DefParam, VarType, FnNode, OnNode, Stmt, LocalDeclStmt, BinaryOp, GlobalVarExpr, AccumulatorExpr, ErrorCodeExpr, ConfigRefExpr, CallExpr, BinaryExpr, UnaryExpr } from "./ast.js";
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
  TokenKind.On,
]);

const TYPE_KEYWORDS = new Map<TokenKind, VarType>([
  [TokenKind.TypeInt,    "int"],
  [TokenKind.TypeBool,   "bool"],
  [TokenKind.TypeString, "string"],
]);

/**
 * Binary operator precedence table for the Pratt expression parser.
 * Higher numbers bind tighter. Left-associative: right side parses at prec+1.
 */
const BINARY_OPS = new Map<TokenKind, { prec: number; op: BinaryOp }>([
  [TokenKind.Or,     { prec: 1, op: "or"  }],
  [TokenKind.And,    { prec: 2, op: "and" }],
  [TokenKind.EqEq,   { prec: 3, op: "==" }],
  [TokenKind.NotEq,  { prec: 3, op: "!=" }],
  [TokenKind.Gte,    { prec: 3, op: ">=" }],
  [TokenKind.Lte,    { prec: 3, op: "<=" }],
  [TokenKind.Gt,     { prec: 3, op: ">"  }],
  [TokenKind.Lt,     { prec: 3, op: "<"  }],
  [TokenKind.Concat, { prec: 4, op: "<>" }],
  [TokenKind.Plus,   { prec: 5, op: "+"  }],
  [TokenKind.Minus,  { prec: 5, op: "-"  }],
  [TokenKind.Star,   { prec: 6, op: "*"  }],
  [TokenKind.Slash,  { prec: 6, op: "/"  }],
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

    // Doc comments accumulate until consumed by a `def` or `fn` block.
    // Any other construct clears them.
    let pendingDocs: string[] = [];

    while (!this.check(TokenKind.End) && !this.check(TokenKind.EOF)) {
      this.skipNewlines();

      if (this.check(TokenKind.End) || this.check(TokenKind.EOF)) break;

      // Accumulate comment lines as potential doc comments for the next def.
      if (this.check(TokenKind.Comment)) {
        pendingDocs.push(this.advance().value);
        continue;
      }

      // Config block
      if (this.check(TokenKind.Config)) {
        pendingDocs = [];
        result.configBlock = this.parseConfigBlock();
        continue;
      }

      // Globals block
      if (this.check(TokenKind.Globals)) {
        pendingDocs = [];
        result.globalsBlock = this.parseGlobalsBlock();
        continue;
      }

      // def block, consuming any accumulated doc comments
      if (this.check(TokenKind.Def)) {
        const docs = pendingDocs;
        pendingDocs = [];
        const def = this.parseDefBlock(docs);
        if (def) result.defs.push(def);
        continue;
      }

      // fn expression
      if (this.check(TokenKind.Fn)) {
        const docs = pendingDocs;
        pendingDocs = [];
        const fn = this.parseFnExpression(docs);
        if (fn) result.functions.push(fn);
        continue;
      }

      // on ... event handler block
      if (this.check(TokenKind.On)) {
        pendingDocs = [];
        const handler = this.parseOnNode();
        if (handler) result.handlers.push(handler);
        continue;
      }

      // Other sub-blocks with do...end are skipped for now
      if (SKIP_BLOCK_STARTERS.has(this.peek().kind)) {
        pendingDocs = [];
        this.skipDoBlock();
        continue;
      }

      // Metadata field: identifier value
      if (this.check(TokenKind.Identifier)) {
        pendingDocs = [];
        const field = this.parseMetadataField();
        if (field) metadata.push(field);
        continue;
      }

      // Unexpected token, skip and recover
      pendingDocs = [];
      const t = this.advance();
      this.diagnostics.push(langError(`Unexpected token \`${t.kind}\` in defplugin body`, t.span));
    }

    const endToken = this.eat(TokenKind.End);
    result.span = mergeSpan(defToken.span, endToken?.span ?? defToken.span);

    return result;
  }

  // --- Def block -------------------------------------------------------------

  private parseDefBlock(docs: string[]): DefNode | null {
    const kwToken = this.advance(); // consume `def`

    if (!this.check(TokenKind.Identifier)) {
      this.diagnostics.push(langError("Expected function name after `def`", this.peek().span));
      this.skipDoBlock();

      return null;
    }

    const nameToken = this.advance();
    const params = this.parseDefParams();

    this.expect(TokenKind.Do, `after \`def ${nameToken.value}(...)\``);
    this.skipInlineComment();

    const body = this.parseBlockBody();
    const endToken = this.eat(TokenKind.End);

    return {
      kind: "Def",
      span: mergeSpan(kwToken.span, endToken?.span ?? kwToken.span),
      docs,
      name: nameToken.value,
      params,
      body,
    };
  }

  /** Parse `(type name, type name, ...)`, returning an empty array on failure. */
  private parseDefParams(): DefParam[] {
    if (!this.check(TokenKind.LParen)) {
      this.diagnostics.push(langError("Expected `(` to open parameter list", this.peek().span));
      return [];
    }

    this.advance(); // consume `(`
    const params: DefParam[] = [];

    while (!this.check(TokenKind.RParen) && !this.check(TokenKind.EOF)) {
      if (!TYPE_KEYWORDS.has(this.peek().kind)) {
        this.diagnostics.push(langError("Expected type keyword in parameter list", this.peek().span));
        // skip to `)` to recover
        while (!this.check(TokenKind.RParen) && !this.check(TokenKind.EOF)) this.advance();
        break;
      }

      const typeToken = this.advance();
      const varType = TYPE_KEYWORDS.get(typeToken.kind)!;

      if (!this.check(TokenKind.Identifier)) {
        this.diagnostics.push(langError("Expected parameter name after type", this.peek().span));
        while (!this.check(TokenKind.RParen) && !this.check(TokenKind.EOF)) this.advance();
        break;
      }

      const nameToken = this.advance();
      params.push({ varType, name: nameToken.value });
      this.eat(TokenKind.Comma);
    }

    this.expect(TokenKind.RParen, "to close parameter list");
    return params;
  }

  // --- fn expression ---------------------------------------------------------
  // TODO: Design review: Should we treat fn as macros since it is a distinct expression?
  /** Parse `fn name = (type arg, ...) -> expr` — single-expression function. */
  private parseFnExpression(docs: string[]): FnNode | null {
    const kwToken = this.advance(); // consume `fn`

    if (!this.check(TokenKind.Identifier)) {
      this.diagnostics.push(langError("Expected function name after `fn`", this.peek().span));
      this.skipToNextLine();
      return null;
    }

    const nameToken = this.advance();

    this.expect(TokenKind.Assign, `after \`fn ${nameToken.value}\``);

    const params = this.parseDefParams();

    this.expect(TokenKind.Arrow, `after \`fn ${nameToken.value}(...)\``);

    const bodyExpr = this.parseExpr();
    if (!bodyExpr) {
      this.diagnostics.push(langError(`Expected expression for fn body of \`${nameToken.value}\``, this.peek().span));
      this.skipToNextLine();
      return null;
    }

    return {
      kind: "Fn",
      span: mergeSpan(kwToken.span, bodyExpr.span),
      docs,
      name: nameToken.value,
      params,
      body: bodyExpr,
    };
  }

  // --- Event handlers ---------------------------------------------------------

  /** Parse `on :event do ... end` — event handler. `event` is the atom name without `:`. */
  private parseOnNode(): OnNode | null {
    const kwToken = this.advance(); // consume `on`

    if (!this.check(TokenKind.Atom)) {
      this.diagnostics.push(langError("Expected event name after `on`", this.peek().span));
      this.skipToNextLine();
      return null;
    }

    const eventToken = this.advance();

    this.expect(TokenKind.Do, `after \`on :${eventToken.value}\``);
    this.skipInlineComment();

    const body = this.parseBlockBody();
    const endToken = this.eat(TokenKind.End);

    return {
      kind: "On",
      span: mergeSpan(kwToken.span, endToken?.span ?? kwToken.span),
      event: eventToken.value,
      body,
    };
  }

  // --- Globals block ---------------------------------------------------------

  private parseGlobalsBlock(): GlobalsBlockNode {
    const kwToken = this.advance(); // consume `globals`
    this.expect(TokenKind.Do, "after `globals`");
    this.skipInlineComment();

    const declarations: GlobalDecl[] = [];
    let pendingLabel: string | null = null;

    while (!this.check(TokenKind.End) && !this.check(TokenKind.EOF)) {
      this.skipNewlines();

      if (this.check(TokenKind.End) || this.check(TokenKind.EOF)) break;

      // A comment on its own line becomes the label for the next declaration.
      if (this.check(TokenKind.Comment)) {
        pendingLabel = this.advance().value;
        continue;
      }

      if (TYPE_KEYWORDS.has(this.peek().kind)) {
        const decl = this.parseGlobalDecl(pendingLabel);
        if (decl) declarations.push(decl);
        pendingLabel = null;
        continue;
      }

      const t = this.advance();
      this.diagnostics.push(langError(`Unexpected token \`${t.kind}\` in globals block`, t.span));
      pendingLabel = null;
    }

    const endToken = this.eat(TokenKind.End);

    return {
      kind: "GlobalsBlock",
      span: mergeSpan(kwToken.span, endToken?.span ?? kwToken.span),
      declarations,
    };
  }

  private parseGlobalDecl(label: string | null): GlobalDecl | null {
    const typeToken = this.advance();
    const varType = TYPE_KEYWORDS.get(typeToken.kind)!;

    // Optional array size: `int[4] name`
    let arraySize: number | null = null;

    if (this.check(TokenKind.LBracket)) {
      this.advance();
      const sizeToken = this.peek();

      if (sizeToken.kind === TokenKind.Integer) {
        arraySize = parseInt(sizeToken.value, 10);
        this.advance();
      } else {
        this.diagnostics.push(langError("Expected integer array size", sizeToken.span));
      }

      this.expect(TokenKind.RBracket, "after array size");
    }

    if (!this.check(TokenKind.Identifier)) {
      this.diagnostics.push(langError("Expected identifier in globals declaration", this.peek().span));
      this.skipToNextLine();

      return null;
    }

    const nameToken = this.advance();

    this.expect(TokenKind.Assign, `after global name \`${nameToken.value}\``);

    const initExpr = this.parseScalarValue();
    
    if (!initExpr) {
      this.diagnostics.push(langError(`Expected initializer for global \`${nameToken.value}\``, this.peek().span));
      this.skipToNextLine();

      return null;
    }

    return {
      kind: "GlobalDecl",
      span: mergeSpan(typeToken.span, initExpr.span),
      label,
      varType,
      name: nameToken.value,
      arraySize,
      init: initExpr,
    };
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

  // --- Expression parsing (Pratt) -------------------------------------------

  /**
   * Parse a full expression using Pratt (top-down operator precedence) parsing.
   * `minPrec` is the minimum precedence level to consume on the right side;
   * callers pass 0 for a top-level expression.
   * Returns null without consuming tokens if no expression is found.
   */
  private parseExpr(minPrec = 0): Expr | null {
    let left = this.parsePrimary();
    if (left === null) return null;

    while (true) {
      const rule = BINARY_OPS.get(this.peek().kind);
      if (!rule || rule.prec <= minPrec) break;

      const opToken = this.advance();
      const right = this.parseExpr(rule.prec); // left-associative

      if (right === null) {
        this.diagnostics.push(
          langError(`Expected expression after \`${opToken.value}\``, opToken.span),
        );
        break;
      }

      left = {
        kind: "Binary",
        op: rule.op,
        left,
        right,
        span: mergeSpan(left.span, right.span),
      } satisfies BinaryExpr;
    }

    return left;
  }

  /** Parse the non-operator (primary) prefix of an expression. */
  private parsePrimary(): Expr | null {
    const t = this.peek();

    // Parenthesized group
    if (t.kind === TokenKind.LParen) {
      const open = this.advance();
      const inner = this.parseExpr(0);

      if (inner === null) {
        this.diagnostics.push(langError("Expected expression inside parentheses", this.peek().span));
        this.eat(TokenKind.RParen);
        return null;
      }

      this.expect(TokenKind.RParen, "to close parenthesized expression");
      // Preserve the span of the inner expression (parens are not a node).
      return { ...inner, span: mergeSpan(open.span, this.tokens[this.pos - 1]?.span ?? inner.span) };
    }

    // Unary `not`
    if (t.kind === TokenKind.Not) {
      this.advance();
      const operand = this.parsePrimary();

      if (!operand) {
        this.diagnostics.push(langError("Expected expression after `not`", this.peek().span));
        return null;
      }

      return { kind: "Unary", op: "not", operand, span: mergeSpan(t.span, operand.span) } satisfies UnaryExpr;
    }

    // Unary minus
    if (t.kind === TokenKind.Minus) {
      this.advance();
      const operand = this.parsePrimary();

      if (!operand) {
        this.diagnostics.push(langError("Expected expression after unary `-`", this.peek().span));
        return null;
      }

      return { kind: "Unary", op: "-", operand, span: mergeSpan(t.span, operand.span) } satisfies UnaryExpr;
    }

    // Literals
    if (t.kind === TokenKind.StringLit) {
      this.advance();
      return { kind: "Literal", varType: "string", value: t.value, span: t.span } satisfies LiteralExpr;
    }

    if (t.kind === TokenKind.Integer) {
      this.advance();
      return { kind: "Literal", varType: "int", value: parseInt(t.value, 10), span: t.span } satisfies LiteralExpr;
    }

    if (t.kind === TokenKind.Float) {
      this.advance();
      return { kind: "Literal", varType: "int", value: parseFloat(t.value), span: t.span } satisfies LiteralExpr;
    }

    if (t.kind === TokenKind.True) {
      this.advance();
      return { kind: "Literal", varType: "bool", value: true, span: t.span } satisfies LiteralExpr;
    }

    if (t.kind === TokenKind.False) {
      this.advance();
      return { kind: "Literal", varType: "bool", value: false, span: t.span } satisfies LiteralExpr;
    }

    // Sigils
    if (t.kind === TokenKind.GlobalVar) {
      this.advance();
      return { kind: "GlobalVar", name: t.value, span: t.span } satisfies GlobalVarExpr;
    }

    if (t.kind === TokenKind.Accumulator) {
      this.advance();
      return { kind: "Accumulator", span: t.span } satisfies AccumulatorExpr;
    }

    if (t.kind === TokenKind.ErrorCode) {
      this.advance();
      return { kind: "ErrorCode", span: t.span } satisfies ErrorCodeExpr;
    }

    if (t.kind === TokenKind.ConfigRef) {
      this.advance();
      return { kind: "ConfigRef", name: t.value, span: t.span } satisfies ConfigRefExpr;
    }

    // Named call or bare identifier
    if (t.kind === TokenKind.Identifier) {
      this.advance();

      if (this.check(TokenKind.LParen)) {
        const args = this.parseCallArgs();
        return {
          kind: "Call",
          name: t.value,
          args,
          span: mergeSpan(t.span, this.tokens[this.pos - 1]?.span ?? t.span),
        } satisfies CallExpr;
      }
      
      return { kind: "Identifier", name: t.value, span: t.span } satisfies IdentifierExpr;
    }

    return null;
  }

  /** Parse `(expr, expr, ...)` — the argument list of a call expression. */
  private parseCallArgs(): Expr[] {
    this.advance(); // consume `(`
    const args: Expr[] = [];

    while (
      !this.check(TokenKind.RParen) &&
      !this.check(TokenKind.EOF) &&
      !this.check(TokenKind.Newline)
    ) {
      const arg = this.parseExpr(0);
      if (arg) args.push(arg);
      if (!this.eat(TokenKind.Comma)) break;
    }

    this.expect(TokenKind.RParen, "to close argument list");
    return args;
  }

  // --- Block body (partial — local declarations only) -----------------------

  /**
   * Scans a `do...end` body that has already had its opening `do` consumed.
   * Recognizes local variable declarations (`type name` / `type name = expr`)
   * and collects them as `LocalDeclStmt` nodes. All other statements are
   * skipped token-by-token with nested `do...end` depth tracking.
   *
   * A `# comment` on its own line immediately before a declaration is captured
   * as the declaration's `label` for future IDE hover support.
   *
   * Stops when the matching `end` is found, leaving it in the stream for
   * the caller to consume with `eat(End)`.
   */
  private parseBlockBody(): Stmt[] {
    const stmts: Stmt[] = [];
    let depth = 1;
    let pendingLabel: string | null = null;

    while (depth > 0 && !this.check(TokenKind.EOF)) {
      this.skipNewlines();

      if (this.check(TokenKind.EOF)) break;

      if (this.check(TokenKind.Do)) {
        depth++;
        pendingLabel = null;
        this.advance();
        continue;
      }

      if (this.check(TokenKind.End)) {
        depth--;
        pendingLabel = null;
        // Leave the final `end` for the caller; consume inner ends.
        if (depth > 0) this.advance();
        continue;
      }

      // Capture comment-as-label at the top level of this body only.
      if (depth === 1 && this.check(TokenKind.Comment)) {
        pendingLabel = this.advance().value;
        continue;
      }

      // At the top level, try to parse local variable declarations.
      if (depth === 1 && TYPE_KEYWORDS.has(this.peek().kind)) {
        const decl = this.parseLocalDecl(pendingLabel);
        if (decl) stmts.push(decl);
        pendingLabel = null;
        continue;
      }

      // All other tokens — skip one at a time (depth tracking continues above).
      pendingLabel = null;
      this.advance();
    }

    return stmts;
  }

  /** Parse `type name` or `type name = expr` as a local variable declaration. */
  private parseLocalDecl(label: string | null): LocalDeclStmt | null {
    const typeToken = this.advance();
    const varType = TYPE_KEYWORDS.get(typeToken.kind)!;

    if (!this.check(TokenKind.Identifier)) {
      this.diagnostics.push(
        langError("Expected name after type in local declaration", this.peek().span),
      );
      this.skipToNextLine();
      return null;
    }

    const nameToken = this.advance();
    let init: Expr | null = null;

    if (this.check(TokenKind.Assign)) {
      this.advance(); // consume `=`
      init = this.parseExpr();
      if (!init) {
        this.diagnostics.push(
          langError(
            `Expected value after \`=\` in declaration of \`${nameToken.value}\``,
            this.peek().span,
          ),
        );
        this.skipToNextLine();
        return null;
      }
    }

    this.skipInlineComment();

    return {
      kind: "LocalDecl",
      span: mergeSpan(typeToken.span, init?.span ?? nameToken.span),
      label,
      varType,
      name: nameToken.value,
      init,
    };
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

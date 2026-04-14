import type { Token } from "./token.js";
import { TokenKind } from "./token.js";

import type { 
  PluginNode, 
  MetadataFieldNode, 
  Expr, 
  LiteralExpr, 
  IdentifierExpr, 
  IndexExpr,
  ConfigBlockNode, 
  ConfigDecl, 
  GlobalsBlockNode, 
  GlobalDecl, 
  DefNode, 
  DefParam, 
  VarType, 
  FnNode, 
  OnNode, 
  Stmt, 
  LocalDeclStmt, 
  AssignLocalStmt, 
  AssignGlobalStmt, 
  ExprStmt, 
  IfStmt, 
  ReturnStmt, 
  ConditionalStmt, 
  BinaryOp, 
  GlobalVarExpr, 
  AccumulatorExpr, 
  ErrorCodeExpr, 
  ConfigRefExpr, 
  CallExpr, 
  BinaryExpr, 
  UnaryExpr, 
  PipeExpr, 
  PipeStep 
} from "./ast.js";

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

/**
 * Returns `true` if the given token can appear as the start of a primary
 * expression. Used to disambiguate paren-free calls (`name expr`) from
 * bare identifiers at statement level.
 * 
 * TODO: Trace usage to evaluate necessity, since a statement level arg-less
 * fn call needs parens, and variable access is not effectful so a bare var 
 * has no meaning.
 */
function canStartExpr(t: Token): boolean {
  switch (t.kind) {
    case TokenKind.StringLit:
    case TokenKind.Integer:
    case TokenKind.Float:
    case TokenKind.True:
    case TokenKind.False:
    case TokenKind.GlobalVar:
    case TokenKind.Accumulator:
    case TokenKind.ErrorCode:
    case TokenKind.ConfigRef:
    case TokenKind.Identifier:
    case TokenKind.LParen:
    case TokenKind.Minus:
    case TokenKind.Not:
      return true;
    default:
      return false;
  }
}

// --- Parser class -------------------------------------------------------------

class Parser {
  private pos = 0;
  private readonly diagnostics: LangDiagnostic[] = [];

  constructor(private readonly tokens: Token[]) {}

  parse(): ParseResult {
    this.consumeTrivia();

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

  /** Peek at the token `offset` positions ahead of the current position. */
  private peekAhead(offset: number): Token {
    return this.tokens[this.pos + offset] ?? { kind: TokenKind.EOF, value: "", span: NULL_SPAN };
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

  /**
   * Consume `do` and enforce that the remainder of the line contains only
   * whitespace or comments — no code is allowed after `do`.
   */
  private expectDoAndNewline(context: string): Token {
    const doToken = this.expect(TokenKind.Do, context);

    // After `do`, only comments and newlines are allowed on the same line.
    const next = this.peek();
    if (
      next.kind !== TokenKind.Newline &&
      next.kind !== TokenKind.Comment &&
      next.kind !== TokenKind.EOF &&
      next.kind !== TokenKind.End
    ) {
      this.diagnostics.push(
        langError("Unexpected token after `do`, only comments are allowed", next.span),
      );
    }

    return doToken;
  }

  /**
   * Consume inter-statement trivia (newlines and comments). Returns accumulated
   * doc-comment lines. A blank line (two consecutive newlines) resets the
   * accumulator, so only comments immediately preceding a construct survive.
   * 
   * TODO: Future - the doc parser that consumes this would parse @/token statements into KVP token/value
   * to handle things like @/arg or @/deprecated 
   */
  private consumeTrivia(): string[] {
    let docs: string[] = [];

    while (this.check(TokenKind.Newline) || this.check(TokenKind.Comment)) {
      if (this.check(TokenKind.Comment)) {
        docs.push(this.advance().value);
      } else {
        this.advance();

        if (docs.length > 0 && this.check(TokenKind.Newline)) {
          docs = [];
        }
      }
    }

    return docs;
  }

  // --- Plugin ----------------------------------------------------------------

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

    this.expectDoAndNewline("after defplugin display name");

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

    while (!this.check(TokenKind.End) && !this.check(TokenKind.EOF)) {
      const docs = this.consumeTrivia();
      if (this.check(TokenKind.End) || this.check(TokenKind.EOF)) break;

      // Config block
      if (this.check(TokenKind.Config)) {
        result.configBlock = this.parseConfigBlock();
        continue;
      }

      // Globals block
      if (this.check(TokenKind.Globals)) {
        result.globalsBlock = this.parseGlobalsBlock();
        continue;
      }

      // def block
      if (this.check(TokenKind.Def)) {
        const def = this.parseDefBlock(docs);
        if (def) result.defs.push(def);
        continue;
      }

      // fn expression
      if (this.check(TokenKind.Fn)) {
        const fn = this.parseFnExpression(docs);
        if (fn) result.functions.push(fn);
        continue;
      }

      // on ... event handler block
      if (this.check(TokenKind.On)) {
        const handler = this.parseOnNode();
        if (handler) result.handlers.push(handler);
        continue;
      }

      // Other sub-blocks with do...end are skipped for now
      if (SKIP_BLOCK_STARTERS.has(this.peek().kind)) {
        this.skipDoBlock();
        continue;
      }

      // Metadata field: identifier value
      if (this.check(TokenKind.Identifier)) {
        const field = this.parseMetadataField();
        if (field) metadata.push(field);
        continue;
      }

      // Unexpected token, skip and recover
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

    // Optional return type annotation: `: type`
    let returnType: VarType | null = null;

    if (this.check(TokenKind.Colon)) {
      this.advance(); // consume `:`

      if (TYPE_KEYWORDS.has(this.peek().kind)) {
        returnType = TYPE_KEYWORDS.get(this.advance().kind)!;
      } else {
        this.diagnostics.push(langError("Expected type keyword after `:` in return type", this.peek().span));
      }
    }

    this.expectDoAndNewline(`after \`def ${nameToken.value}(...)\``);

    const body = this.parseBlockBody(false);
    const endToken = this.eat(TokenKind.End);

    return {
      kind: "Def",
      span: mergeSpan(kwToken.span, endToken?.span ?? kwToken.span),
      docs,
      name: nameToken.value,
      nameSpan: nameToken.span,
      params,
      returnType,
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
      params.push({ varType, name: nameToken.value, span: nameToken.span });
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

    // Optional return type annotation: `: type`
    let returnType: VarType | null = null;

    if (this.check(TokenKind.Colon)) {
      this.advance(); // consume `:`
      if (TYPE_KEYWORDS.has(this.peek().kind)) {
        returnType = TYPE_KEYWORDS.get(this.advance().kind)!;
      } else {
        this.diagnostics.push(langError("Expected type keyword after `:` in return type", this.peek().span));
      }
    }

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
      nameSpan: nameToken.span,
      params,
      returnType,
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

    this.expectDoAndNewline(`after \`on :${eventToken.value}\``);

    const body = this.parseBlockBody(false);
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
    this.expectDoAndNewline("after `globals`");

    const declarations: GlobalDecl[] = [];

    while (!this.check(TokenKind.End) && !this.check(TokenKind.EOF)) {
      const docs = this.consumeTrivia();
      if (this.check(TokenKind.End) || this.check(TokenKind.EOF)) break;

      if (TYPE_KEYWORDS.has(this.peek().kind)) {
        const decl = this.parseGlobalDecl(docs.length > 0 ? docs.join("\n") : null);

        if (decl) declarations.push(decl);
        continue;
      }

      const t = this.advance();
      this.diagnostics.push(langError(`Unexpected token \`${t.kind}\` in globals block`, t.span));
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

      if (varType !== "int") {
        this.diagnostics.push(
          langError("Only `int` arrays are supported", typeToken.span),
        );
      }
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
      nameSpan: nameToken.span,
      arraySize,
      init: initExpr,
    };
  }

  // --- Config block ----------------------------------------------------------

  private parseConfigBlock(): ConfigBlockNode {
    const kwToken = this.advance(); // consume `config`
    this.expectDoAndNewline("after `config`");

    const declarations: ConfigDecl[] = [];

    while (!this.check(TokenKind.End) && !this.check(TokenKind.EOF)) {
      const docs = this.consumeTrivia();
      if (this.check(TokenKind.End) || this.check(TokenKind.EOF)) break;

      // Type keyword starts a declaration.
      if (TYPE_KEYWORDS.has(this.peek().kind)) {
        const decl = this.parseConfigDecl(docs.length > 0 ? docs.join("\n") : null);

        if (decl) declarations.push(decl);
        continue;
      }

      // Anything else is unexpected, skip
      const t = this.advance();
      this.diagnostics.push(langError(`Unexpected token \`${t.kind}\` in config block`, t.span));
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
      nameSpan: nameToken.span,
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

    // Binary operators
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

    // Pipe chain: `expr |> call() |> call() ...`
    // Pipes are collected here rather than via the binary-op table because each
    // step must be a call (not an arbitrary expression), and we want to carry
    // type context per-step.
    if (this.check(TokenKind.Pipe)) {
      const steps: PipeStep[] = [];

      while (this.check(TokenKind.Pipe)) {
        this.advance(); // consume `|>`

        // A pipe step must be a call expression: `name(args...)` or bare `name`
        // (bare = zero-arg call shorthand).
        const nameTok = this.peek();
        if (nameTok.kind !== TokenKind.Identifier) {
          this.diagnostics.push(
            langError("Expected function name after `|>`", nameTok.span),
          );
          break;
        }
        this.advance(); // consume name

        let args: Expr[] = [];
        if (this.check(TokenKind.LParen)) {
          args = this.parseCallArgs();
        }

        const callSpan = mergeSpan(nameTok.span, this.peekAhead(-1).span);
        const call: CallExpr = { kind: "Call", name: nameTok.value, args, span: callSpan };
        steps.push({ call, carriedType: "unknown" });
      }

      return {
        kind: "Pipe",
        head: left,
        steps,
        span: mergeSpan(left.span, steps.at(-1)?.call.span ?? left.span),
      } satisfies PipeExpr;
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
      return { ...inner, span: mergeSpan(open.span, this.peekAhead(-1).span) };
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
      return { kind: "Literal", varType: "float", value: parseFloat(t.value), span: t.span } satisfies LiteralExpr;
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
      let expr: Expr = { kind: "GlobalVar", name: t.value, span: t.span } satisfies GlobalVarExpr;

      // Postfix index: `$name[expr]`
      if (this.check(TokenKind.LBracket)) {
        expr = this.parseIndexSuffix(expr);
      }

      return expr;
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
          span: mergeSpan(t.span, this.peekAhead(-1).span),
        } satisfies CallExpr;
      }

      let expr: Expr = { kind: "Identifier", name: t.value, span: t.span } satisfies IdentifierExpr;

      // Postfix index: `name[expr]`
      if (this.check(TokenKind.LBracket)) {
        expr = this.parseIndexSuffix(expr);
      }

      return expr;
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

  /** Parse `[expr]` suffix on an already-parsed target expression. */
  private parseIndexSuffix(target: Expr): IndexExpr {
    this.advance(); // consume `[`
    const index = this.parseExpr(0);

    if (!index) {
      this.diagnostics.push(langError("Expected index expression inside `[]`", this.peek().span));
    }

    const closeBracket = this.peek();
    this.expect(TokenKind.RBracket, "to close index expression");

    return {
      kind: "Index",
      target,
      index: index ?? { kind: "Literal", varType: "int", value: 0, span: closeBracket.span },
      span: mergeSpan(target.span, closeBracket.span),
    };
  }

  // --- Block body ------------------------------------------------------------

  /**
   * Parse a `do...end` body that has already had its opening `do` consumed.
   * Uses `consumeTrivia()` to handle inter-statement whitespace and accumulate
   * doc comments for the following declaration. Stops (without consuming) when
   * a stop token (`end`, `EOF`, or any extra kinds from `stopAt`) is reached.
   *
   * When `insideControlFlow` is true, local variable declarations are rejected
   * with a diagnostic. Variables must be declared at the top of a `def` or `on`
   * block only.
   */
  private parseBlockBody(insideControlFlow: boolean, ...stopAt: TokenKind[]): Stmt[] {
    const stopSet = new Set([TokenKind.End, TokenKind.EOF, ...stopAt]);
    const stmts: Stmt[] = [];

    while (true) {
      const docs = this.consumeTrivia();
      if (stopSet.has(this.peek().kind)) break;

      const stmt = this.parseStmt(docs, insideControlFlow);
      if (stmt !== null) stmts.push(stmt);
    }

    return stmts;
  }

  /**
   * Parse one statement. `docs` are accumulated doc-comment lines from the
   * preceding trivia, and are passed to statements that support them.
   *
   * When `insideControlFlow` is true, local variable declarations are rejected.
   */
  private parseStmt(docs: string[], insideControlFlow = false): Stmt | null {
    let t = this.peek();
    let statementIsConst = false;

    if (t.kind === TokenKind.End || t.kind === TokenKind.Else || t.kind === TokenKind.EOF) return null;

    // Const-qualified local: `const type name = expr`
    if (t.kind === TokenKind.Const) {
      statementIsConst = true;
      this.advance(); // consume `const`
      t = this.peek();
    }

    // Local variable declaration: `type name` / `type name = expr`
    if (TYPE_KEYWORDS.has(t.kind)) {
      if (insideControlFlow) {
        this.diagnostics.push(
          langError(
            "Variable declarations must only be at the top level of a `def` or `on` block",
            t.span,
          ),
        );

        this.skipToNextLine();
        return null;
      }

      const stmt = this.parseLocalDecl(docs, statementIsConst);
      if (stmt === null) return null;

      if (statementIsConst && stmt.init === null) {
        this.diagnostics.push(
          langError("`const` declarations must have an initializer", stmt.nameSpan),
        );
      }

      // Declarations cannot have postfix guards — error and recover
      if (this.check(TokenKind.If) || this.check(TokenKind.Unless)) {
        this.diagnostics.push(
          langError("Declaration cannot have a trailing condition, use a conditional assignment instead", this.peek().span),
        );

        this.skipToNextLine();
      }

      return stmt;
    } else if (statementIsConst) {
      this.diagnostics.push(
        langError("Expected type keyword after `const`, got: " + t.value, t.span),
      );

      this.skipToNextLine();
      return null;
    }

    // Unknown block-like construct: `identifier ... do ... end` (e.g. `while`, `for`)
    // Lookahead on the current line: if `do` is found before a newline, skip it.
    if (t.kind === TokenKind.Identifier && this.hasDoOnCurrentLine()) {
      this.diagnostics.push(langError(`Unsupported block statement \`${t.value}\``, t.span));
      this.skipDoBlock();
      return null;
    }

    // Block if: `if cond do ... [else ...] end`
    // TODO: This has an older draft for a pure inline IF syntax, but I think for simplicity we should evaluate
    // disallowing full inline, and error after the "do" on any other non-comment tokens.
    if (t.kind === TokenKind.If) {
      const s = this.parseIfStmt();
      if (s === null) return null;

      // Nothing meaningful should follow `end` on the same line
      const after = this.peek();

      // TODO: This should be a list of valid post-do line ending tokens:
      if (after.kind !== TokenKind.Newline && after.kind !== TokenKind.Comment &&
          after.kind !== TokenKind.EOF && after.kind !== TokenKind.End &&
          after.kind !== TokenKind.Else) {
        this.diagnostics.push(
          langError(`Unexpected \`${after.value || after.kind}\` after block, only a comment may follow \`end\``, after.span),
        );

        this.skipToNextLine();
      }
      return s;
    }

    // TODO: Add other block constructs (while, unless, until, etc)
    // TODO: Eventually add "for..in...do"

    // return statement
    if (t.kind === TokenKind.Return) return this.wrapConditional(this.parseReturnStmt());

    // Assignment or expression statement — eligible for postfix conditionals
    const stmt = this.parseAssignOrExprStmt();
    return stmt !== null ? this.wrapConditional(stmt) : null;
  }

  /**
   * Parse an assignment (`name = expr`, `$name = expr`) or expression
   * statement, including paren-free calls (`log "msg"`, `setLevel @cfg`).
   */
  private parseAssignOrExprStmt(): Stmt | null {
    const t = this.peek();
    const ahead = this.peekAhead(1);

    // $name = expr  (global assign)
    if (t.kind === TokenKind.GlobalVar && ahead.kind === TokenKind.Assign) {
      const nameTok = this.advance(); // $name
      this.advance();                 // =
      const value = this.parseExpr();

      if (!value) {
        this.diagnostics.push(langError(`Expected value after \`=\` for \`$${nameTok.value}\``, this.peek().span));
        this.skipToNextLine();
        return null;
      }

      return {
        kind: "AssignGlobal",
        name: nameTok.value,
        nameSpan: nameTok.span,
        value,
        span: mergeSpan(nameTok.span, value.span),
      } satisfies AssignGlobalStmt;
    }

    // @name = expr  (config assign — always an error, config is read-only)
    if (t.kind === TokenKind.ConfigRef && ahead.kind === TokenKind.Assign) {
      const nameTok = this.advance(); // @name
      this.advance();                 // =
      // Still parse the value expression to keep the parser in a good state
      this.parseExpr();

      this.diagnostics.push(
        langError(`Cannot assign to config variable \`@${nameTok.value}\`, you must explicitly call \`setConfig("${nameTok.value}", value)\``, nameTok.span),
      );
      return null;
    }

    // name = expr  (local assign)
    if (t.kind === TokenKind.Identifier && ahead.kind === TokenKind.Assign) {
      const nameTok = this.advance(); // name
      this.advance();                 // =
      const value = this.parseExpr();

      if (!value) {
        this.diagnostics.push(langError(`Expected value after \`=\` for \`${nameTok.value}\``, this.peek().span));
        this.skipToNextLine();
        return null;
      }

      return {
        kind: "AssignLocal",
        name: nameTok.value,
        nameSpan: nameTok.span,
        value,
        span: mergeSpan(nameTok.span, value.span),
      } satisfies AssignLocalStmt;
    }

    // Paren-free call: `name expr` is an identifier followed by an expression-starter
    // that is not `(` (which feeds naturally into parsePrimary as a parens call).
    if (t.kind === TokenKind.Identifier && ahead.kind !== TokenKind.LParen && canStartExpr(ahead)) {
      return this.parseParenFreeCallStmt();
    }

    // General expression statement (piped exprs, calls with parens, sigil-led exprs…)
    const expr = this.parseExpr();

    if (!expr) {
      this.diagnostics.push(langError(`Unexpected \`${t.value || t.kind}\` in statement`, t.span));
      this.advance();
      return null;
    }

    if (this.check(TokenKind.Assign)) {
      // Index assignment: `name[expr] = value` or `$name[expr] = value`
      if (expr.kind === "Index") {
        this.advance(); // consume `=`
        const value = this.parseExpr();

        if (!value) {
          this.diagnostics.push(langError("Expected value after `=` in index assignment", this.peek().span));
          this.skipToNextLine();
          return null;
        }

        // Emit as an ExprStmt wrapping a synthetic representation — the emitter
        // will eventually lower this to a `setbyte` action.
        return {
          kind: "ExprStmt",
          expr: { ...expr, span: mergeSpan(expr.span, value.span) },
          span: mergeSpan(expr.span, value.span),
        } satisfies ExprStmt;
      }

      this.diagnostics.push(langError("Unexpected `=` in statement: assignment must be `name = value`", this.peek().span));
      this.skipToNextLine();
      return null;
    }

    return { kind: "ExprStmt", expr, span: expr.span } satisfies ExprStmt;
  }

  /** Parse a paren-free call `name expr` where `expr` is a single argument. */
  private parseParenFreeCallStmt(): Stmt | null {
    const nameTok = this.advance(); // name
    const arg = this.parseExpr();

    // An `=` after the argument is invalid, this is a guard against ruby-like syntax where assigns return
    if (this.check(TokenKind.Assign)) {
      this.diagnostics.push(langError("Unexpected `=` in statement: assignment must be its own expression", this.peek().span));
      this.skipToNextLine();
      return null;
    }

    const args: Expr[] = arg ? [arg] : [];
    const callSpan = mergeSpan(nameTok.span, arg?.span ?? nameTok.span);

    const call: CallExpr = { 
      kind: "Call", 
      name: nameTok.value, 
      args, 
      span: callSpan 
    };

    return { kind: "ExprStmt", expr: call, span: callSpan } satisfies ExprStmt;
  }

  /** Parse `if cond do ... [else ...] end`. */
  private parseIfStmt(): IfStmt | null {
    const ifToken = this.advance(); // `if`
    const condition = this.parseExpr();

    if (!condition) {
      this.diagnostics.push(langError("Expected condition after `if`", this.peek().span));
      this.skipToNextLine();
      return null;
    }

    this.expectDoAndNewline("after if condition");

    const then = this.parseBlockBody(true, TokenKind.Else);

    let elseBranch: Stmt[] | null = null;
    if (this.eat(TokenKind.Else)) {
      elseBranch = this.parseBlockBody(true);
    }

    this.expect(TokenKind.End, "to close if block");
    const endSpan = this.peekAhead(-1).span;

    return {
      kind: "If",
      condition,
      then,
      else: elseBranch,
      span: mergeSpan(ifToken.span, endSpan),
    } satisfies IfStmt;
  }

  /** Parse `return [expr]`. Postfix guard is handled by the caller via `wrapConditional`. */
  private parseReturnStmt(): ReturnStmt {
    const retToken = this.advance(); // `return`

    // Only parse a value expression when the next token can start one —
    // distinguishes `return if cond` (postfix guard, no value) from `return expr`.
    let value: Expr | null = null;
    const next = this.peek();

    // TODO: See previous comment about valid trivial line ending construct list:
    if (
      next.kind !== TokenKind.Newline &&
      next.kind !== TokenKind.EOF &&
      next.kind !== TokenKind.If &&
      next.kind !== TokenKind.Unless &&
      next.kind !== TokenKind.Comment
    ) {
      value = this.parseExpr();
    }

    return {
      kind: "Return",
      value,
      span: mergeSpan(retToken.span, value?.span ?? retToken.span),
    } satisfies ReturnStmt;
  }

  /**
   * If the current token is `if` or `unless`, parse a postfix conditional
   * and wrap `inner` in a `ConditionalStmt`. Otherwise return `inner` as-is.
   */
  private wrapConditional(inner: Stmt): Stmt {
    if (!this.check(TokenKind.If) && !this.check(TokenKind.Unless)) {
      return inner;
    }

    const kw = this.advance();
    const condition = this.parseExpr();

    if (!condition) {
      this.diagnostics.push(langError(`Expected condition after trailing \`${kw.kind}\``, this.peek().span));
      return inner;
    }

    // TODO: Upgrade the `as "if" | "unless"` type to a `GuardKeyword` type, which also supports `until` and `while`
    return {
      kind: "Conditional",
      guard: kw.kind as "if" | "unless",
      condition,
      body: inner,
      span: mergeSpan(inner.span, condition.span),
    } satisfies ConditionalStmt;
  }

  /**
   * Lookahead helper: returns `true` if a `do` token appears on the current
   * line before a newline or EOF. Used to detect unknown block-like statements.
   */
  private hasDoOnCurrentLine(): boolean {
    let i = this.pos + 1;

    while (i < this.tokens.length) {
      const k = this.tokens[i]!.kind;
      if (k === TokenKind.Newline || k === TokenKind.EOF) return false;
      if (k === TokenKind.Do) return true;
      i++;
    }
    
    return false;
  }

  /** Parse `type name` or `type name = expr` as a local variable declaration. */
  private parseLocalDecl(docs: string[], isConst = false): LocalDeclStmt | null {
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
      } else if (sizeToken.kind === TokenKind.RBracket) {
        this.diagnostics.push(langError("Array size is required", sizeToken.span));
      } else {
        this.diagnostics.push(langError("Expected integer array size", sizeToken.span));
      }

      this.expect(TokenKind.RBracket, "after array size");

      if (varType !== "int") {
        this.diagnostics.push(
          langError("Only `int` arrays are supported", typeToken.span),
        );
      }
    }

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
      if (arraySize !== null) {
        this.diagnostics.push(
          langError("Array declarations cannot have an initializer", this.peek().span),
        );

        this.skipToNextLine();
        return null;
      }

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

    return {
      kind: "LocalDecl",
      span: mergeSpan(typeToken.span, init?.span ?? nameToken.span),
      docs,
      varType,
      name: nameToken.value,
      nameSpan: nameToken.span,
      arraySize,
      isConst,
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

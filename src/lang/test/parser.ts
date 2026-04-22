import { Parser } from "../parser.js";
import { TokenKind } from "../token.js";
import type { Token } from "../token.js";
import type { LangDiagnostic, Span } from "../diagnostics.js";
import { langError } from "../diagnostics.js";
import { parse as parsePlugin } from "../parser.js";
import type {
  TestFileNode,
  TestBodyItem,
  TestStep,
  DescribeNode,
  TestCaseNode,
  SetupNode,
  MockDeclNode,
  ConfigOverrideNode,
  EmitStmt,
  CallTestStmt,
  AssignGlobalStmt,
  AssertStmt,
  ExpectStmt,
} from "./ast.js";
import type { Expr } from "../ast.js";

// Re-export the base parse function under the plugin name so consumers can
// import both from one module.
export { parsePlugin };

export interface TestParseResult {
  ast: TestFileNode;
  diagnostics: LangDiagnostic[];
}

// Internal helper to merge two spans into one covering both. Assumes `a` starts at or before `b`.
function mergeSpan(a: Span, b: Span): Span {
  return { line: a.line, col: a.col, endLine: b.endLine, endCol: b.endCol };
}

/**
 * Parser for the test file AST. Contains methods for parsing each construct, and accumulates diagnostics on the way.
 *
 * The main entry point is `parseTestFile()`, which produces a `TestFileNode` and a list of diagnostics. 
 */
class TestParser extends Parser {

  /**
   * Parses a test file and returns its AST along with any diagnostics.
   * @returns A `TestFileNode` representing the parsed AST of the test file, and a list of diagnostics for any syntax errors encountered.
   */
  parseTestFile(): TestParseResult {
    this.consumeTrivia();

    const startSpan = this.peek().span;

    if (!this.check(TokenKind.Deftest)) {
      return {
        ast: emptyTestFile(startSpan),
        diagnostics: [langError("Expected `deftest` at top of test file", startSpan)],
      };
    }

    const ast = this.parseDeftest();
    return { ast, diagnostics: this.diagnostics };
  }

  // --- Begin Internal Sub-Parsers --------------------------------------------------

  private parseDeftest(): TestFileNode {
    const defToken = this.advance(); // `deftest`

    this.expect(TokenKind.For, "after `deftest`");

    let pluginRef: string;
    let pluginRefIsPath: boolean;

    if (this.check(TokenKind.StringLit)) {
      pluginRef = this.advance().value;
      pluginRefIsPath = true;
    } else if (this.check(TokenKind.Identifier)) {
      pluginRef = this.advance().value;
      pluginRefIsPath = false;
    } else {
      this.diagnostics.push(langError("Expected plugin module name or path string after `deftest for`", this.peek().span));
      pluginRef = "<unknown>";
      pluginRefIsPath = false;
    }

    this.expectDoAndNewline("after plugin reference in `deftest`");

    const body = this.parseTestBody(false);

    const endToken = this.eat(TokenKind.End);
    return {
      kind: "TestFile",
      span: mergeSpan(defToken.span, endToken?.span ?? defToken.span),
      pluginRef,
      pluginRefIsPath,
      body,
    };
  }

  // --- Test body (deftest or describe contents) ----------------------------

  private parseTestBody(inDescribe: boolean): TestBodyItem[] {
    const items: TestBodyItem[] = [];

    while (!this.check(TokenKind.End) && !this.check(TokenKind.EOF)) {
      this.consumeTrivia();
      if (this.check(TokenKind.End) || this.check(TokenKind.EOF)) break;

      if (this.check(TokenKind.Describe)) {
        if (inDescribe) {
          this.diagnostics.push(langError("Cannot nest `describe` blocks", this.peek().span));
          this.skipDoBlock();
          continue;
        }

        const node = this.parseDescribe();
        if (node) items.push(node);
        continue;
      }

      if (this.check(TokenKind.Test)) {
        const node = this.parseTestCase();
        if (node) items.push(node);
        continue;
      }

      if (this.check(TokenKind.Setup)) {
        const node = this.parseSetup();
        if (node) items.push(node);
        continue;
      }

      if (this.check(TokenKind.Mock)) {
        const node = this.parseMockDecl();
        if (node) items.push(node);
        continue;
      }

      if (this.check(TokenKind.Config)) {
        const node = this.parseConfigOverride();
        if (node) items.push(node);
        continue;
      }

      const t = this.advance();
      this.diagnostics.push(langError(`Unexpected token \`${t.kind}\` in test body`, t.span));
    }

    return items;
  }

  // --- Describe block -------------------------------------------------------

  private parseDescribe(): DescribeNode | null {
    const kwToken = this.advance(); // `describe`

    if (!this.check(TokenKind.StringLit)) {
      this.diagnostics.push(langError("Expected label string after `describe`", this.peek().span));
      this.skipDoBlock();
      return null;
    }

    const labelToken = this.advance();
    this.expectDoAndNewline("after describe label");
    const body = this.parseTestBody(true);
    const endToken = this.eat(TokenKind.End);

    return {
      kind: "Describe",
      span: mergeSpan(kwToken.span, endToken?.span ?? kwToken.span),
      label: labelToken.value,
      body,
    };
  }

  // --- Test case block -------------------------------------------------------

  private parseTestCase(): TestCaseNode | null {
    const kwToken = this.advance(); // `test`

    if (!this.check(TokenKind.StringLit)) {
      this.diagnostics.push(langError("Expected label string after `test`", this.peek().span));
      this.skipDoBlock();
      return null;
    }

    const labelToken = this.advance();
    this.expectDoAndNewline("after test label");
    const steps = this.parseTestSteps();
    const endToken = this.eat(TokenKind.End);

    return {
      kind: "TestCase",
      span: mergeSpan(kwToken.span, endToken?.span ?? kwToken.span),
      label: labelToken.value,
      steps,
    };
  }

  // --- Setup block ----------------------------------------------------------

  private parseSetup(): SetupNode | null {
    const kwToken = this.advance(); // `setup`
    this.expectDoAndNewline("after `setup`");
    const steps = this.parseTestSteps();
    const endToken = this.eat(TokenKind.End);

    return {
      kind: "Setup",
      span: mergeSpan(kwToken.span, endToken?.span ?? kwToken.span),
      steps,
    };
  }

  // --- Step sequence --------------------------------------------------------

  private parseTestSteps(): TestStep[] {
    const steps: TestStep[] = [];

    while (!this.check(TokenKind.End) && !this.check(TokenKind.EOF)) {
      this.consumeTrivia();
      if (this.check(TokenKind.End) || this.check(TokenKind.EOF)) break;

      const step = this.parseTestStep();
      if (step) steps.push(step);
    }

    return steps;
  }

  private parseTestStep(): TestStep | null {
    const t = this.peek();

    if (t.kind === TokenKind.Mock)      return this.parseMockDecl();
    if (t.kind === TokenKind.Config)    return this.parseConfigOverride();
    if (t.kind === TokenKind.Emit)      return this.parseEmitStmt();
    if (t.kind === TokenKind.CallStmt)  return this.parseCallTestStmt();
    if (t.kind === TokenKind.GlobalVar) return this.parseAssignGlobal();
    if (t.kind === TokenKind.Assert)    return this.parseAssertStmt();
    if (t.kind === TokenKind.Expect)    return this.parseExpectStmt();

    this.diagnostics.push(langError(`Unexpected token \`${t.kind}\` in test step`, t.span));
    this.advance();
    this.skipToNextLine();
    return null;
  }

  // --- Individual step parsers ----------------------------------------------

  /** `mock name = (type arg, ...) -> expr` */
  private parseMockDecl(): MockDeclNode | null {
    const kwToken = this.advance(); // `mock`

    if (!this.check(TokenKind.Identifier)) {
      this.diagnostics.push(langError("Expected function name after `mock`", this.peek().span));
      this.skipToNextLine();
      return null;
    }

    const nameToken = this.advance();
    this.expect(TokenKind.Assign, `after \`mock ${nameToken.value}\``);

    const params = this.parseDefParams();
    this.expect(TokenKind.Arrow, `after \`mock ${nameToken.value}(...)\``);

    const body = this.parseExpr();

    if (!body) {
      this.diagnostics.push(langError(`Expected expression for mock body of \`${nameToken.value}\``, this.peek().span));
      this.skipToNextLine();
      return null;
    }

    return {
      kind: "MockDecl",
      span: mergeSpan(kwToken.span, body.span),
      name: nameToken.value,
      nameSpan: nameToken.span,
      params,
      body,
    };
  }

  /** `emit :event [with expr, ...]` */
  private parseEmitStmt(): EmitStmt | null {
    const kwToken = this.advance(); // `emit`

    if (!this.check(TokenKind.Atom)) {
      this.diagnostics.push(langError("Expected event atom after `emit`", this.peek().span));
      this.skipToNextLine();
      return null;
    }

    const eventToken = this.advance();
    let arg: Expr[] | null = null;

    if (this.check(TokenKind.With)) {
      this.advance(); // `with`
      arg = [];
      
      const first = this.parseExpr();

      if (!first) {
        this.diagnostics.push(langError("Expected expression after `emit :event with`", this.peek().span));
      } else {
        arg.push(first);

        while (this.check(TokenKind.Comma)) {
          this.advance();
          const next = this.parseExpr();

          if (!next) {
            this.diagnostics.push(langError("Expected expression after `,` in `emit` args", this.peek().span));
            break;
          }

          arg.push(next);
        }
      }
    }

    const endSpan = arg?.at(-1)?.span ?? eventToken.span;
    return {
      kind: "Emit",
      span: mergeSpan(kwToken.span, endSpan),
      event: eventToken.value,
      eventSpan: eventToken.span,
      arg,
    };
  }

  /** `call fn_name(arg, ...)` */
  private parseCallTestStmt(): CallTestStmt | null {
    const kwToken = this.advance(); // `call`

    if (!this.check(TokenKind.Identifier)) {
      this.diagnostics.push(langError("Expected function name after `call`", this.peek().span));
      this.skipToNextLine();
      return null;
    }

    const nameToken = this.advance();
    const args = this.check(TokenKind.LParen) ? this.parseCallArgs() : [];

    return {
      kind: "CallTest",
      span: mergeSpan(kwToken.span, this.peekAhead(-1).span),
      name: nameToken.value,
      args,
    };
  }

  /** `$name = expr` */
  private parseAssignGlobal(): AssignGlobalStmt | null {
    const nameToken = this.advance(); // GlobalVar token
    this.expect(TokenKind.Assign, `after \`$${nameToken.value}\``);

    const value = this.parseExpr();

    if (!value) {
      this.diagnostics.push(langError(`Expected value after \`$${nameToken.value} =\``, this.peek().span));
      this.skipToNextLine();
      return null;
    }

    return {
      kind: "AssignGlobal",
      span: mergeSpan(nameToken.span, value.span),
      name: nameToken.value,
      nameSpan: nameToken.span,
      value,
    };
  }

  /** `assert expr` */
  private parseAssertStmt(): AssertStmt | null {
    const kwToken = this.advance(); // `assert`
    const condition = this.parseExpr();

    if (!condition) {
      this.diagnostics.push(langError("Expected expression after `assert`", this.peek().span));
      this.skipToNextLine();
      return null;
    }

    return {
      kind: "Assert",
      span: mergeSpan(kwToken.span, condition.span),
      condition,
    };
  }

  /**
   * `expect fn [not] called [with arg1, arg2] [op N times]`
   *
   * Grammar:
   *   expect <ident> [not] called [with <expr> {, <expr>}] [<op> <int> times]
   * where <op> is one of: == != >= > <= <  (defaults to == when only an int is given)
   */
  private parseExpectStmt(): ExpectStmt | null {
    const kwToken = this.advance(); // `expect`

    if (!this.check(TokenKind.Identifier)) {
      this.diagnostics.push(langError("Expected mock function name after `expect`", this.peek().span));
      this.skipToNextLine();
      return null;
    }

    const nameToken = this.advance();

    let negated = false;
    if (this.check(TokenKind.Not)) {
      this.advance();
      negated = true;
    }

    if (!this.check(TokenKind.Called)) {
      this.diagnostics.push(langError(`Expected \`called\` after \`expect ${nameToken.value}\``, this.peek().span));
      this.skipToNextLine();
      return null;
    }

    this.advance(); // `called`

    let args: Expr[] | null = null;

    if (this.check(TokenKind.With)) {
      this.advance(); // `with`
      args = [];

      const first = this.parseExpr();

      if (!first) {
        this.diagnostics.push(langError("Expected expression after `with`", this.peek().span));
      } else {
        args.push(first);

        while (this.check(TokenKind.Comma)) {
          this.advance();
          const next = this.parseExpr();

          if (!next) {
            this.diagnostics.push(langError("Expected expression after `,` in expect args", this.peek().span));
            break;
          }

          args.push(next);
        }
      }
    }

    // TODO: Hoist type decls and map
    type CountOp = "==" | "!=" | ">=" | ">" | "<=" | "<";
    let times: { op: CountOp; count: number } | null = null;

    const OP_MAP = new Map<TokenKind, CountOp>([
      [TokenKind.EqEq,  "=="],
      [TokenKind.NotEq, "!="],
      [TokenKind.Gte,   ">="],
      [TokenKind.Gt,    ">"],
      [TokenKind.Lte,   "<="],
      [TokenKind.Lt,    "<"],
    ]);

    const opKind = this.peek().kind;

    if (OP_MAP.has(opKind) || this.check(TokenKind.Integer)) {
      let op: CountOp = "==";

      if (OP_MAP.has(opKind)) {
        op = OP_MAP.get(opKind)!;
        this.advance();
      }

      if (!this.check(TokenKind.Integer)) {
        this.diagnostics.push(langError("Expected integer count after operator in `expect ... times`", this.peek().span));
        this.skipToNextLine();
        return null;
      }

      const countToken = this.advance();
      const count = parseInt(countToken.value, 10);

      if (!this.check(TokenKind.Times)) {
        this.diagnostics.push(langError("Expected `times` after count in `expect`", this.peek().span));
        this.skipToNextLine();
        return null;
      }

      const timesToken = this.advance(); // `times`

      times = { op, count };

      return {
        kind: "Expect",
        span: mergeSpan(kwToken.span, timesToken.span),
        name: nameToken.value,
        nameSpan: nameToken.span,
        negated,
        args,
        times,
      };
    }

    const endSpan = args?.at(-1)?.span ?? nameToken.span;

    return {
      kind: "Expect",
      span: mergeSpan(kwToken.span, endSpan),
      name: nameToken.value,
      nameSpan: nameToken.span,
      negated,
      args,
      times,
    };
  }

  // --- Config override block ------------------------------------------------
  //
  // Parses `config do ... end` inside a test body, reusing the base parser's
  // `parseConfigDecl` for each individual declaration.

  private parseConfigOverride(): ConfigOverrideNode | null {
    const kwToken = this.advance(); // `config`
    this.expectDoAndNewline("after `config`");

    const declarations: import("../ast.js").ConfigDecl[] = [];

    while (!this.check(TokenKind.End) && !this.check(TokenKind.EOF)) {
      this.consumeTrivia();
      if (this.check(TokenKind.End) || this.check(TokenKind.EOF)) break;

      const t = this.peek();

      if (!this.isTypeKeyword(t.kind)) {
        this.advance();
        this.diagnostics.push(langError(`Unexpected token \`${t.kind}\` in config block`, t.span));
        continue;
      }

      const decl = this.parseConfigDecl(null);
      if (decl) declarations.push(decl);
    }

    const endToken = this.eat(TokenKind.End);

    return {
      kind: "ConfigOverride",
      span: mergeSpan(kwToken.span, endToken?.span ?? kwToken.span),
      declarations,
    };
  }

  private isTypeKeyword(kind: TokenKind): boolean {
    return kind === TokenKind.TypeInt || kind === TokenKind.TypeBool || kind === TokenKind.TypeString;
  }
}

// --- Helpers -----------------------------------------------------------------

function emptyTestFile(span: Span): TestFileNode {
  return {
    kind: "TestFile",
    span,
    pluginRef: "<unknown>",
    pluginRefIsPath: false,
    body: [],
  };
}

// --- Public API --------------------------------------------------------------

/**
 * Parse a token stream from a `.test.mtp` file into a `TestFileNode` AST.
 *
 * Syntax errors produce `error` diagnostics and best-effort recovery.
 * The returned AST is always a complete `TestFileNode`.
 *
 * Callers should lex the source with `lexTest()` (not `lex()`) so that
 * test-specific keywords are recognised.
 */
export function parseTestFile(tokens: Token[]): TestParseResult {
  return new TestParser(tokens).parseTestFile();
}
import type { Span, LangDiagnostic } from "./diagnostics.js";
import { langError } from "./diagnostics.js";
import { TokenKind } from "./token.js";
import type { Token } from "./token.js";

export interface LexResult {
  tokens: Token[];
  diagnostics: LangDiagnostic[];
}

// --- Keyword table ------------------------------------------------------------

const KEYWORDS: ReadonlyMap<string, TokenKind> = new Map([
  ["defplugin", TokenKind.Defplugin],
  ["defmodule", TokenKind.Defmodule],
  ["import",    TokenKind.Import],
  ["alias",     TokenKind.Alias],
  ["do",        TokenKind.Do],
  ["end",       TokenKind.End],
  ["config",    TokenKind.Config],
  ["globals",   TokenKind.Globals],
  ["match",     TokenKind.Match],
  ["fn",        TokenKind.Fn],
  ["def",       TokenKind.Def],
  ["on",        TokenKind.On],
  ["if",        TokenKind.If],
  ["else",      TokenKind.Else],
  ["unless",    TokenKind.Unless],
  ["while",     TokenKind.While],
  ["until",     TokenKind.Until],
  ["for",       TokenKind.For],
  ["in",        TokenKind.In],
  ["return",    TokenKind.Return],
  ["with",      TokenKind.With],
  ["and",       TokenKind.And],
  ["or",        TokenKind.Or],
  ["not",       TokenKind.Not],
  ["int",       TokenKind.TypeInt],
  ["bool",      TokenKind.TypeBool],
  ["string",    TokenKind.TypeString],
  ["true",      TokenKind.True],
  ["false",     TokenKind.False],
  ["const",     TokenKind.Const],
]);

/**
 * Additional keywords that are only meaningful inside `.test.mtp` files.
 * These are intentionally absent from the base `KEYWORDS` map so that
 * plugin source files can use names like `test`, `mock`, `emit`, etc.
 * as ordinary identifiers.
 */
export const TEST_KEYWORDS: ReadonlyMap<string, TokenKind> = new Map([
  ["deftest",  TokenKind.Deftest],
  ["describe", TokenKind.Describe],
  ["test",     TokenKind.Test],
  ["setup",    TokenKind.Setup],
  ["mock",     TokenKind.Mock],
  ["emit",     TokenKind.Emit],
  ["call",     TokenKind.CallStmt],
  ["assert",   TokenKind.Assert],
  ["expect",   TokenKind.Expect],
  ["called",   TokenKind.Called],
  ["times",    TokenKind.Times],
]);

// --- Character helpers --------------------------------------------------------

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentCont(ch: string): boolean {
  return isIdentStart(ch) || (ch >= "0" && ch <= "9");
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/**
 * Lexical analyzer for the plugin language. Converts a source string
 * into a stream of `Token`s, producing `LangDiagnostic` errors for
 * unrecognised characters or malformed literals.
 */
class Lexer {
  private pos = 0;
  private line = 1;
  private col = 1;
  private readonly tokens: Token[] = [];
  private readonly diagnostics: LangDiagnostic[] = [];
  private readonly allKeywords: ReadonlyMap<string, TokenKind>;

  constructor(
    private readonly source: string,
    extraKeywords?: ReadonlyMap<string, TokenKind>,
  ) {
    if (extraKeywords) {
      const merged = new Map(KEYWORDS);
      for (const [k, v] of extraKeywords) merged.set(k, v);
      this.allKeywords = merged;
    } else {
      this.allKeywords = KEYWORDS;
    }
  }

  scan(): LexResult {
    while (this.pos < this.source.length) {
      const ch = this.peek();

      // Skip horizontal whitespace
      if (ch === " " || ch === "\t") {
        this.advance();
        continue;
      }

      // Newlines are significant as a statement separator
      if (ch === "\n") {
        this.scanNewline();
        continue;
      }

      // Comment
      if (ch === "#") {
        this.scanComment();
        continue;
      }

      // String literal
      if (ch === '"') {
        this.scanString();
        continue;
      }

      // Numeric literal (integers and floats always start with a digit)
      if (isDigit(ch)) {
        this.scanNumber();
        continue;
      }

      // Identifier or keyword
      if (isIdentStart(ch)) {
        this.scanIdentOrKeyword();
        continue;
      }

      // Punctuation
      if (this.scanPunct()) continue;

      // Unknown - emit diagnostic, skip character
      const start = this.cursor();
      const bad = this.advance();
      this.diagnostics.push(langError(`Unexpected character: ${JSON.stringify(bad)}`, this.spanFrom(start)));
    }

    this.tokens.push({ kind: TokenKind.EOF, value: "", span: this.pointSpan() });
    return { tokens: this.tokens, diagnostics: this.diagnostics };
  }

  // --- Scanning helpers -------------------------------------------------------

  private peek(offset = 0): string {
    return this.source[this.pos + offset] ?? "";
  }

  private advance(): string {
    const ch = this.source[this.pos] ?? "";
    this.pos++;
    if (ch === "\n") {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return ch;
  }

  /** Current cursor position (before the next character). */
  private cursor(): { line: number; col: number } {
    return { line: this.line, col: this.col };
  }

  /** A zero-width span at the current position (used for EOF). */
  private pointSpan(): Span {
    return { line: this.line, col: this.col, endLine: this.line, endCol: this.col };
  }

  /** Span from a saved start cursor to the current position. */
  private spanFrom(start: { line: number; col: number }): Span {
    return { line: start.line, col: start.col, endLine: this.line, endCol: this.col };
  }

  private push(kind: TokenKind, value: string, start: { line: number; col: number }): void {
    this.tokens.push({ kind, value, span: this.spanFrom(start) });
  }

  // --- Scanners ---------------------------------------------------------------

  private scanNewline(): void {
    const start = this.cursor();
    this.advance();
    this.push(TokenKind.Newline, "\n", start);
  }

  private scanComment(): void {
    const start = this.cursor();
    this.advance(); // consume `#`
    let text = "";
    while (this.pos < this.source.length && this.peek() !== "\n") {
      text += this.advance();
    }
    this.push(TokenKind.Comment, text.trim(), start);
  }

  private scanString(): void {
    const start = this.cursor();
    this.advance(); // consume opening `"`
    let value = "";
    let closed = false;

    while (this.pos < this.source.length) {
      const ch = this.peek();

      if (ch === '"') {
        this.advance();
        closed = true;
        break;
      }

      if (ch === "\n") break; // unterminated

      if (ch === "\\") {
        this.advance(); // consume backslash
        const esc = this.advance();

        if (esc === '"') {
          value += '"';
        } else if (esc === "\\") {
          value += "\\";
        } else {
          value += "\\" + esc;
          this.diagnostics.push(langError(`Unknown string escape: \\${esc}`, this.spanFrom(start)));
        }
        continue;
      }

      value += this.advance();
    }

    if (!closed) {
      this.diagnostics.push(langError("Unterminated string literal", this.spanFrom(start)));
    }

    this.push(TokenKind.StringLit, value, start);
  }

  private scanNumber(): void {
    const start = this.cursor();
    let raw = "";

    while (isDigit(this.peek())) {
      raw += this.advance();
    }

    // Float: digits `.` digits
    if (this.peek() === "." && isDigit(this.peek(1))) {
      raw += this.advance(); // consume `.`
      while (isDigit(this.peek())) {
        raw += this.advance();
      }
      this.push(TokenKind.Float, raw, start);
    } else {
      this.push(TokenKind.Integer, raw, start);
    }
  }

  private scanIdentOrKeyword(): void {
    const start = this.cursor();
    let name = "";

    while (isIdentCont(this.peek())) {
      name += this.advance();
    }

    const kw = this.allKeywords.get(name);
    this.push(kw ?? TokenKind.Identifier, name, start);
  }

  private scanPunct(): boolean {
    const start = this.cursor();
    const ch = this.peek();
    let kind: TokenKind | null = null;

    switch (ch) {
      case "(": kind = TokenKind.LParen;    break;
      case ")": kind = TokenKind.RParen;    break;
      case "[": kind = TokenKind.LBracket;  break;
      case "]": kind = TokenKind.RBracket;  break;
      case ",": kind = TokenKind.Comma;     break;

      // Handle Assignment or Equality (`=` vs `==`)
      case "=": {
        if (this.peek(1) === "=") {
          this.advance();
          this.advance();
          this.push(TokenKind.EqEq, "==", start);
          return true;
        }

        this.advance();
        this.push(TokenKind.Assign, "=", start);
        return true;
      }

      case ":": {
        // `:name` (no space) → Atom;  bare `:` → Colon (kwarg separator)
        if (isIdentStart(this.peek(1))) {
          this.advance(); // consume `:`
          let atomName = "";
          while (isIdentCont(this.peek())) atomName += this.advance();
          this.push(TokenKind.Atom, atomName, start);
        } else {
          this.advance();
          this.push(TokenKind.Colon, ":", start);
        }
        return true;
      }

      case "@": {
        this.advance(); // consume `@`
        let attrName = "";

        while (isIdentCont(this.peek())) attrName += this.advance();

        this.push(TokenKind.ModuleAttr, attrName, start);
        return true;
      }

      case "$": {
        this.advance(); // consume `$`

        // $_ and $! are special case tokens:
        //   $_ → last result variable
        //   $! → last error variable
        if (this.peek() === "_") {
          this.advance();
          this.push(TokenKind.Accumulator, "$_", start);
          return true;
        } else if (this.peek() === "!") {
          this.advance();
          this.push(TokenKind.ErrorCode, "$!", start);
          return true;
        }

        let globalName = "";
        while (isIdentCont(this.peek())) globalName += this.advance();
        this.push(TokenKind.GlobalVar, globalName, start);
        return true;
      }

      // Handle the "pipe" or "or" operator(`||` or `|>`) or binary or (`|`)
      // FUTURE (Phase J): Remove `||` since MTP uses keyword `or` exclusively
      case "|": {
        if (this.peek(1) === "|") {
          this.advance();
          this.advance();
          this.push(TokenKind.Or, "||", start);
        } else if (this.peek(1) === ">") {
          this.advance();
          this.advance();
          this.push(TokenKind.Pipe, "|>", start);
        } else {
          this.advance();
          this.push(TokenKind.BinaryOr, "|", start);
        }

        return true;
      }

      // --- Arithmetic operators -------------------------------------------------
      case "+": {
        if (this.peek(1) === "=") {
          this.advance();
          this.advance();
          this.push(TokenKind.PlusAssign, "+=", start);
          return true;
        }
        kind = TokenKind.Plus; break;
      }

      // Handle minus, arrow, or minus-assign (`-` vs `->` vs `-=`)
      case "-": {
        if (this.peek(1) === ">") {
          this.advance();
          this.advance();
          this.push(TokenKind.Arrow, "->", start);
          return true;
        }
        if (this.peek(1) === "=") {
          this.advance();
          this.advance();
          this.push(TokenKind.MinusAssign, "-=", start);
          return true;
        }
        kind = TokenKind.Minus;   break;
      }

      case "*": {
        if (this.peek(1) === "=") {
          this.advance();
          this.advance();
          this.push(TokenKind.MulAssign, "*=", start);
          return true;
        }
        kind = TokenKind.Star; break;
      }
      case "/": {
        if (this.peek(1) === "=") {
          this.advance();
          this.advance();
          this.push(TokenKind.DivAssign, "/=", start);
          return true;
        }
        kind = TokenKind.Slash; break;
      }

      // --- Comparison operators -------------------------------------------------
      case ">": {
        if (this.peek(1) === "=") {
          this.advance();
          this.advance();
          this.push(TokenKind.Gte, ">=", start);
          return true;
        }
        kind = TokenKind.Gt; break;
      }
      case "<": {
        if (this.peek(1) === "=") {
          this.advance();
          this.advance();
          this.push(TokenKind.Lte, "<=", start);
          return true;
        }
        if (this.peek(1) === ">") {
          this.advance();
          this.advance();
          this.push(TokenKind.Concat, "<>", start);
          return true;
        }
        kind = TokenKind.Lt; break;
      }
      case "!": {
        if (this.peek(1) === "=") {
          this.advance();
          this.advance();
          this.push(TokenKind.NotEq, "!=", start);
          return true;
        }
        return false;
      }

      // --- Bitwise operators ----------------------------------------------------
      case "&": kind = TokenKind.BinaryAnd; break;
      case "^": kind = TokenKind.BinaryXor; break;
      case "~": kind = TokenKind.BinaryNot; break;

      // --- Range and dot-accessor operators ------------------------------------
      case ".": {
        if (this.peek(1) === ".") {
          this.advance();
          this.advance();
          this.push(TokenKind.DotDot, "..", start);
          return true;
        }
        
        kind = TokenKind.Dot; break;
      }
    }

    if (kind === null) return false;

    this.advance();
    this.push(kind, ch, start);

    return true;
  }
}

/**
 * Lex a `.mtp` source string into a flat token array.
 *
 * Unrecognised characters produce an `error` diagnostic and
 * are skipped rather than throwing. The final token is always `EOF`.
 */
export function lex(source: string): LexResult {
  // Normalize line endings
  const normalised = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return new Lexer(normalised).scan();
}

/**
 * Lex a `.test.mtp` source string. Identical to `lex()` but also recognises
 * test-specific keywords (`test`, `mock`, `emit`, `assert`, etc.) that are
 * intentionally absent from the base keyword map so they can be used as
 * ordinary identifiers in plugin source files.
 */
export function lexTest(source: string): LexResult {
  const normalised = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return new Lexer(normalised, TEST_KEYWORDS).scan();
}

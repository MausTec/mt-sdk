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
  ["return",    TokenKind.Return],
  ["and",       TokenKind.And],
  ["or",        TokenKind.Or],
  ["not",       TokenKind.Not],
  ["int",       TokenKind.TypeInt],
  ["bool",      TokenKind.TypeBool],
  ["string",    TokenKind.TypeString],
  ["true",      TokenKind.True],
  ["false",     TokenKind.False],
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

  constructor(private readonly source: string) {}

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

    const kw = KEYWORDS.get(name);
    
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
      case "=": kind = TokenKind.Assign;    break;
    }

    if (kind === null) return false;
    
    this.advance();
    this.push(kind, ch, start);

    return true;
  }
}

/**
 * Lex a `.mtpl` source string into a flat token array.
 *
 * Unrecognised characters produce an `error` diagnostic and
 * are skipped rather than throwing. The final token is always `EOF`.
 */
export function lex(source: string): LexResult {
  // Normalize line endings
  const normalised = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  return new Lexer(normalised).scan();
}

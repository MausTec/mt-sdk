import type { Span } from "./diagnostics.js";

/**
 * Every token kind produced by the lexer.
 *
 * String values are the literal source text where applicable, making
 * debugging easier (you can print token.kind directly).
 */
export enum TokenKind {
  // --- Block keywords --------------------------------------------------------
  Defplugin = "defplugin",
  Defmodule = "defmodule", // reserved, not yet implemented
  Import = "import",       // reserved
  Alias = "alias",         // reserved
  Do = "do",
  End = "end",
  Config = "config",
  Globals = "globals",
  Match = "match",
  Fn = "fn",
  Def = "def",
  On = "on",

  // --- Control-flow keywords -------------------------------------------------
  If = "if",
  Else = "else",
  Unless = "unless",
  While = "while",
  Until = "until",
  For = "for",
  In = "in",
  Return = "return",

  // --- Modifier keywords -----------------------------------------------------
  Const = "const",

  // --- Logic keywords --------------------------------------------------------
  And = "and",
  Or = "or",
  Not = "not",

  // --- Type keywords ---------------------------------------------------------
  TypeInt = "int",
  TypeBool = "bool",
  TypeString = "string",

  // --- Boolean literals ------------------------------------------------------
  True = "true",
  False = "false",

  // --- Operators -------------------------------------------------------------
  Pipe = "|>",
  Concat = "<>",
  Arrow = "->",
  Plus = "+",
  Minus = "-",
  Star = "*",
  Slash = "/",
  Assign = "=",
  PlusAssign = "+=",
  MinusAssign = "-=",
  MulAssign = "*=",
  DivAssign = "/=",
  EqEq = "==",
  NotEq = "!=",
  Gte = ">=",
  Lte = "<=",
  Gt = ">",
  Lt = "<",
  BinaryOr = "|",
  BinaryAnd = "&",
  BinaryXor = "^",
  BinaryNot = "~",
  DotDot = "..",
  Dot = ".",

  // --- Punctuation -----------------------------------------------------------
  LParen = "(",
  RParen = ")",
  LBracket = "[",
  RBracket = "]",
  Comma = ",",
  Colon = ":",  // bare `:` in kwarg position (e.g. `min: 1`)

  // --- Sigils ----------------------------------------------------------------
  // Each is lexed as a single token; `value` carries the name (without sigil).
  GlobalVar = "global_var",    // $name
  Accumulator = "accumulator", // $_ (special global)
  ErrorCode = "error_code",    // $! (special global)
  ConfigRef = "config_ref",    // config.name (dot-accessor on `config` keyword)
  Atom = "atom",               // :name (`:` immediately followed by identifier)
  ModuleAttr = "module_attr",  // @name (module-level metadata attribute)

  // --- Literals --------------------------------------------------------------
  Integer = "integer",
  Float = "float",
  StringLit = "string_lit", // `value` is the unescaped string content

  // --- Structural ------------------------------------------------------------
  Identifier = "identifier",
  Newline = "newline",   // significant as statement separator
  Comment = "comment",   // `value` is the comment text (without `#`)
  EOF = "eof",
}

export interface Token {
  kind: TokenKind;
  /** Raw source text, or unescaped content for StringLit, or bare name for sigils. */
  value: string;
  span: Span;
}

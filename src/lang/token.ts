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

  // --- Test keywords ---------------------------------------------------------
  Deftest = "deftest",
  Describe = "describe",
  Test = "test",
  Setup = "setup",
  Mock = "mock",
  Emit = "emit",
  CallStmt = "call",
  Assert = "assert",
  Refute = "refute",

  // --- Specific Assertion Keywords -------------------------------------------
  // TODO: consider if this specific syntax works in practice or if we should add generic syntax constructs
  // (Adding a `called :fn_name (with ar1g, ...)` syntax might be more flexible and readable than a separate 
  // keyword for each assertion type, e.g. `assert called :fn_name with arg1, arg2` or `assert :fn_name called with arg1, arg2`)

  AssertCalled = "assert_called",
  AssertNotCalled = "assert_not_called",
  AssertCallCount = "assert_call_count",

  // --- Control-flow keywords -------------------------------------------------
  If = "if",
  Else = "else",
  Unless = "unless",
  While = "while",
  Until = "until",
  For = "for",
  In = "in",
  Return = "return",

  // --- Binding keywords -------------------------------------------------------
  With = "with",

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

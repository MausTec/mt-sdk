import type { Span } from "./diagnostics.js";

// --- Shared -------------------------------------------------------------------

export interface BaseNode {
  span: Span;
}

export type VarType = "int" | "bool" | "string";

// --- Expressions --------------------------------------------------------------

export type Expr =
  | LiteralExpr
  | GlobalVarExpr
  | AccumulatorExpr
  | ErrorCodeExpr
  | ConfigRefExpr
  | IdentifierExpr
  | BinaryExpr
  | UnaryExpr
  | CallExpr
  | PipeExpr;

export interface LiteralExpr extends BaseNode {
  kind: "Literal";
  varType: VarType;
  value: number | boolean | string;
}

/** `$name` — read or assign a plugin global. */
export interface GlobalVarExpr extends BaseNode {
  kind: "GlobalVar";
  name: string;
}

/** `$_` — pipe accumulator (implicit result of the preceding step). */
export interface AccumulatorExpr extends BaseNode {
  kind: "Accumulator";
}

/** `$!` — error code set by builtins on failure. */
export interface ErrorCodeExpr extends BaseNode {
  kind: "ErrorCode";
}

/** `@name` — read-only config reference. */
export interface ConfigRefExpr extends BaseNode {
  kind: "ConfigRef";
  name: string;
}

/** Bare identifier — local variable read, or function call target. */
export interface IdentifierExpr extends BaseNode {
  kind: "Identifier";
  name: string;
}

export type BinaryOp =
  | "+" | "-" | "*" | "/"
  | "==" | "!=" | ">=" | "<=" | ">" | "<"
  | "<>"   // string concatenation
  | "and" | "or";

export interface BinaryExpr extends BaseNode {
  kind: "Binary";
  op: BinaryOp;
  left: Expr;
  right: Expr;
}

export interface UnaryExpr extends BaseNode {
  kind: "Unary";
  op: "not" | "-";
  operand: Expr;
}

/** A function or builtin call: `name(arg, ...)`. */
export interface CallExpr extends BaseNode {
  kind: "Call";
  name: string;
  args: Expr[];
}

/**
 * A pipeline: `head |> step1() |> step2()`.
 * Each step is a `CallExpr`; `$_` in a step's args refers to the previous result.
 */
export interface PipeExpr extends BaseNode {
  kind: "Pipe";
  head: Expr;
  steps: CallExpr[];
}

// --- Statements ---------------------------------------------------------------

export type Stmt =
  | LocalDeclStmt
  | AssignLocalStmt
  | AssignGlobalStmt
  | ExprStmt
  | IfStmt
  | ReturnStmt;

/** `type name` or `type name = expr` — local variable declaration. */
export interface LocalDeclStmt extends BaseNode {
  kind: "LocalDecl";
  varType: VarType;
  name: string;
  init: Expr | null;
}

/** `name = expr` — assign to a declared local. */
export interface AssignLocalStmt extends BaseNode {
  kind: "AssignLocal";
  name: string;
  value: Expr;
}

/** `$name = expr` — assign to a plugin global. */
export interface AssignGlobalStmt extends BaseNode {
  kind: "AssignGlobal";
  name: string;
  value: Expr;
}

/**
 * An expression used as a statement (call, pipe, paren-free call).
 * May carry a trailing `if`/`unless` guard.
 */
export interface ExprStmt extends BaseNode {
  kind: "ExprStmt";
  expr: Expr;
  trailing: TrailingCondition | null;
}

export interface TrailingCondition {
  kind: "if" | "unless";
  condition: Expr;
}

export interface IfStmt extends BaseNode {
  kind: "If";
  condition: Expr;
  then: Stmt[];
  else: Stmt[] | null;
}

export interface ReturnStmt extends BaseNode {
  kind: "Return";
  value: Expr | null;
}

// --- Block-level declarations -------------------------------------------------

/**
 * A single entry in a `config do ... end` block.
 * `label` comes from the `# comment` on the line immediately above.
 */
export interface ConfigDecl extends BaseNode {
  kind: "ConfigDecl";
  label: string | null;
  varType: VarType;
  name: string;
  default: Expr;
  constraints: Record<string, Expr>;
}

/** A single entry in a `globals do ... end` block. */
export interface GlobalDecl extends BaseNode {
  kind: "GlobalDecl";
  label: string | null;
  varType: VarType;
  name: string;
  /** `null` for scalar, positive integer for fixed-size array. */
  arraySize: number | null;
  init: Expr;
}

/** A single predicate in a `match do ... end` block. */
export interface MatchPredicate extends BaseNode {
  kind: "MatchPredicate";
  key: string;
  value: Expr;
}

// --- Top-level blocks ---------------------------------------------------------

export interface MatchBlockNode extends BaseNode {
  kind: "MatchBlock";
  predicates: MatchPredicate[];
}

export interface ConfigBlockNode extends BaseNode {
  kind: "ConfigBlock";
  declarations: ConfigDecl[];
}

export interface GlobalsBlockNode extends BaseNode {
  kind: "GlobalsBlock";
  declarations: GlobalDecl[];
}

/**
 * A metadata field inside the `defplugin` body:
 * e.g. `version "1.0.0"` or `permissions ["ble:write"]`.
 * `value` is a single expression for scalars, an array for bracket-list fields.
 */
export interface MetadataFieldNode extends BaseNode {
  kind: "MetadataField";
  key: string;
  value: Expr | Expr[];
}

/** `fn name = (type arg) -> expr` — pure single-expression function. */
export interface FnNode extends BaseNode {
  kind: "Fn";
  name: string;
  paramType: VarType;
  paramName: string;
  body: Expr;
}

/** `def name(type arg) do ... end` — effectful multi-statement function. */
export interface DefNode extends BaseNode {
  kind: "Def";
  name: string;
  paramType: VarType;
  paramName: string;
  body: Stmt[];
}

/** `on :event do ... end` — event handler. `event` is the atom name without `:`. */
export interface OnNode extends BaseNode {
  kind: "On";
  event: string;
  body: Stmt[];
}

// --- Root ---------------------------------------------------------------------

/** Root AST node produced by parsing a single `.mtpl` file. */
export interface PluginNode extends BaseNode {
  kind: "Plugin";
  displayName: string | null;
  metadata: MetadataFieldNode[];
  matchBlock: MatchBlockNode | null;
  configBlock: ConfigBlockNode | null;
  globalsBlock: GlobalsBlockNode | null;
  functions: FnNode[];
  defs: DefNode[];
  handlers: OnNode[];
}

// --- Union --------------------------------------------------------------------

export type ASTNode =
  | PluginNode
  | MetadataFieldNode
  | MatchBlockNode
  | ConfigBlockNode
  | GlobalsBlockNode
  | FnNode
  | DefNode
  | OnNode
  | ConfigDecl
  | GlobalDecl
  | MatchPredicate
  | Stmt
  | Expr;

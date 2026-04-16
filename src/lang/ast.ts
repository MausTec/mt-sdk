import type { Span } from "./diagnostics.js";

// --- Shared -------------------------------------------------------------------

export interface BaseNode {
  span: Span;
}

export type VarType = "int" | "float" | "bool" | "string";

// --- Expressions --------------------------------------------------------------

export type Expr =
  | LiteralExpr
  | GlobalVarExpr
  | AccumulatorExpr
  | ErrorCodeExpr
  | ConfigRefExpr
  | IdentifierExpr
  | IndexExpr
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

/** `name[expr]` or `$name[expr]` - array index access. */
export interface IndexExpr extends BaseNode {
  kind: "Index";
  target: Expr;
  index: Expr;
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
 * A single step in a pipe chain.
 * `call` is the function being applied.
 * `carriedType` is the type flowing *into* this step from the previous result.
 * Currently always `"unknown"` until a return-type system is added
 */
export interface PipeStep {
  call: CallExpr;
  carriedType: "unknown";
}

/**
 * A pipeline: `head |> step1() |> step2()`.
 * `$_` in any step's args refers to the carried value from the previous step.
 * `carriedType` on each step will carry the inferred return type of the prior
 * expression once type inference is implemented.
 */
export interface PipeExpr extends BaseNode {
  kind: "Pipe";
  head: Expr;
  steps: PipeStep[];
}

// --- Statements ---------------------------------------------------------------

export type Stmt =
  | LocalDeclStmt
  | AssignLocalStmt
  | AssignGlobalStmt
  | AssignIndexStmt
  | ExprStmt
  | IfStmt
  | ReturnStmt
  | ConditionalStmt;

/** `type name` or `type name = expr` — local variable declaration. */
export interface LocalDeclStmt extends BaseNode {
  kind: "LocalDecl";
  docs: string[];
  varType: VarType;
  name: string;
  nameSpan: Span;
  /** `null` for scalar, positive integer for fixed-size array. */
  arraySize: number | null;
  /** Whether this was declared with `const`. */
  isConst: boolean;
  init: Expr | null;
}

/** `name = expr` — assign to a declared local. */
export interface AssignLocalStmt extends BaseNode {
  kind: "AssignLocal";
  name: string;
  nameSpan: Span;
  value: Expr;
}

/** `$name = expr` — assign to a plugin global. */
export interface AssignGlobalStmt extends BaseNode {
  kind: "AssignGlobal";
  name: string;
  nameSpan: Span;
  value: Expr;
}

/** `target[index] = value` — index assignment (setbyte). */
export interface AssignIndexStmt extends BaseNode {
  kind: "AssignIndex";
  target: Expr;
  index: Expr;
  value: Expr;
}

/** An expression used as a statement (call, pipe, paren-free call). */
export interface ExprStmt extends BaseNode {
  kind: "ExprStmt";
  expr: Expr;
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

/**
 * Postfix conditional wrapper: `stmt if cond` / `stmt unless cond`.
 */
export interface ConditionalStmt extends BaseNode {
  kind: "Conditional";
  guard: "if" | "unless";
  condition: Expr;
  body: Stmt;
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
  nameSpan: Span;
  default: Expr;
  constraints: Record<string, Expr>;
}

/** A single entry in a `globals do ... end` block. */
export interface GlobalDecl extends BaseNode {
  kind: "GlobalDecl";
  label: string | null;
  varType: VarType;
  name: string;
  nameSpan: Span;
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
  nameSpan: Span;
  params: DefParam[];
  docs: string[];
  returnType: VarType | null;
  body: Expr;
}

/** A single parameter in a `def` or `fn` signature. */
export interface DefParam {
  varType: VarType;
  name: string;
  span: Span;
}

/** `def name(type arg, ...) do ... end` — effectful multi-statement function. */
export interface DefNode extends BaseNode {
  kind: "Def";
  docs: string[];
  name: string;
  nameSpan: Span;
  params: DefParam[];
  returnType: VarType | null;
  body: Stmt[];
}

/** `on :event do ... end` — event handler. `event` is the atom name without `:`. */
export interface OnNode extends BaseNode {
  kind: "On";
  event: string;
  body: Stmt[];
}

// --- Root ---------------------------------------------------------------------

/** Root AST node produced by parsing a single `.mtp` file. */
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

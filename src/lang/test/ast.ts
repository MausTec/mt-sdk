import type { Span } from "../diagnostics.js";
import type { ConfigDecl, DefParam, Expr } from "../ast.js";

// --- Test-file AST -----------------------------------------------------------

/**
 * Root node for a `.test.mtp` file.
 *
 * `pluginRef` names the subject under test: either a PascalCase module name
 * (e.g. `LovenseMaxDriver`) or a relative path string (e.g. `"./plugin.mtp"`).
 * `pluginRefIsPath` distinguishes the two forms.
 *
 * `body` is the top-level sequence of mock declarations, setup blocks,
 * describe groups, and bare test cases.
 */
export interface TestFileNode {
  kind: "TestFile";
  span: Span;
  pluginRef: string;
  pluginRefIsPath: boolean;
  body: TestBodyItem[];
}

/**
 * Items that may appear at the top level of a `deftest` block or inside a
 * `describe` block. Test cases can appear anywhere; `describe` blocks can
 * only appear at the top level.
 */
export type TestBodyItem =
  | MockDeclNode
  | ConfigOverrideNode
  | SetupNode
  | DescribeNode
  | TestCaseNode;

/**
 * A `describe "label" do ... end` grouping block.
 * Groups may contain mocks, config overrides, setup hooks, and test cases.
 * Describes cannot be nested.
 */
export interface DescribeNode {
  kind: "Describe";
  span: Span;
  label: string;
  body: TestBodyItem[];
}

/**
 * A `test "label" do ... end` individual test case.
 * Steps are executed in order; mock re-declarations in the sequence override
 * the previous mock for all subsequent steps within the same test.
 */
export interface TestCaseNode {
  kind: "TestCase";
  span: Span;
  label: string;
  steps: TestStep[];
}

/**
 * A `setup do ... end` lifecycle block. When at the top level of a `deftest`
 * block it runs before every test in the file; when inside a `describe` block
 * it runs before every test in that group (after any file-level setup).
 */
export interface SetupNode {
  kind: "Setup";
  span: Span;
  steps: TestStep[];
}

// --- Test steps --------------------------------------------------------------

/**
 * Ordered steps inside a `test` or `setup` block. A `MockDeclNode` inside a
 * test block acts as a redeclaration and overrides the previous
 * mock from that point forward in the execution sequence within this scope.
 */
export type TestStep =
  | MockDeclNode
  | ConfigOverrideNode
  | EmitStmt
  | CallTestStmt
  | AssignGlobalStmt
  | AssertStmt
  | ExpectStmt;

/**
 * `mock name = (type arg, ...) -> expr`
 *
 * Declares (or re-declares within a test sequence) a mock implementation for
 * a host function. When used at file/describe level it sets a default for all
 * contained tests. When used as a step inside a `test` block, it takes effect
 * from that point in the sequence onward.
 */
export interface MockDeclNode {
  kind: "MockDecl";
  span: Span;
  name: string;
  nameSpan: Span;
  params: DefParam[];
  body: Expr;
}

/**
 * `config do ... end` inside a test: Overrides specific config fields for
 * the duration of that test.
 */
export interface ConfigOverrideNode {
  kind: "ConfigOverride";
  span: Span;
  declarations: ConfigDecl[];
}

/**
 * `emit :event_name [with arg1, arg2]` event emitter: Fires a plugin event, optionally passing
 * the event payload arguments via `with`.
 */
export interface EmitStmt {
  kind: "Emit";
  span: Span;
  event: string;
  eventSpan: Span;
  arg: Expr[] | null;
}

/**
 * `call fn_name(arg, ...)` Explicit plugin function call: calls a plugin def/fn from test context.
 */
export interface CallTestStmt {
  kind: "CallTest";
  span: Span;
  name: string;
  args: Expr[];
}

/**
 * `$name = expr` Plugin global assignment: assign a plugin global directly in test context.
 * Used to pre-set state before firing events without going through the full
 * lifecycle (e.g. setting `$last_toggle_ms = 0` without calling `:connect`).
 * 
 * TODO: Evaluate if this can recycle the same AST entry from the main MTP parser.
 */
export interface AssignGlobalStmt {
  kind: "AssignGlobal";
  span: Span;
  name: string;
  nameSpan: Span;
  value: Expr;
}

/**
 * `assert expr` - assert that `expr` evaluates to truthy.
 */
export interface AssertStmt {
  kind: "Assert";
  span: Span;
  condition: Expr;
}

/**
 * `expect fn called [not] [with arg1, arg2] [N times] [op N times]`
 *
 * Interaction expectation on a mock function.
 *
 * - `expect fn called`                  - called at least once
 * - `expect fn not called`              - never called
 * - `expect fn called with a, b`        - called at least once with these args
 * - `expect fn not called with a, b`    - never called with these args
 * - `expect fn called 3 times`          - called exactly 3 times
 * - `expect fn called >= 3 times`       - called at least 3 times (op: `>=`, `>`, `<=`, `<`, `==`, `!=`)
 */
export interface ExpectStmt {
  kind: "Expect";
  span: Span;
  /** Name of the mock function being inspected. */
  name: string;
  nameSpan: Span;
  /** When true, the expectation is negated (`not called`). */
  negated: boolean;
  /** When present, assert the mock was called with exactly these arguments. */
  args: Expr[] | null;
  /**
   * When present, assert the call count matches this constraint.
   * `op` is a comparison operator string; `count` is the integer operand.
   * A bare `N times` (no operator) uses op `"=="` implicitly.
   */
  times: { op: "==" | "!=" | ">=" | ">" | "<=" | "<"; count: number } | null;
}

// --- Union --------------------------------------------------------------------

export type TestASTNode =
  | TestFileNode
  | DescribeNode
  | TestCaseNode
  | SetupNode
  | MockDeclNode
  | ConfigOverrideNode
  | EmitStmt
  | CallTestStmt
  | AssignGlobalStmt
  | AssertStmt
  | ExpectStmt;

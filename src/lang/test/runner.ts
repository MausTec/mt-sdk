/**
 * Test runner for `.test.mtp` files.
 *
 * Consumes a `TestFileNode` AST and one or more compiled plugin JSON objects,
 * matches each test file to its subject plugin by ref, and executes each test
 * case in isolation using a fresh runtime instance.
 *
 * Consumers (CLI, VS Code extension) provide the compiled plugin JSON and
 * resolved API manifest; the runner owns only the execution logic.
 *
 * ## Isolation model
 *
 * Each test case gets its own `createRuntime` call so there is no state
 * bleed between tests. The WASM source buffer is loaded once and reused
 * across calls to amortize the cost of the initial file/network fetch.
 *
 * ## Scope layering
 *
 * Mocks, config overrides, and setup steps are inherited from outer scopes
 * and applied before the test case's own steps, in the order:
 *
 *   file-level setup -> describe-level setup -> test-case steps
 *
 * A `MockDeclNode` appearing inside a test's step list re-declares the mock
 * from that point onward within the same test execution.
 */

import type { ApiDescriptor } from "../../analysis/types.js";
import type {
  HostFunction,
  Runtime,
  RuntimeError,
  RuntimeValue,
} from "../../runtime/types.js";
import { createRuntime } from "../../runtime/index.js";
import { moduleNameToSlug } from "../emitter/plugin.js";
import type {
  AssertStmt,
  AssignGlobalStmt,
  CallTestStmt,
  ConfigOverrideNode,
  DescribeNode,
  EmitStmt,
  ExpectStmt,
  MockDeclNode,
  SetupNode,
  TestBodyItem,
  TestCaseNode,
  TestFileNode,
  TestStep,
} from "./ast.js";
import {
  EvalError,
  evalArgs,
  evalExpr,
  runtimeValuesEqual,
  toEventArg,
} from "./eval.js";

// --- Diagnostic logging ------------------------------------------------------

/**
 * Print a step-by-step diagnostic line to stderr when `debug` is enabled.
 */
function dbg(debug: boolean | undefined, msg: string): void {
  if (debug) console.error(`[mt-test] ${msg}`);
}

/**
 * One-line summary of a step for diagnostic output. If a step doesn't have any obvious
 * identifying information, this will return an empty string.
 */
function describeStep(step: TestStep): string {
  switch (step.kind) {
    case "Emit":         return ` :${step.event}`;
    case "CallTest":     return ` ${step.name}`;
    case "AssignGlobal": return ` $${step.name} = ...`;
    case "ConfigOverride": return ` (${step.declarations.length} field${step.declarations.length === 1 ? "" : "s"})`;
    case "MockDecl":     return ` ${step.name}`;
    case "Assert":       return "";
    case "Expect":       return ` ${step.name}`;
    default:             return "";
  }
}

// --- Public configuration types ---------------------------------------------

/**
 * Runtime-level configuration shared across all test runs in a session.
 */
export interface TestRunConfig {
  /**
   * Resolved API manifest describing available host functions and events.
   * The caller is responsible for selecting the correct manifest (e.g. via
   * `getLatestApiDescriptor(sku)` from `mt-runtimes`). When omitted, only
   * explicitly mocked functions will be registered.
   */
  manifest?: ApiDescriptor;

  /**
   * Capture a per-test-case execution trace. Adds overhead; useful for
   * debugging failing tests. Default: `false`.
   */
  tracing?: boolean;

  /**
   * Print step-by-step setup diagnostics to stderr: test -> specimen matching,
   * plugin JSON load, runtime online, driver scope enable, and each test step
   * before it executes. Default: `false`.
   */
  debug?: boolean;
}

// --- Input types ------------------------------------------------------------

/**
 * A compiled plugin specimen to run tests against.
 *
 * The runner matches each test file's `deftest for <ModuleName>` declaration
 * to a plugin by comparing the spinal-cased slug of the module name
 * (`moduleNameToSlug(ast.pluginRef)`) against `plugin.json["name"]`.
 * The `name` field in compiled plugin JSON is always the slug produced by
 * `moduleNameToSlug` during compilation and is the canonical stable identity
 * key — it is never overridable by plugin authors.
 */
export interface TestPlugin {
  /** Compiled plugin JSON specimen. The caller is responsible for loading or transpiling. */
  json: Record<string, unknown>;
}

// --- Result types ------------------------------------------------------------

/**
 * A single failed expectation or assertion within a test case.
 */
export interface TestFailure {
  /** Human-readable description of what went wrong. */
  message: string;
  /**
   * Zero-based index of the step in the test case that produced this failure.
   * For setup steps, this is the index within the setup step list.
   */
  stepIndex: number;
  /** What was expected (human-readable), if applicable. */
  expected?: string;
  /** What was actually observed, if applicable. */
  received?: string;
}

/**
 * Result of executing a single test case.
 */
export interface TestCaseResult {
  kind: "pass" | "fail" | "error";
  /** The test case label from `test "..."`. */
  label: string;
  /** The enclosing describe label, or `null` for top-level test cases. */
  describe: string | null;
  /** Non-empty when `kind` is `"fail"` or `"error"`. */
  failures: TestFailure[];
  /** Trace events captured during this test case. Empty when `tracing` is false. */
  trace: import("../../runtime/types.js").TraceEvent[];
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

/**
 * Aggregated results for a single `.test.mtp` file.
 */
export interface TestSuiteResult {
  /** The `pluginRef` string from the test file (`deftest for <ref>`). */
  pluginRef: string;
  /**
   * Absolute filesystem path to the source `.test.mtp` file, when known.
   * Populated by callers that have file context (e.g. `runProjectTests`);
   * direct callers of `runTests` may leave it undefined.
   */
  filePath?: string;
  cases: TestCaseResult[];
  passed: number;
  failed: number;
  /** Cases that threw an unexpected error during execution. */
  errored: number;
  /** Total wall-clock duration in milliseconds. */
  durationMs: number;
}

// --- Reporter ----------------------------------------------------------------

/**
 * Optional incremental reporter. Methods are called as execution proceeds;
 * the runner also returns the full aggregated result when complete.
 */
export interface TestReporter {
  onSuiteStart?: (info: { pluginRef: string; totalCases: number }) => void;
  onCaseStart?: (info: { label: string; describe: string | null }) => void;
  onCaseResult?: (result: TestCaseResult) => void;
  onSuiteResult?: (result: TestSuiteResult) => void;
}

// --- Main entry point -------------------------------------------------------

/**
 * Run all test files against the matching plugins.
 *
 * Each `TestFileNode` in `tests` is matched to a `TestPlugin` by slug:
 * `moduleNameToSlug(ast.pluginRef)` is compared against `plugin.json["name"]`.
 * Unmatched test files produce a suite result with a single error case.
 * Results are emitted incrementally via `reporter` if provided, and returned
 * as an array when all suites complete.
 */
export async function runTests(options: {
  tests: TestFileNode[];
  plugins: TestPlugin[];
  config: TestRunConfig;
  reporter?: TestReporter;
}): Promise<TestSuiteResult[]> {
  const { tests, plugins, config, reporter } = options;

  const results: TestSuiteResult[] = [];

  for (const ast of tests) {
    // Path-based refs are not supported at the runner level.
    if (ast.pluginRefIsPath) {
      const result = errorSuiteResult(
        ast.pluginRef,
        `Path-based \`deftest for\` refs are not supported. ` +
          `Use the plugin module name instead (e.g. \`deftest for LovenseMaxDriver\`).`,
      );
      reporter?.onSuiteResult?.(result);
      results.push(result);
      continue;
    }

    const slug = moduleNameToSlug(ast.pluginRef);
    dbg(config.debug, `match: deftest for \`${ast.pluginRef}\` -> slug \`${slug}\` (candidates: ${plugins.map((p) => p.json["name"]).join(", ") || "none"})`);
    const match = plugins.find((p) => (p.json["name"] as string) === slug);

    if (!match) {
      dbg(config.debug, `match: no plugin found for slug \`${slug}\` -- skipping suite`);
      const result = unmatchedSuiteResult(ast.pluginRef);
      reporter?.onSuiteResult?.(result);
      results.push(result);
      continue;
    }

    dbg(config.debug, `match: resolved to plugin \`${match.json["name"]}\` (display=\`${match.json["display_name"] ?? ""}\`)`);
    const result = await runTestSuite(ast, match.json, config, reporter);
    results.push(result);
  }

  return results;
}

// --- Suite execution --------------------------------------------------------

async function runTestSuite(
  ast: TestFileNode,
  pluginJson: Record<string, unknown>,
  config: TestRunConfig,
  reporter: TestReporter | undefined,
): Promise<TestSuiteResult> {
  const suiteStart = performance.now();
  const cases = collectTestCases(ast);

  reporter?.onSuiteStart?.({ pluginRef: ast.pluginRef, totalCases: cases.length });

  const caseResults: TestCaseResult[] = [];

  for (const { tc, describe } of cases) {
    reporter?.onCaseStart?.({ label: tc.label, describe: describe?.label ?? null });

    const result = await runTestCase(tc, describe ?? null, ast, pluginJson, config);

    caseResults.push(result);
    reporter?.onCaseResult?.(result);
  }

  const passed  = caseResults.filter((r) => r.kind === "pass").length;
  const failed  = caseResults.filter((r) => r.kind === "fail").length;
  const errored = caseResults.filter((r) => r.kind === "error").length;

  const suiteResult: TestSuiteResult = {
    pluginRef: ast.pluginRef,
    cases: caseResults,
    passed,
    failed,
    errored,
    durationMs: performance.now() - suiteStart,
  };

  reporter?.onSuiteResult?.(suiteResult);
  return suiteResult;
}

// --- Test case execution ----------------------------------------------------

async function runTestCase(
  tc: TestCaseNode,
  describe: DescribeNode | null,
  ast: TestFileNode,
  pluginJson: Record<string, unknown>,
  config: TestRunConfig,
): Promise<TestCaseResult> {
  const caseStart = performance.now();
  const failures: TestFailure[] = [];

  // Build the scope chain: file-level items + describe-level items.
  const fileItems  = ast.body;
  const groupItems = describe?.body ?? [];

  // Resolve the initial mock registry from file -> describe declarations.
  const mockRegistry = buildMockRegistry([...fileItems, ...groupItems]);

  // Merge config overrides from file -> describe level into the plugin JSON.
  const configOverrides = collectConfigOverrides([...fileItems, ...groupItems]);
  const effectivePlugin = applyConfigOverrides(pluginJson, configOverrides);

  // Collect call records per mock name.
  const callRecords = new Map<string, CallRecord[]>();

  // Per-case buffer of runtime errors reported by the WASM core. These come
  // from the C side via the error_report host callback (e.g. a builtin
  // returning -1, an unresolved host function, etc.) and are otherwise
  // swallowed silently.
  const runtimeErrors: RuntimeError[] = [];

  // Create a fresh runtime for this test case.
  const hostFunctions = buildHostFunctions(mockRegistry, callRecords);

  const runtime = await createRuntime({
    ...(config.manifest !== undefined ? { manifest: config.manifest } : {}),
    hostFunctions,
    tracing: config.tracing ?? false,
    errorReporter: (err) => {
      runtimeErrors.push(err);
      dbg(
        config.debug,
        `case [${tc.label}]: runtime error code=${err.code} ctx=${err.context ?? "?"} msg=${err.message}`,
      );
    },
  });
  dbg(config.debug, `case [${describe?.label ?? "-"} > ${tc.label}]: runtime online`);

  const plugin = runtime.loadPlugin(effectivePlugin);
  dbg(config.debug, `case [${tc.label}]: loaded plugin slot=${plugin.id} name=${effectivePlugin["name"]}`);

  const makeGetGlobal = () => (name: string) =>
    runtime.getGlobalValue(plugin, name);

  const makeGetConfig = () => (name: string) => {
    const cfg = (effectivePlugin.config as Record<string, { default: unknown; type: string }> | undefined)?.[name];

    if (!cfg) return undefined;
    
    return { 
        type: cfg.type as RuntimeValue["type"], 
        value: cfg.default 
    } as RuntimeValue;
  };

  try {
    // Execute file-level setup.
    const fileSetup = fileItems.find((i): i is SetupNode => i.kind === "Setup");

    if (fileSetup) {
      dbg(config.debug, `case [${tc.label}]: running file-level setup (${fileSetup.steps.length} steps)`);
      const setupFailures = await executeSteps(
        fileSetup.steps,
        runtime,
        plugin,
        mockRegistry,
        callRecords,
        runtimeErrors,
        makeGetGlobal,
        makeGetConfig,
        config.debug,
      );

      failures.push(...setupFailures);
    }

    // Execute describe-level setup (after file-level setup).
    const groupSetup = groupItems.find((i): i is SetupNode => i.kind === "Setup");

    if (groupSetup) {
      dbg(config.debug, `case [${tc.label}]: running describe-level setup (${groupSetup.steps.length} steps)`);
      const setupFailures = await executeSteps(
        groupSetup.steps,
        runtime,
        plugin,
        mockRegistry,
        callRecords,
        runtimeErrors,
        makeGetGlobal,
        makeGetConfig,
        config.debug,
      );

      failures.push(...setupFailures);
    }

    // Execute the test case steps.
    if (failures.length === 0) {
      dbg(config.debug, `case [${tc.label}]: running test body (${tc.steps.length} steps)`);
      const stepFailures = await executeSteps(
        tc.steps,
        runtime,
        plugin,
        mockRegistry,
        callRecords,
        runtimeErrors,
        makeGetGlobal,
        makeGetConfig,
        config.debug,
      );

      failures.push(...stepFailures);
    }
  } catch (err) {
    failures.push({
      stepIndex: -1,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    runtime.freePlugin(plugin);
    runtime.dispose();
  }

  const trace = config.tracing ? runtime.getTrace() : [];
  const kind = failures.length === 0 ? "pass"
    : failures.some((f) => f.stepIndex === -1) ? "error"
    : "fail";

  return {
    kind,
    label: tc.label,
    describe: describe?.label ?? null,
    failures,
    trace,
    durationMs: performance.now() - caseStart,
  };
}

// --- Step execution ---------------------------------------------------------

/**
 * Execute a list of steps and return any failures. The `mockRegistry` and
 * `callRecords` are mutated in place so that step-level `MockDeclNode`
 * re-declarations take effect for subsequent steps.
 */
async function executeSteps(
  steps: TestStep[],
  runtime: Runtime,
  plugin: import("../../runtime/types.js").PluginHandle,
  mockRegistry: Map<string, MockDeclNode>,
  callRecords: Map<string, CallRecord[]>,
  runtimeErrors: RuntimeError[],
  getGlobal: () => (name: string) => RuntimeValue | undefined,
  getConfig: () => (name: string) => RuntimeValue | undefined,
  debug?: boolean,
): Promise<TestFailure[]> {
  const failures: TestFailure[] = [];

  // Snapshot the runtime-error buffer cursor at the start of each step. After
  // a plugin-affecting step (Emit, CallTest, AssignGlobal, ConfigOverride)
  // we drain newly reported errors and surface them as failures attached to
  // the step that triggered them. Without this, errors from inside an event
  // handler (e.g. a builtin returning -1, an unresolved host fn) would be
  // silently swallowed and only manifest as downstream "ble_write was called
  // 0 times" mismatches.
  const drainRuntimeErrors = (
    cursor: number,
    stepIndex: number,
    contextLabel: string,
  ): void => {
    while (cursor < runtimeErrors.length) {
      const err = runtimeErrors[cursor++]!;

      failures.push({
        stepIndex,
        message:
          `runtime error during ${contextLabel}: ` +
          `${err.message}${err.context ? ` (in ${err.context})` : ""} ` +
          `[code=${err.code}]`,
      });
    }
  };

  for (let i = 0; i < steps.length; i++) {
    const step: TestStep = steps[i]!;
    dbg(debug, `  step[${i}] ${step.kind}${describeStep(step)}`);

    const errCursor = runtimeErrors.length;

    try {
      switch (step.kind) {
        case "MockDecl": {
          // Re-declaration: override the mock for all subsequent steps.
          mockRegistry.set(step.name, step);

          // Re-wire the host function to the updated body.
          runtime.engine.registerHostFunction(
            step.name,
            buildMockFn(step, callRecords),
          );

          break;
        }

        case "ConfigOverride": {
          // Apply config overrides at step time via setVariable.
          // TODO: this sets the runtime variable namespace; whether the plugin
          // reads config fields as variables depends on the WASM ABI. A future
          // revision may need to use a dedicated setConfig API if one is added.
          const env = { getConfig: getConfig(), getGlobal: getGlobal() };

          for (const decl of step.declarations) {
            const value = evalExpr(decl.default, env);
            runtime.setVariable(plugin, decl.name, value);
          }

          break;
        }

        case "Emit": {
          const env = { getConfig: getConfig(), getGlobal: getGlobal() };

          // TODO: fireEvent currently accepts a single integer arg. When the
          // runtime supports multi-arg events, pass the full evaluated list.
          const firstArg = step.arg?.[0];
          const arg = firstArg !== undefined ? toEventArg(evalExpr(firstArg, env)) : 0;

          const result = runtime.fireEvent(plugin, step.event, arg);

          dbg(
            debug,
            `    -> fireEvent ${step.event} success=${result.success} errorCode=${result.errorCode}`,
          );
          // Drain anything the C side reported (per-action -1 returns,
          // unresolved host fn calls, etc.) before deciding the step outcome.
          drainRuntimeErrors(errCursor, i, `emit :${step.event}`);

          if (!result.success) {
            failures.push({
              stepIndex: i,
              message:
                `emit :${step.event} did not complete successfully ` +
                `(errorCode=${result.errorCode})`,
            });
          }

          break;
        }

        case "CallTest": {
          const env = { getConfig: getConfig(), getGlobal: getGlobal() };
          const args = evalArgs(step.args, env);

          const result = runtime.callFunction(plugin, step.name, args);

          dbg(
            debug,
            `    -> callFunction ${step.name} success=${result.success} errorCode=${result.errorCode}`,
          );

          drainRuntimeErrors(errCursor, i, `call ${step.name}`);
          if (!result.success) {
            failures.push({
              stepIndex: i,
              message:
                `call ${step.name} did not complete successfully ` +
                `(errorCode=${result.errorCode})`,
            });
          }
          
          break;
        }

        case "AssignGlobal": {
          const env = { getConfig: getConfig(), getGlobal: getGlobal() };
          const value = evalExpr(step.value, env);

          runtime.setGlobalValue(plugin, step.name, value);
          break;
        }

        case "Assert": {
          const env = { getConfig: getConfig(), getGlobal: getGlobal() };
          const value = evalExpr(step.condition, env);

          if (!isTruthy(value)) {
            failures.push({
              stepIndex: i,
              message: `assert failed`,
              received: `${value.value}`,
            });
          }

          break;
        }

        case "Expect": {
          const failure = evaluateExpect(step, callRecords, getConfig, getGlobal, i);
          if (failure) failures.push(failure);
          break;
        }
      }
    } catch (err) {
      failures.push({
        stepIndex: i,
        message: err instanceof EvalError
          ? err.message
          : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return failures;
}

// --- Expect evaluation ------------------------------------------------------

/**
 * "Expect" in our test language relates to function calls (and eventually other things
 * that should *happen*). It describes behaviour expectations, not value assertions.
 */
function evaluateExpect(
  stmt: ExpectStmt,
  callRecords: Map<string, CallRecord[]>,
  getConfig: () => (name: string) => RuntimeValue | undefined,
  getGlobal: () => (name: string) => RuntimeValue | undefined,
  stepIndex: number,
): TestFailure | null {
  let records = callRecords.get(stmt.name) ?? [];

  // Filter by argument match if `with` args are specified.
  if (stmt.args !== null) {
    const env = { getConfig: getConfig(), getGlobal: getGlobal() };
    const expected = evalArgs(stmt.args, env);
    records = records.filter((r) => argsMatch(r.args, expected));
  }

  const count = records.length;

  // Evaluate the count constraint.
  let satisfied: boolean;

  if (stmt.times !== null) {
    satisfied = compareCount(count, stmt.times.op, stmt.times.count);
  } else {
    satisfied = count > 0;
  }

  if (stmt.negated) satisfied = !satisfied;

  if (!satisfied) {
    return {
      stepIndex,
      message: buildExpectMessage(stmt, count),
      expected: buildExpectDescription(stmt),
      received: `called ${count} time${count === 1 ? "" : "s"}`,
    };
  }

  return null;
}

function argsMatch(actual: RuntimeValue[], expected: RuntimeValue[]): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((a, i) => runtimeValuesEqual(a, expected[i]!));
}

function compareCount(
  count: number,
  op: "==" | "!=" | ">=" | ">" | "<=" | "<",
  target: number,
): boolean {
  switch (op) {
    case "==": return count === target;
    case "!=": return count !== target;
    case ">=": return count >= target;
    case ">":  return count >  target;
    case "<=": return count <= target;
    case "<":  return count <  target;
  }
}

function buildExpectMessage(stmt: ExpectStmt, actualCount: number): string {
  const negStr = stmt.negated ? "not " : "";
  const withStr = stmt.args !== null ? ` with the specified arguments` : "";

  if (stmt.times !== null) {
    return (
      `expect ${stmt.name} ${negStr}called ${stmt.times.op} ${stmt.times.count} times${withStr}: ` +
      `was called ${actualCount} time${actualCount === 1 ? "" : "s"}`
    );
  }

  return (
    `expect ${stmt.name} ${negStr}called${withStr}: ` +
    `was called ${actualCount} time${actualCount === 1 ? "" : "s"}`
  );
}

function buildExpectDescription(stmt: ExpectStmt): string {
  const parts: string[] = [stmt.negated ? "not called" : "called"];

  if (stmt.args !== null) parts.push("with matching args");
  if (stmt.times !== null) parts.push(`${stmt.times.op} ${stmt.times.count} times`);

  return parts.join(", ");
}

// --- Mock building ----------------------------------------------------------

interface CallRecord {
  args: RuntimeValue[];
  returnValue: RuntimeValue;
  simulatedMs: number;
}

/**
 * Build the initial mock registry from the items of a scope (file or describe
 * level). Only `MockDeclNode` items contribute; others are ignored.
 */
function buildMockRegistry(items: (TestBodyItem | TestStep)[]): Map<string, MockDeclNode> {
  const registry = new Map<string, MockDeclNode>();

  for (const item of items) {
    if (item.kind === "MockDecl") {
      registry.set(item.name, item);
    }
  }

  return registry;
}

/**
 * Build a `Record<name, HostFunction>` from the current mock registry, for
 * passing to `createRuntime`.
 */
function buildHostFunctions(
  registry: Map<string, MockDeclNode>,
  callRecords: Map<string, CallRecord[]>,
): Record<string, HostFunction> {
  const result: Record<string, HostFunction> = {};

  for (const [name, decl] of registry) {
    result[name] = buildMockFn(decl, callRecords);
  }

  return result;
}

/**
 * Build a single `HostFunction` from a `MockDeclNode`.
 * The function evaluates the mock body with parameters bound from the call
 * arguments, records the call, and returns the evaluated value.
 */
function buildMockFn(
  decl: MockDeclNode,
  callRecords: Map<string, CallRecord[]>,
): HostFunction {
  return (args, ctx) => {
    // Bind positional params to the incoming args.
    const locals = new Map<string, RuntimeValue>();

    for (let i = 0; i < decl.params.length; i++) {
      const param = decl.params[i];
      const arg   = args[i] ?? { type: "int" as const, value: 0 };
      if (param) locals.set(param.name, arg);
    }

    const returnValue = evalExpr(decl.body, { locals });

    const record: CallRecord = { args, returnValue, simulatedMs: ctx.simulatedMs };
    const list = callRecords.get(decl.name) ?? [];

    list.push(record);
    callRecords.set(decl.name, list);

    return returnValue;
  };
}

// --- Config override handling -----------------------------------------------

/**
 * Collect all `ConfigOverrideNode` items from a scope, in order.
 * Items earlier in the list are shadowed by later ones for the same key.
 */
function collectConfigOverrides(items: (TestBodyItem | TestStep)[]): ConfigOverrideNode[] {
  return items.filter((i): i is ConfigOverrideNode => i.kind === "ConfigOverride");
}

/**
 * Return a shallow clone of `pluginJson` with the config field defaults
 * patched from the given override nodes.
 *
 * The `config` section of the plugin JSON has entries shaped like:
 *   `{ type: "int", default: 50, min: 0, max: 100 }`
 * We evaluate the override `default` expression (using only literal values,
 * as no runtime is available yet) and replace `default` in the clone.
 */
function applyConfigOverrides(
  pluginJson: Record<string, unknown>,
  overrides: ConfigOverrideNode[],
): Record<string, unknown> {
  if (overrides.length === 0) return pluginJson;

  const config = structuredClone(
    (pluginJson.config as Record<string, Record<string, unknown>> | undefined) ?? {},
  );

  for (const override of overrides) {
    for (const decl of override.declarations) {
      try {
        const value = evalExpr(decl.default, {});
        const existing = config[decl.name] ?? {};
        config[decl.name] = { ...existing, default: value.value };
      } catch {
        // If evaluation fails (e.g. config.field references another value),
        // leave the existing default in place; a step-level ConfigOverride
        // can still apply it at runtime via setVariable.
        // TODO: We should still report the error
      }
    }
  }

  return { ...pluginJson, config };
}

// --- Helpers ----------------------------------------------------------------

/** Flat list of all test cases with their containing describe block (if any). */
function collectTestCases(ast: TestFileNode): Array<{ tc: TestCaseNode; describe: DescribeNode | null }> {
  const cases: Array<{ tc: TestCaseNode; describe: DescribeNode | null }> = [];

  for (const item of ast.body) {
    if (item.kind === "TestCase") {
      cases.push({ tc: item, describe: null });

    } else if (item.kind === "Describe") {

      for (const inner of item.body) {
        if (inner.kind === "TestCase") {
          cases.push({ tc: inner, describe: item });
        }
      }

    }
  }

  return cases;
}

function isTruthy(v: RuntimeValue): boolean {
  switch (v.type) {
    case "bool":   return v.value as boolean;
    case "int":
    case "float":  return (v.value as number) !== 0;
    case "string": return (v.value as string).length > 0;
    case "bytes":  return false;
  }
}

function unmatchedSuiteResult(pluginRef: string): TestSuiteResult {
  return errorSuiteResult(
    pluginRef,
    `No plugin matching slug '${moduleNameToSlug(pluginRef)}' was provided to the test runner.`,
  );
}

function errorSuiteResult(pluginRef: string, message: string): TestSuiteResult {
  return {
    pluginRef,
    cases: [
      {
        kind: "error",
        label: "(setup)",
        describe: null,
        failures: [
          {
            stepIndex: -1,
            message,
          },
        ],
        trace: [],
        durationMs: 0,
      },
    ],
    passed: 0,
    failed: 0,
    errored: 1,
    durationMs: 0,
  };
}

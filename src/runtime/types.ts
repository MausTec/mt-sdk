/**
 * Runtime module types.
 *
 * Defines the interface between the TypeScript harness and the mt-actions
 * WASM core. The WASM binary handles all plugin execution (parsing, builtins,
 * scoping, control flow). TypeScript handles host function dispatch, tracing,
 * error reporting, and plugin lifecycle management.
 * 
 * TODO: The separation of concerns is not yet complete. Many of these functions 
 * interact with the WASM boundary in a way that should be handled by the mt-runtimes
 * package directly. The Runtime module in mt-sdk should just wire up the runtime
 * presented in mt-runtimes, not control how it works or implement its arg checker, etc.
 */

import type { ApiDescriptor, HostFunctionDescriptor } from "../analysis/types.js";

// --- Values ------------------------------------------------------------------

/** Runtime value types matching mt-actions MTA_ARG_* tags. */
export type ValueType = "int" | "float" | "string" | "bool" | "bytes";

/**
 * A typed runtime value crossing the WASM / JS boundary.
 * Mirrors mta_arg_t on the C side.
 */
export interface RuntimeValue {
  type: ValueType;
  value: number | string | boolean;
}

// --- Plugin handles ----------------------------------------------------------

/**
 * Opaque reference to a plugin loaded inside the WASM runtime.
 * The numeric id maps to a slot in the C-side plugin table.
 */
export interface PluginHandle {
  readonly id: number;
  readonly displayName: string;
  readonly pluginType: string | undefined;
}

// --- Host function dispatch --------------------------------------------------

/**
 * Context passed to host function stubs during execution.
 * Gives the stub access to simulation state without coupling to internals.
 */
export interface HostCallContext {
  /** Wall-clock-ish simulated milliseconds since runtime creation. */
  simulatedMs: number;
  /** The plugin that triggered this call. */
  pluginId: number;
  /** Current plugin config snapshot (read-only). */
  pluginConfig: Readonly<Record<string, unknown>>;

  /**
   * Raise a structured runtime error from inside a host function.
   *
   * Sugar for `throw new MtaError(kind, message)`, the wrapping
   * `hostDispatch` translates the throw into a C-side `mta_raise()` call,
   * setting the structured runtime error and unwinding the script.
   */
  raise(kind: RuntimeErrorKind, message: string): never;

  /**
   * Validate the call's arguments against a positional spec list.
   *
   * Mirrors `mta_read_args()`: enforces arg count, kind compatibility, and
   * (for var-name) presence of the named binding. On any mismatch this
   * throws an `MtaError` with the appropriate `RuntimeErrorKind` and a
   * descriptive message; on success it returns the (still raw) argument
   * values for convenience.
   */
  readArgs(specs: ArgSpec[]): RuntimeValue[];
}

/**
 * Argument descriptor accepted by `HostCallContext.readArgs`.
 *
 * `kind` mirrors the `mta_arg_kind_t` C-side acceptance set:
 *   - `int`      — accepts integer values only
 *   - `float`    — accepts float values only
 *   - `number`   — accepts integer or float
 *   - `string`   — accepts string values
 *   - `var-name` — accepts an unresolved variable reference (rare; for
 *                  metaprogramming-style host functions)
 *   - `any`      — accepts any non-null value
 */
export interface ArgSpec {
  name: string;
  kind: "int" | "float" | "number" | "string" | "var-name" | "any";
}

/**
 * A host function implementation provided by the JS side.
 *
 * The return value is encoded back into the WASM scope by the bridge:
 *   - `number` -> `mta_return_int` if `Number.isInteger`, else `mta_return_float`
 *   - `string` -> `mta_return_string`
 *   - `boolean` -> `mta_return_int` (0 / 1)
 *   - `RuntimeValue` -> matching `mta_return_*` per `type` (use this when the
 *     numeric heuristic is wrong, e.g. a `5.0` that should be a float)
 *   - `void` / `undefined` -> `mta_return_void`
 *
 * Throw an `MtaError` (or call `ctx.raise(...)`) to translate into a
 * C-side `mta_raise()` call. Other thrown errors surface as
 * `RuntimeErrorKind = "unknown"`.
 */
export type HostFunction = (
  args: RuntimeValue[],
  context: HostCallContext,
) => RuntimeValue | number | string | boolean | void;

// --- Callbacks from WASM -----------------------------------------------------

/**
 * Fired by the WASM core when a non-builtin function name is encountered
 * that has no explicitly registered host function.
 */
export type UnresolvedFunctionHandler = (
  name: string,
  args: RuntimeValue[],
  context: HostCallContext,
) => RuntimeValue | void;

/**
 * Fired by the WASM core for diagnostic tracing: action entry/exit,
 * variable mutations, condition evaluations, scope push/pop.
 */
export interface TraceEvent {
  kind:
    | "action_enter"
    | "action_exit"
    | "event_enter"
    | "event_exit"
    | "fn_enter"
    | "fn_exit"
    | "cond_eval"
    | "loop_iter"
    | "note"
    | "error"
    | "variable_set"
    | "variable_get"
    | "condition_eval"
    | "scope_push"
    | "scope_pop"
    | "host_call"
    | "host_return"
    | "function_call"
    | "function_return";
  pluginId: number;
  /** Action or variable name. */
  name: string;
  /** Contextual detail (args, value, condition result, etc.) */
  detail?: unknown;
  /** Monotonic timestamp in simulated ms. */
  timestamp: number;
}

export type TraceObserver = (event: TraceEvent) => void;

/**
 * Structured runtime error kinds, matching mta_runtime_error_kind_t /
 * the WIT runtime-error-kind enum. These are executor-detected contract
 * violations (distinct from the $! status codes a script can recover from).
 *
 * When `RuntimeError.code` carries one of these tags, the WASM runtime
 * raised it via `mta_raise()`. Tooling can pattern-match on `errorKind`
 * to surface user-actionable messages.
 * 
 * TODO: Evaluate moving this to mt-runtimes when we're ready to update the runtime container.
 */
export type RuntimeErrorKind =
  | "unknown"
  | "var_not_set"
  | "cycle_detected"
  | "missing_return"
  | "arg_count_mismatch"
  | "missing_arg"
  | "unknown_arg"
  | "type_mismatch"
  | "host_dispatch_failed";

/**
 * Thrown from inside a `HostFunction` (typically via `ctx.raise(kind, msg)`)
 * to translate into a C-side `mta_raise()` call.
 *
 * The bridge's `hostDispatch` wrapper catches instances of this class and
 * encodes them as `HostError` on the way back across the WIT boundary.
 * Any other thrown value is wrapped as `RuntimeErrorKind = "unknown"`.
 */
export class MtaError extends Error {
  readonly kind: RuntimeErrorKind;
  constructor(kind: RuntimeErrorKind, message: string) {
    super(message);
    this.name = "MtaError";
    this.kind = kind;
  }
}

/**
 * Fired when the WASM core encounters a runtime error.
 * Maps to mta_error_t codes from the C side.
 */
export interface RuntimeError {
  code: number;
  message: string;
  pluginId: number;
  /** Function or event that was executing when the error occurred. */
  context?: string | undefined;
  /** Structured kind, when the error originated from `mta_raise()`. */
  errorKind?: RuntimeErrorKind;
}

export type ErrorReporter = (error: RuntimeError) => void;

/**
 * Fired when a plugin writes config via the set_config builtin.
 * The harness can persist, log, or validate the change.
 */
export type ConfigSaveHandler = (
  pluginId: number,
  config: Record<string, unknown>,
) => boolean;

// --- Event execution results -------------------------------------------------

/**
 * Result of firing a single event on a loaded plugin.
 */
export interface EventResult {
  /** Final $_ value after the event handler completed. */
  accumulator: RuntimeValue;
  /** Final $! error code (0 = OK). */
  errorCode: number;
  /** Whether execution completed without errors. */
  success: boolean;
}

/**
 * Result of calling a plugin-defined function.
 */
export interface CallResult {
  /** Final $_ value. */
  accumulator: RuntimeValue;
  /** Final $! error code. */
  errorCode: number;
  success: boolean;
}

// --- Engine interface --------------------------------------------------------

export interface RuntimeEngine {
  /** Initialize builtins. Called once after WASM instantiation. */
  init(): void;

  /**
   * Register a host function by name, optionally with a permission guard.
   */
  registerHostFunction(
    name: string,
    fn: HostFunction,
    permission?: string | null,
  ): void;

  /** Set the fallback handler for function names not explicitly registered. */
  setUnresolvedHandler(handler: UnresolvedFunctionHandler): void;

  /** Set the trace observer callback. */
  setTraceObserver(observer: TraceObserver): void;

  /** Set the error reporter callback. */
  setErrorReporter(reporter: ErrorReporter): void;

  /** Set the config save callback. */
  setConfigSaveHandler(handler: ConfigSaveHandler): void;

  /** Load a plugin from its JSON representation. Returns an opaque handle. */
  loadPlugin(json: Record<string, unknown>): PluginHandle;

  /** Fire a named event with positional arguments bound to formal params. */
  fireEvent(
    plugin: PluginHandle,
    event: string,
    args: RuntimeValue[],
  ): EventResult;

  /** Call a plugin-defined function by name. */
  callFunction(
    plugin: PluginHandle,
    name: string,
    args: RuntimeValue[],
  ): CallResult;

  /** Read a plugin-scoped variable. */
  getVariable(plugin: PluginHandle, name: string): RuntimeValue | undefined;

  /** Write a plugin-scoped variable. */
  setVariable(plugin: PluginHandle, name: string, value: RuntimeValue): void;

  /**
   * Read a global variable from the plugin's persistent globals scope.
   * Every loaded plugin has a persistent globals scope seeded from its
   * "variables" block; values written by plugin code or via
   * `setGlobalValue` survive across event invocations.
   */
  getGlobalValue(plugin: PluginHandle, name: string): RuntimeValue | undefined;

  /** Write a global variable in the plugin's persistent globals scope. */
  setGlobalValue(plugin: PluginHandle, name: string, value: RuntimeValue): void;

  /**
   * Reset the plugin's globals scope, re-seeding from the plugin's
   * "variables" block defaults. Useful between test cases or when a host
   * wants to reset plugin state without re-loading the plugin JSON.
   */
  resetGlobals(plugin: PluginHandle): boolean;

  /** Release all resources for a loaded plugin. */
  freePlugin(plugin: PluginHandle): void;

  /** Tear down the entire engine (WASM instance, memory, etc.). */
  dispose(): void;
}

// --- Runtime creation options ------------------------------------------------

/**
 * Options for createRuntime().
 */
export interface RuntimeOptions {
  /**
   * API manifest describing available host functions and events.
   * Used to auto-generate stubs for any host function not explicitly provided.
   */
  manifest?: ApiDescriptor;

  /**
   * Explicit host function implementations. These override auto-generated stubs.
   */
  hostFunctions?: Record<string, HostFunction>;

  /**
   * Handler for function calls that aren't registered as host functions
   * and aren't builtins. Defaults to logging a warning and returning 0.
   */
  unresolvedHandler?: UnresolvedFunctionHandler;

  /** Enable trace capture. Default: true. */
  tracing?: boolean;

  /**
   * Live trace observer fired for each event as it arrives, in addition to
   * being collected for `getTrace()`.
   */
  traceObserver?: TraceObserver;

  /** Custom error reporter. Errors are always collected; this gets a live callback. */
  errorReporter?: ErrorReporter;

  /** Custom config save handler. */
  configSaveHandler?: ConfigSaveHandler;
}

/**
 * A fully initialized runtime ready to load plugins and fire events.
 * This is the public interface returned by createRuntime().
 */
export interface Runtime {
  /** The underlying engine (exposed for advanced use / testing). */
  readonly engine: RuntimeEngine;

  /** The manifest this runtime was configured with, if any. */
  readonly manifest: ApiDescriptor | undefined;

  /** Load a plugin JSON and return a handle for interacting with it. */
  loadPlugin(json: Record<string, unknown>): PluginHandle;

  /** Fire an event on a loaded plugin with positional args. */
  fireEvent(
    plugin: PluginHandle,
    event: string,
    args: RuntimeValue[],
  ): EventResult;

  /** Call a plugin-defined function. */
  callFunction(
    plugin: PluginHandle,
    name: string,
    args: RuntimeValue[],
  ): CallResult;

  /** Read a plugin variable. */
  getVariable(plugin: PluginHandle, name: string): RuntimeValue | undefined;

  /** Write a plugin variable. */
  setVariable(plugin: PluginHandle, name: string, value: RuntimeValue): void;

  /**
   * Read a global variable from the plugin's persistent globals scope.
   * Every loaded plugin has a persistent globals scope seeded from its
   * "variables" block; values written by plugin code or via
   * `setGlobalValue` survive across event invocations.
   */
  getGlobalValue(plugin: PluginHandle, name: string): RuntimeValue | undefined;

  /** Write a global variable in the plugin's persistent globals scope. */
  setGlobalValue(plugin: PluginHandle, name: string, value: RuntimeValue): void;

  /**
   * Reset the plugin's globals scope, re-seeding from the plugin's
   * "variables" block defaults.
   */
  resetGlobals(plugin: PluginHandle): boolean;

  /** Get the accumulated trace since last clear. */
  getTrace(): TraceEvent[];

  /** Clear the accumulated trace. */
  clearTrace(): void;

  /** Get all collected errors since last clear. */
  getErrors(): RuntimeError[];

  /** Clear collected errors. */
  clearErrors(): void;

  /** Free a plugin and its resources. */
  freePlugin(plugin: PluginHandle): void;

  /** Tear down the runtime entirely. */
  dispose(): void;
}

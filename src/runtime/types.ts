/**
 * Runtime module types.
 *
 * Defines the interface between the TypeScript harness and the mt-actions
 * WASM core. The WASM binary handles all plugin execution (parsing, builtins,
 * scoping, control flow). TypeScript handles host function dispatch, tracing,
 * error reporting, and plugin lifecycle management.
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
}

/**
 * A host function implementation provided by the JS side.
 * Return value is written to $_ in the calling scope.
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
 * Fired when the WASM core encounters a runtime error.
 * Maps to mta_error_t codes from the C side.
 */
export interface RuntimeError {
  code: number;
  message: string;
  pluginId: number;
  /** Function or event that was executing when the error occurred. */
  context?: string | undefined;
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

  /** Fire a named event with an integer argument. */
  fireEvent(plugin: PluginHandle, event: string, arg: number): EventResult;

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

  /** Fire an event on a loaded plugin. */
  fireEvent(plugin: PluginHandle, event: string, arg: number): EventResult;

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

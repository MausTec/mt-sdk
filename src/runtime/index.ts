/**
 * mt-sdk runtime module.
 *
 * Provides the public API for loading and executing mt-actions plugins via
 * the WASM-compiled C runtime. Host functions are implemented in JavaScript
 * and dispatched through the WASM boundary.
 *
 * Usage:
 *
 *   import { createRuntime } from "@maustec/mt-sdk/runtime";
 *   import { getLatestApiDescriptor } from "@maustec/mt-runtimes";
 *
 *   const runtime = await createRuntime({
 *     wasm: "@maustec/mt-runtimes/wasm/mt-actions-core.wasm",
 *     manifest: getLatestApiDescriptor("EOM3K"),
 *   });
 *
 *   const plugin = runtime.loadPlugin(pluginJson);
 *   const result = runtime.fireEvent(plugin, "modeSet", 128);
 *   console.log(result.trace);
 */

import type {
  Runtime,
  RuntimeOptions,
  PluginHandle,
  RuntimeValue,
  EventResult,
  CallResult,
  TraceEvent,
  RuntimeError,
} from "./types.js";
import { createWasmEngine } from "./wasm/index.js";
import { HostRegistry } from "./host/registry.js";
import { registerFromManifest } from "./host/auto-stub.js";
import { TraceCollector } from "./trace.js";

// --- Convenience Re-exports -------------------------------------------------

export type {
  Runtime,
  RuntimeOptions,
  RuntimeEngine,
  PluginHandle,
  RuntimeValue,
  ValueType,
  EventResult,
  CallResult,
  HostFunction,
  HostCallContext,
  UnresolvedFunctionHandler,
  TraceEvent,
  TraceObserver,
  RuntimeError,
  ErrorReporter,
  ConfigSaveHandler,
} from "./types.js";

export { HostRegistry } from "./host/registry.js";
export { registerFromManifest } from "./host/auto-stub.js";
export { defaultStubs } from "./host/stubs.js";
export { TraceCollector } from "./trace.js";
export { formatTrace, formatTraceEvent, traceToJson } from "./format.js";

// --- Factory ----------------------------------------------------------------

/**
 * Create and initialize a runtime instance.
 *
 * This is the main entry point. It:
 * 1. Loads and instantiates the WASM module
 * 2. Initializes builtins
 * 3. Registers host functions from the manifest (auto-stubbed) and overrides
 * 4. Wires up tracing, error reporting, and config save callbacks
 */
export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const engine = await createWasmEngine(options.wasm);
  engine.init();

  // Host function setup
  const registry = new HostRegistry();

  if (options.manifest) {
    registerFromManifest(registry, options.manifest, options.hostFunctions);
  } else if (options.hostFunctions) {
    registry.registerAll(options.hostFunctions);
  }

  // Wire all registered host functions into the WASM engine
  for (const entry of registry.entries()) {
    engine.registerHostFunction(entry.name, entry.fn, entry.permission);
  }

  // Tracing
  const tracing = options.tracing !== false; // default: on
  const collector = new TraceCollector();

  if (tracing) {
    engine.setTraceObserver(collector.observer());
  }

  // Error collection
  const errors: RuntimeError[] = [];
  engine.setErrorReporter((error) => {
    errors.push(error);
    options.errorReporter?.(error);
  });

  // Unresolved handler
  if (options.unresolvedHandler) {
    engine.setUnresolvedHandler(options.unresolvedHandler);
  }

  // Config save
  if (options.configSaveHandler) {
    engine.setConfigSaveHandler(options.configSaveHandler);
  }

  return {
    engine,
    manifest: options.manifest,

    loadPlugin(json: Record<string, unknown>): PluginHandle {
      return engine.loadPlugin(json);
    },

    fireEvent(plugin: PluginHandle, event: string, arg: number): EventResult {
      return engine.fireEvent(plugin, event, arg);
    },

    callFunction(
      plugin: PluginHandle,
      name: string,
      args: RuntimeValue[],
    ): CallResult {
      return engine.callFunction(plugin, name, args);
    },

    getVariable(
      plugin: PluginHandle,
      name: string,
    ): RuntimeValue | undefined {
      return engine.getVariable(plugin, name);
    },

    setVariable(
      plugin: PluginHandle,
      name: string,
      value: RuntimeValue,
    ): void {
      engine.setVariable(plugin, name, value);
    },

    getTrace(): TraceEvent[] {
      return [...collector.getEvents()];
    },

    clearTrace(): void {
      collector.clear();
    },

    getErrors(): RuntimeError[] {
      return [...errors];
    },

    clearErrors(): void {
      errors.length = 0;
    },

    freePlugin(plugin: PluginHandle): void {
      engine.freePlugin(plugin);
    },

    dispose(): void {
      engine.dispose();
      registry.clear();
      collector.clear();
      errors.length = 0;
    },
  };
}

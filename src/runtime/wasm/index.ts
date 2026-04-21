/**
 * WASM engine: RuntimeEngine implementation backed by the mt-actions WASM core.
 *
 * This is the sole execution backend. All plugin parsing, builtin execution,
 * scoping, and control flow happen in WASM (the same C code as firmware).
 * Host functions, tracing, error reporting, and config saves dispatch to JS.
 */

import type {
  RuntimeEngine,
  PluginHandle,
  RuntimeValue,
  HostFunction,
  UnresolvedFunctionHandler,
  TraceObserver,
  TraceEvent,
  ErrorReporter,
  RuntimeError,
  ConfigSaveHandler,
  EventResult,
  CallResult,
  HostCallContext,
} from "../types.js";
import type { WasmSource, WasmImports } from "./loader.js";
import { instantiateRuntime } from "./loader.js";
import { createBindings, type BridgeBindings } from "./bindings.js";
import {
  readString,
  deserializeValue,
  deserializeArgs,
  serializeArgs,
  type EmscriptenModule,
} from "./memory.js";

/**
 * Create a WasmEngine from a WASM source.
 * This is async because WASM instantiation is async.
 */
export async function createWasmEngine(source: WasmSource): Promise<WasmEngine> {
  const engine = new WasmEngine();
  await engine.load(source);
  return engine;
}

/**
 * WasmEngine implementation.
 */
export class WasmEngine implements RuntimeEngine {
  private mod: EmscriptenModule | null = null;
  private bindings: BridgeBindings | null = null;

  // JS-side state
  private hostFunctions = new Map<string, HostFunction>();
  private unresolvedHandler: UnresolvedFunctionHandler | null = null;
  private traceObserver: TraceObserver | null = null;
  private errorReporter: ErrorReporter | null = null;
  private configSaveHandler: ConfigSaveHandler | null = null;
  private simulatedMs = 0;

  /**
   * Load and instantiate the WASM module.
   * Must be called before any other method.
   */
  async load(source: WasmSource): Promise<void> {
    const imports = this.buildImports();
    this.mod = await instantiateRuntime(source, imports);
    this.bindings = createBindings(this.mod);
  }

  init(): void {
    this.requireBindings().init();
  }

  registerHostFunction(
    name: string,
    fn: HostFunction,
    permission?: string | null,
  ): void {
    this.hostFunctions.set(name, fn);
    // Also register with the C runtime so it doesn't hit the unresolved path
    this.requireBindings().registerHostFunction(name, permission ?? null);
  }

  setUnresolvedHandler(handler: UnresolvedFunctionHandler): void {
    this.unresolvedHandler = handler;
  }

  setTraceObserver(observer: TraceObserver): void {
    this.traceObserver = observer;
    this.requireBindings().setTracing(true);
  }

  setErrorReporter(reporter: ErrorReporter): void {
    this.errorReporter = reporter;
  }

  setConfigSaveHandler(handler: ConfigSaveHandler): void {
    this.configSaveHandler = handler;
  }

  loadPlugin(json: Record<string, unknown>): PluginHandle {
    const jsonString = JSON.stringify(json);
    const id = this.requireBindings().loadPlugin(jsonString);

    if (id < 0) {
      throw new Error("Failed to load plugin: WASM bridge returned error");
    }

    return {
      id,
      displayName:
        typeof json["display_name"] === "string"
          ? json["display_name"]
          : "unknown",
      pluginType:
        typeof json["type"] === "string" ? json["type"] : undefined,
    };
  }

  fireEvent(plugin: PluginHandle, event: string, arg: number): EventResult {
    const bindings = this.requireBindings();
    const errorCode = bindings.fireEvent(plugin.id, event, arg);
    const resultStr = bindings.getLastResult();

    return {
      accumulator: deserializeValue(resultStr),
      errorCode,
      success: errorCode === 0,
    };
  }

  callFunction(
    plugin: PluginHandle,
    name: string,
    args: RuntimeValue[],
  ): CallResult {
    const argsJson = serializeArgs(args);
    const bindings = this.requireBindings();
    const errorCode = bindings.callFunction(plugin.id, name, argsJson);
    const resultStr = bindings.getLastResult();

    return {
      accumulator: deserializeValue(resultStr),
      errorCode,
      success: errorCode === 0,
    };
  }

  getVariable(plugin: PluginHandle, name: string): RuntimeValue | undefined {
    const json = this.requireBindings().getVariable(plugin.id, name);

    if (json === null) return undefined;
    return deserializeValue(json);
  }

  setVariable(plugin: PluginHandle, name: string, value: RuntimeValue): void {
    const valueJson = JSON.stringify({ type: value.type, value: value.value });
    this.requireBindings().setVariable(plugin.id, name, valueJson);
  }

  freePlugin(plugin: PluginHandle): void {
    this.requireBindings().freePlugin(plugin.id);
  }

  dispose(): void {
    this.hostFunctions.clear();
    this.unresolvedHandler = null;
    this.traceObserver = null;
    this.errorReporter = null;
    this.configSaveHandler = null;
    this.bindings = null;
    this.mod = null;
  }

  // --- Internal --------------------------------------------------------------

  private requireBindings(): BridgeBindings {
    if (!this.bindings) {
      throw new Error("WasmEngine not initialized! Call load() first");
    }

    return this.bindings;
  }

  private requireMod(): EmscriptenModule {
    if (!this.mod) {
      throw new Error("WasmEngine not initialized! Call load() first");
    }

    return this.mod;
  }

  private buildImports(): WasmImports {
    return {
      // C: int js_host_dispatch(int slot, const char* fn_name, const char* args_json, int arg_count)
      js_host_dispatch: (
        slot: number,
        fnNamePtr: number,
        argsJsonPtr: number,
        _argCount: number,
      ): number => {
        const mod = this.requireMod();
        const name = readString(mod, fnNamePtr);
        const argsJson = readString(mod, argsJsonPtr);
        const args = deserializeArgs(argsJson);
        const context = this.makeCallContext(slot);

        // Try explicit host function first
        const fn = this.hostFunctions.get(name);

        if (fn) {
          fn(args, context);
          return 0;
        }

        // Fall back to unresolved handler
        if (this.unresolvedHandler) {
          this.unresolvedHandler(name, args, context);
          return 0;
        }

        // No handler — report as error
        this.reportError({
          code: -1,
          message: `Unresolved host function: ${name}`,
          pluginId: slot,
          context: name,
        });

        return -1;
      },

      // C: int js_config_save(int slot)
      js_config_save: (slot: number): number => {
        if (!this.configSaveHandler) return 1;
        // Config save hook in bridge doesn't pass config JSON, just the slot.
        // The JS side can query config from the plugin if needed.
        return this.configSaveHandler(slot, {}) ? 1 : 0;
      },

      // C: void js_trace_event(int slot, int kind, const char* fn_name, int result)
      js_trace_event: (
        slot: number,
        kind: number,
        fnNamePtr: number,
        result: number,
      ): void => {
        if (!this.traceObserver) return;
        const mod = this.requireMod();
        const fnName = readString(mod, fnNamePtr);

        // kind maps to mta_trace_kind_t: 0=ACTION_ENTER, 1=ACTION_EXIT
        const traceKind = kind === 0 ? "action_enter" : "action_exit";

        const event: TraceEvent = {
          kind: traceKind,
          pluginId: slot,
          name: fnName,
          detail: { result },
          timestamp: this.simulatedMs,
        };

        this.traceObserver(event);
      },

      // C: void js_error_report(int slot, const char* fn_name, int error_code)
      js_error_report: (
        slot: number,
        fnNamePtr: number,
        errorCode: number,
      ): void => {
        const mod = this.requireMod();
        const fnName = readString(mod, fnNamePtr);
        
        this.reportError({
          code: errorCode,
          message: `Runtime error in ${fnName}`,
          pluginId: slot,
          context: fnName,
        });
      },
    };
  }

  private makeCallContext(pluginId: number): HostCallContext {
    return {
      simulatedMs: this.simulatedMs,
      pluginId,
      pluginConfig: {}, // FUTURE: read from WASM when bridge supports it
    };
  }

  private reportError(error: RuntimeError): void {
    if (this.errorReporter) {
      this.errorReporter(error);
    }
  }
}

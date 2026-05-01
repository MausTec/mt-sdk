/**
 * WASM engine: RuntimeEngine implementation backed by the mtp:core
 * Component Model bridge from @maustec/mt-runtimes.
 *
 * All plugin execution (parsing, builtins, scoping, control flow) happens
 * inside the WASM component. Host functions, tracing, error reporting, and
 * config saves dispatch to JS via the bridge's HostCallbacks interface.
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
  ConfigSaveHandler,
  EventResult,
  CallResult,
  HostCallContext,
} from "../types.js";
import {
  instantiateMtpCore,
  type Bridge,
  type HostCallbacks,
} from "@maustec/mt-runtimes";
import {
  runtimeValueToArgValue,
  argValueToRuntimeValue,
  runtimeValueToConfigValue,
  configValueToRuntimeValue,
} from "./convert.js";

/**
 * Create a WasmEngine backed by the mtp:core Component Model bridge.
 */
export async function createWasmEngine(): Promise<WasmEngine> {
  const engine = new WasmEngine();
  await engine.load();
  return engine;
}

/**
 * WasmEngine implementation using the mtp:core Component Model bridge.
 */
export class WasmEngine implements RuntimeEngine {
  private bridge: Bridge | null = null;

  // JS-side state
  private hostFunctions = new Map<string, HostFunction>();
  private unresolvedHandler: UnresolvedFunctionHandler | null = null;
  private traceObserver: TraceObserver | null = null;
  private errorReporter: ErrorReporter | null = null;
  private configSaveHandler: ConfigSaveHandler | null = null;
  private simulatedMs = 0;

  /**
   * Instantiate the WASM component.
   * Must be called before any other method.
   */
  async load(): Promise<void> {
    const { bridge } = await instantiateMtpCore({
      host: this.buildHostCallbacks(),
    });
    this.bridge = bridge;
  }

  init(): void {
    this.requireBridge().init();
  }

  registerHostFunction(
    name: string,
    fn: HostFunction,
    permission?: string | null,
  ): void {
    this.hostFunctions.set(name, fn);
    this.requireBridge().registerHostFunction(name, permission ?? undefined);
  }

  setUnresolvedHandler(handler: UnresolvedFunctionHandler): void {
    this.unresolvedHandler = handler;
  }

  setTraceObserver(observer: TraceObserver): void {
    this.traceObserver = observer;
    this.requireBridge().setTracing(true);
  }

  setErrorReporter(reporter: ErrorReporter): void {
    this.errorReporter = reporter;
  }

  setConfigSaveHandler(handler: ConfigSaveHandler): void {
    this.configSaveHandler = handler;
  }

  loadPlugin(json: Record<string, unknown>): PluginHandle {
    const jsonString = JSON.stringify(json);
    const id = this.requireBridge().loadPlugin(jsonString);

    if (id < 0) {
      throw new Error("Failed to load plugin: bridge returned error");
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
    const result = this.requireBridge().fireEvent(
      plugin.id,
      event,
      { tag: "int-val", val: arg },
    );

    return {
      accumulator: argValueToRuntimeValue(result.value),
      errorCode: result.error,
      success: result.error === 0,
    };
  }

  callFunction(
    plugin: PluginHandle,
    name: string,
    args: RuntimeValue[],
  ): CallResult {
    const result = this.requireBridge().callFunction(
      plugin.id,
      name,
      args.map(runtimeValueToArgValue),
    );

    return {
      accumulator: argValueToRuntimeValue(result.value),
      errorCode: result.error,
      success: result.error === 0,
    };
  }

  getVariable(plugin: PluginHandle, name: string): RuntimeValue | undefined {
    const cv = this.requireBridge().getConfigValue(plugin.id, name);
    if (cv === undefined) return undefined;
    return configValueToRuntimeValue(cv);
  }

  setVariable(plugin: PluginHandle, name: string, value: RuntimeValue): void {
    this.requireBridge().setConfigValue(
      plugin.id,
      name,
      runtimeValueToConfigValue(value),
    );
  }

  getGlobalValue(plugin: PluginHandle, name: string): RuntimeValue | undefined {
    const cv = this.requireBridge().getGlobalValue(plugin.id, name);
    if (cv === undefined) return undefined;
    return configValueToRuntimeValue(cv);
  }

  setGlobalValue(plugin: PluginHandle, name: string, value: RuntimeValue): void {
    this.requireBridge().setGlobalValue(
      plugin.id,
      name,
      runtimeValueToConfigValue(value),
    );
  }

  resetGlobals(plugin: PluginHandle): boolean {
    return this.requireBridge().resetGlobals(plugin.id);
  }

  freePlugin(plugin: PluginHandle): void {
    this.requireBridge().freePlugin(plugin.id);
  }

  dispose(): void {
    this.hostFunctions.clear();
    this.unresolvedHandler = null;
    this.traceObserver = null;
    this.errorReporter = null;
    this.configSaveHandler = null;
    this.bridge = null;
  }

  // --- Internal --------------------------------------------------------------

  private requireBridge(): Bridge {
    if (!this.bridge) {
      throw new Error("WasmEngine not initialized! Call load() first");
    }
    return this.bridge;
  }

  private buildHostCallbacks(): HostCallbacks {
    return {
      // Called when execution hits a host function dispatch.
      // fnName and args are already decoded — no heap pointer math needed.
      hostDispatch: (slot, fnName, args): number => {
        const runtimeArgs = args.map(argValueToRuntimeValue);
        const context = this.makeCallContext(slot);

        const fn = this.hostFunctions.get(fnName);

        if (fn) {
          fn(runtimeArgs, context);
          return 0;
        }

        if (this.unresolvedHandler) {
          this.unresolvedHandler(fnName, runtimeArgs, context);
          return 0;
        }

        this.reportError({
          code: -1,
          message: `Unresolved host function: ${fnName}`,
          pluginId: slot,
          context: fnName,
        });

        return -1;
      },

      // Called when a plugin requests a config save.
      configSave: (slot): boolean => {
        if (!this.configSaveHandler) return true;
        return this.configSaveHandler(slot, {});
      },

      // Called for diagnostic trace events when tracing is enabled.
      // kind comes through as the WIT hyphenated form; we normalize to the
      // underscore form used by TraceEvent.
      traceEvent: (slot, kind, fnName, retCode): void => {
        if (!this.traceObserver) return;

        const traceKind = (kind as string).replace(
          /-/g,
          "_",
        ) as TraceEvent["kind"];

        const event: TraceEvent = {
          kind: traceKind,
          pluginId: slot,
          name: fnName,
          detail: { result: retCode },
          timestamp: this.simulatedMs,
        };

        this.traceObserver(event);
      },

      // Called when the WASM runtime encounters an error.
      errorReport: (slot, fnName, errorCode): void => {
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
      pluginConfig: {},
    };
  }

  private reportError(error: Parameters<ErrorReporter>[0]): void {
    if (this.errorReporter) {
      this.errorReporter(error);
    }
  }
}
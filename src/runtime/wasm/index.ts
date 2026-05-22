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
  RuntimeErrorKind,
  ArgSpec,
} from "../types.js";
import { MtaError } from "../types.js";
import {
  instantiateMtpCore,
  type Bridge,
  type HostCallbacks,
  type HostResult,
  type ArgValue,
  type RuntimeErrorKind as WitRuntimeErrorKind,
} from "@maustec/mt-runtimes";
import {
  runtimeValueToArgValue,
  argValueToRuntimeValue,
  runtimeValueToConfigValue,
  configValueToRuntimeValue,
} from "./convert.js";

/**
 * Decode a runtime-error-kind ordinal (as emitted by the C side over WIT)
 * into the stable underscore-form tag used by tooling. The ordering MUST
 * match `mta_runtime_error_kind_t` in the WIT `runtime-error-kind` enum.
 * 
 * TODO: Delegate this to the mt-runtimes core when we're ready to push changes to MTR.
 */
const RUNTIME_ERROR_KINDS: readonly RuntimeErrorKind[] = [
  "unknown",
  "var_not_set",
  "cycle_detected",
  "missing_return",
  "arg_count_mismatch",
  "missing_arg",
  "unknown_arg",
  "type_mismatch",
  "host_dispatch_failed",
];

function runtimeErrorKindFromOrdinal(ordinal: number): RuntimeErrorKind {
  return RUNTIME_ERROR_KINDS[ordinal] ?? "unknown";
}

/**
 * Translate the underscore-form RuntimeErrorKind used in the JS API back
 * into the hyphen-form string union the WIT enum uses on the wire.
 * TODO: Move this to mt-runtimes since it's an internal WIT concern.
 */
function runtimeErrorKindToWit(kind: RuntimeErrorKind): WitRuntimeErrorKind {
  // The JS-side underscore form maps 1:1 onto the WIT hyphen form.
  return kind.replace(/_/g, "-") as WitRuntimeErrorKind;
}

/**
 * Encode a host function's return value as the `value` field of a HostResult.
 *
 * Heuristic for bare `number`: integers become `int-val`, non-integers become
 * `float-val`. Pass a `RuntimeValue` explicitly when the heuristic is wrong
 * (e.g. a float that happens to round to an integer).
 */
function encodeHostReturn(
  ret: RuntimeValue | number | string | boolean | void,
): ArgValue {
  if (ret === undefined || ret === null) {
    return { tag: "null-val" };
  }
  if (typeof ret === "number") {
    return Number.isInteger(ret)
      ? { tag: "int-val", val: ret }
      : { tag: "float-val", val: ret };
  }
  if (typeof ret === "string") {
    return { tag: "str-val", val: ret };
  }
  if (typeof ret === "boolean") {
    return { tag: "int-val", val: ret ? 1 : 0 };
  }
  // RuntimeValue
  return runtimeValueToArgValue(ret);
}

/**
 * Validate args against an `ArgSpec[]`, mirroring `mta_read_args()`.
 *
 * Throws `MtaError` with the matching `RuntimeErrorKind` on the first
 * violation; returns the unmodified args on success.
 */
function validateArgs(args: RuntimeValue[], specs: ArgSpec[]): RuntimeValue[] {
  if (args.length !== specs.length) {
    throw new MtaError(
      "arg_count_mismatch",
      `expected ${specs.length} arg(s), got ${args.length}`,
    );
  }
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const arg = args[i]!;
    const ok = matchesArgKind(arg, spec.kind);
    if (!ok) {
      throw new MtaError(
        "type_mismatch",
        `arg ${i} (${spec.name}): expected ${spec.kind}, got ${arg.type}`,
      );
    }
  }
  return args;
}

function matchesArgKind(arg: RuntimeValue, kind: ArgSpec["kind"]): boolean {
  switch (kind) {
    case "any":
      return true;
    case "int":
      return arg.type === "int";
    case "float":
      return arg.type === "float";
    case "number":
      return arg.type === "int" || arg.type === "float";
    case "string":
      return arg.type === "string";
    case "var-name":
      // var-name comes through as a string-typed bare reference on the JS side.
      return arg.type === "string";
    default:
      return false;
  }
}

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

  fireEvent(
    plugin: PluginHandle,
    event: string,
    args: RuntimeValue[],
  ): EventResult {
    const result = this.requireBridge().fireEvent(
      plugin.id,
      event,
      args.map(runtimeValueToArgValue),
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
      hostDispatch: (slot, fnName, args): HostResult => {
        const runtimeArgs = args.map(argValueToRuntimeValue);
        const context = this.makeCallContext(slot, runtimeArgs);

        const fn = this.hostFunctions.get(fnName);
        const handler: HostFunction | UnresolvedFunctionHandler | null =
          fn ?? this.unresolvedHandler ?? null;

        if (!handler) {
          this.reportError({
            code: -1,
            message: `Unresolved host function: ${fnName}`,
            pluginId: slot,
            context: fnName,
          });
          return {
            value: { tag: "null-val" },
            error: {
              kind: "host-dispatch-failed",
              message: `Unresolved host function: ${fnName}`,
            },
          };
        }

        this.traceObserver?.({
          kind: "host_call",
          pluginId: slot,
          name: fnName,
          detail: { args: runtimeArgs },
          timestamp: context.simulatedMs,
        });

        try {
          const ret = fn
            ? fn(runtimeArgs, context)
            : (handler as UnresolvedFunctionHandler)(
                fnName,
                runtimeArgs,
                context,
              );

          this.traceObserver?.({
            kind: "host_return",
            pluginId: slot,
            name: fnName,
            detail: { result: ret },
            timestamp: context.simulatedMs,
          });
          
          return { value: encodeHostReturn(ret) };
        } catch (e) {
          if (e instanceof MtaError) {
            return {
              value: { tag: "null-val" },
              error: {
                kind: runtimeErrorKindToWit(e.kind),
                message: e.message,
              },
            };
          }
          // Unknown JS error — surface as `unknown` runtime error so the
          // C side still raises and the test runner reports it cleanly.
          const message =
            e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          return {
            value: { tag: "null-val" },
            error: {
              kind: "unknown",
              message: `host function '${fnName}' threw: ${message}`,
            },
          };
        }
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

        // For `error` events, retCode is the mta_runtime_error_kind_t ordinal
        // (matching the WIT runtime-error-kind enum order). Decode it so
        // downstream consumers can pattern-match on a stable tag.
        const detail: Record<string, unknown> = { result: retCode };
        if (traceKind === "error") {
          detail.errorKind = runtimeErrorKindFromOrdinal(retCode);
        }

        const event: TraceEvent = {
          kind: traceKind,
          pluginId: slot,
          name: fnName,
          detail,
          timestamp: this.simulatedMs,
        };

        this.traceObserver(event);
      },

      // Called when the WASM runtime encounters an error.
      //
      // When the error originated from `mta_raise()`, errorCode is the
      // mta_runtime_error_kind_t ordinal and fnName is the formatted message.
      // We surface both the structured kind and the raw code so callers
      // can pattern-match without losing information.
      errorReport: (slot, fnName, errorCode): void => {
        const errorKind = runtimeErrorKindFromOrdinal(errorCode);
        this.reportError({
          code: errorCode,
          message: fnName || `Runtime error (${errorKind})`,
          pluginId: slot,
          context: fnName,
          errorKind,
        });
      },
    };
  }

  private makeCallContext(
    pluginId: number,
    args: RuntimeValue[],
  ): HostCallContext {
    return {
      simulatedMs: this.simulatedMs,
      pluginId,
      pluginConfig: {},
      raise(kind: RuntimeErrorKind, message: string): never {
        throw new MtaError(kind, message);
      },
      readArgs(specs: ArgSpec[]): RuntimeValue[] {
        return validateArgs(args, specs);
      },
    };
  }

  private reportError(error: Parameters<ErrorReporter>[0]): void {
    if (this.errorReporter) {
      this.errorReporter(error);
    }
  }
}
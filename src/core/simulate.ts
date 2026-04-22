import { resolve } from "node:path";
import { createRuntime } from "../runtime/index.js";
import type { TraceEvent, RuntimeError, HostFunction } from "../runtime/index.js";
import { getLatestApiDescriptor } from "@maustec/mt-runtimes";
import type { ApiDescriptor } from "../analysis/types.js";

export interface SimulateEvent {
  name: string;
  /** Integer argument passed to the event. Default: 0. */
  arg?: number;
}

export interface SimulateOptions {
  /** Already-parsed plugin JSON. */
  plugin: Record<string, unknown>;
  /**
   * Path to the .wasm runtime binary.
   * Use `resolveDefaultWasmPath()` for the standard @maustec/mt-runtimes location,
   * or supply a custom path for testing or extension contexts.
   */
  wasmPath: string;
  /** Target SKU for auto-resolving the API manifest. Ignored if `apiDescriptor` is provided. */
  sku?: string;
  /** Explicit API manifest override. */
  apiDescriptor?: ApiDescriptor;
  /** Events to fire, in order. */
  events: SimulateEvent[];
  /** Enable execution tracing. Default: true. */
  tracing?: boolean;
  /** Override or supplement auto-generated host function stubs. */
  hostFunctions?: Record<string, HostFunction>;
}

export interface EventOutcome {
  event: string;
  arg: number;
  success: boolean;
  errorCode: number;
  accumulator?: { type: string; value: unknown };
}

export interface SimulationResult {
  outcomes: EventOutcome[];
  trace: TraceEvent[];
  errors: RuntimeError[];
  /** True if all events succeeded and no runtime errors were reported. */
  ok: boolean;
}

/**
 * Run a plugin against the WASM runtime, firing a sequence of events.
 *
 * Loads the plugin, fires each event in order, then tears down the runtime.
 * Returns outcomes, the accumulated trace, and any runtime errors.
 */
export async function simulate(options: SimulateOptions): Promise<SimulationResult> {
  const { plugin, wasmPath, events, tracing = true } = options;

  let manifest: ApiDescriptor | undefined = options.apiDescriptor;

  if (!manifest && options.sku) {
    try {
      manifest = getLatestApiDescriptor(options.sku);
    } catch {
      // run without manifest
    }
  }

  const runtime = await createRuntime({
    wasm: wasmPath,
    ...(manifest !== undefined ? { manifest } : {}),
    ...(options.hostFunctions !== undefined ? { hostFunctions: options.hostFunctions } : {}),
    tracing,
  });

  const pluginHandle = runtime.loadPlugin(plugin);
  const outcomes: EventOutcome[] = [];

  for (const event of events) {
    const arg = event.arg ?? 0;
    const result = runtime.fireEvent(pluginHandle, event.name, arg);
    
    outcomes.push({
      event: event.name,
      arg,
      success: result.success,
      errorCode: result.errorCode,
      ...(result.accumulator
        ? { accumulator: { type: result.accumulator.type, value: result.accumulator.value } }
        : {}),
    });
  }

  const trace = runtime.getTrace();
  const errors = runtime.getErrors();

  runtime.freePlugin(pluginHandle);
  runtime.dispose();

  return {
    outcomes,
    trace,
    errors,
    ok: outcomes.every((o) => o.success) && errors.length === 0,
  };
}

/**
 * Resolve the standard WASM binary path from the @maustec/mt-runtimes package.
 *
 * Suitable for CLI and Node.js contexts. For bundled VS Code extensions,
 * use `context.asAbsolutePath(path.join("dist", "mt-actions-core.wasm"))` instead.
 */
export function resolveDefaultWasmPath(): string {
  const runtimesEntry = import.meta.resolve("@maustec/mt-runtimes");
  const runtimesDir = resolve(new URL(runtimesEntry).pathname, "..", "..");
  return resolve(runtimesDir, "wasm", "mt-actions-core.wasm");
}

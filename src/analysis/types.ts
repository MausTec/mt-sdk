// Re-export shared firmware API types from mt-runtimes as the canonical source.
import type { ApiDescriptor } from "@maustec/mt-runtimes";
export type {
  ApiDescriptor,
  EventDescriptor,
  HostFunctionDescriptor,
  ArgDescriptor,
  PayloadField,
} from "@maustec/mt-runtimes";

/** Diagnostic from validation. */
export interface Diagnostic {
  tier: "structural" | "schema" | "api";
  level: "error" | "warning";
  path?: string | undefined;
  message: string;
}

/** Result of validation. */
export interface ValidationResult {
  valid: boolean;
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

/** Options for validation. */
export interface ValidateOptions {
  plugin: Record<string, unknown>;
  manifest?: ApiDescriptor | undefined;
  schema?: Record<string, unknown> | undefined;
  strict?: boolean | undefined;
}

/** An event to fire during simulation. */
export interface EventSequence {
  event: string;
  arg: number;
  delayMs?: number;
}

/** A single traced action during simulation. */
export interface TracedAction {
  type: "host_call" | "variable_set" | "function_call" | "control_flow" | "error";
  name: string;
  args?: unknown[];
  result?: unknown;
  children?: TracedAction[];
}

/** A traced event (event + all actions it triggered). */
export interface TracedEvent {
  event: string;
  arg: number;
  timestamp: number;
  actions: TracedAction[];
}

/** Full execution trace from simulation. */
export interface ExecutionTrace {
  events: TracedEvent[];
}

/** Result of simulation. */
export interface SimulationResult {
  success: boolean;
  trace: ExecutionTrace;
  errors: Array<{ message: string; event?: string }>;
}

/** Options for simulation. */
export interface SimulateOptions {
  plugin: Record<string, unknown>;
  runtime: LoadedRuntime;
  events: EventSequence[];
  config?: Record<string, unknown>;
  hostStubs?: Record<string, HostStub>;
}

/** A mock host function stub for simulation. */
export type HostStub = (
  args: unknown[],
  context: HostStubContext,
) => unknown;

/** Context passed to host function stubs. */
export interface HostStubContext {
  simulatedMs: number;
  trace: TracedAction[];
  pluginConfig: Record<string, unknown>;
}

/** Opaque handle to a loaded WASM runtime. */
export interface LoadedRuntime {
  manifest: ApiDescriptor;
  // Internal WASM instance - not part of public API
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _instance?: any;
}

// Core types shared across all modules

/** Describes a host function available in the firmware runtime. */
export interface HostFunctionDescriptor {
  name: string;
  permission: string | null;
  description?: string;
  args?: ArgDescriptor[];
  returns?: string | null;
}

/** Describes an event emitted by the firmware. */
export interface EventDescriptor {
  name: string;
  permission: string | null;
  description?: string;
  payload?: PayloadField[];
}

/** Describes a function argument. */
export interface ArgDescriptor {
  name: string;
  type: "int" | "float" | "string" | "bool" | "bytes";
  description?: string;
  optional?: boolean;
}

/** Describes an event payload field. */
export interface PayloadField {
  name: string;
  type: "int" | "float" | "string" | "bool" | "bytes";
  description?: string;
}

/** Runtime manifest shipped in @maustec/mt-runtime-* packages. */
export interface RuntimeManifest {
  product: string;
  version: string;
  events: EventDescriptor[];
  hostFunctions: HostFunctionDescriptor[];
  builtins: string[];
  permissions: string[];
}

/** A loaded runtime pack (WASM binary + manifest + schema). */
export interface RuntimePack {
  wasm: ArrayBuffer;
  manifest: RuntimeManifest;
  schema: Record<string, unknown>;
}

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
  manifest?: RuntimeManifest | undefined;
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
  manifest: RuntimeManifest;
  // Internal WASM instance — not part of public API
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _instance?: any;
}

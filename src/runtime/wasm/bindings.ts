/**
 * Typed bindings for the mt-actions WASM bridge functions.
 *
 * Each function here wraps a C function exported by mt-runtimes bridge via
 * Emscripten's cwrap/ccall. This module is the only place that touches
 * raw WASM function pointers, everything else MUST use these typed wrappers.
 *
 * Exported C functions (from mt-runtimes bridge):
 *   bridge_init()                              -> void
 *   bridge_load_plugin(json: string)           -> int (plugin_id or -1)
 *   bridge_free_plugin(id: int)                -> void
 *   bridge_fire_event(id, event, arg)          -> string (result JSON)
 *   bridge_call_function(id, name, args_json)  -> string (result JSON)
 *   bridge_get_variable(id, name)              -> string (value JSON or NULL)
 *   bridge_set_variable(id, name, value_json)  -> void
 *   bridge_register_host_function(name, perm)  -> void
 *   bridge_set_tracing(enabled: int)           -> void
 */

import type { EmscriptenModule } from "./memory.js";

/**
 * Wrapped bridge functions with TypeScript signatures.
 * Created once from cwrap during engine initialization.
 */
export interface BridgeBindings {
  /** Initialize builtins and set up WASM-side state. */
  init(): void;

  /** Load a plugin from a JSON string. Returns slot ID or -1 on error. */
  loadPlugin(jsonString: string): number;

  /** Free a loaded plugin by slot ID. */
  freePlugin(pluginId: number): void;

  /** Fire an event. Returns error code (0 = success). */
  fireEvent(pluginId: number, event: string, arg: number): number;

  /** Call a plugin-defined function. Returns error code (0 = success). */
  callFunction(
    pluginId: number,
    name: string,
    argsJson: string,
  ): number;

  /** Get the result string from the last fire_event/call_function. */
  getLastResult(): string;

  /** Get the error code from the last fire_event/call_function. */
  getLastError(): number;

  /** Get a plugin variable. Returns value as JSON string, or null. */
  getVariable(pluginId: number, name: string): string | null;

  /** Set a plugin variable from a JSON-encoded value. */
  setVariable(pluginId: number, name: string, valueJson: string): void;

  /**
   * Register a host function name with the C runtime's function registry.
   * The actual dispatch goes through js_host_dispatch — this just makes
   * the name "known" so it doesn't hit the unresolved handler.
   */
  registerHostFunction(name: string, permission: string | null): void;

  /** Enable or disable trace observer callbacks from WASM. */
  setTracing(enabled: boolean): void;
}

/**
 * Create typed bridge bindings from an instantiated Emscripten module.
 *
 * This uses cwrap to create reusable function wrappers with correct
 * argument types. cwrap is more efficient than ccall for functions
 * that are called repeatedly.
 */
export function createBindings(mod: EmscriptenModule): BridgeBindings {
  // cwrap(name, returnType, argTypes)
  // returnType: "number", "string", "void", null
  // argTypes: "number", "string", "array"

  const _init = mod.cwrap("bridge_init", null, []) as () => void;

  const _loadPlugin = mod.cwrap("bridge_load_plugin", "number", [
    "string",
  ]) as (json: string) => number;

  const _freePlugin = mod.cwrap("bridge_free_plugin", null, [
    "number",
  ]) as (id: number) => void;

  const _fireEvent = mod.cwrap("bridge_fire_event", "number", [
    "number",
    "string",
    "number",
  ]) as (id: number, event: string, arg: number) => number;

  const _callFunction = mod.cwrap("bridge_call_function", "number", [
    "number",
    "string",
    "string",
  ]) as (id: number, name: string, argsJson: string) => number;

  const _getLastResult = mod.cwrap("bridge_get_last_result", "string", []) as () => string;

  const _getLastError = mod.cwrap("bridge_get_last_error", "number", []) as () => number;

  const _getVariable = mod.cwrap("bridge_get_variable", "string", [
    "number",
    "string",
  ]) as (id: number, name: string) => string | null;

  const _setVariable = mod.cwrap("bridge_set_variable", null, [
    "number",
    "string",
    "string",
  ]) as (id: number, name: string, valueJson: string) => void;

  const _registerHostFunction = mod.cwrap(
    "bridge_register_host_function",
    null,
    ["string", "string"],
  ) as (name: string, permission: string | null) => void;

  const _setTracing = mod.cwrap("bridge_set_tracing", null, [
    "number",
  ]) as (enabled: number) => void;

  return {
    init: _init,
    loadPlugin: _loadPlugin,
    freePlugin: _freePlugin,
    fireEvent: _fireEvent,
    callFunction: _callFunction,
    getLastResult: _getLastResult,
    getLastError: _getLastError,
    getVariable: _getVariable,
    setVariable: _setVariable,
    registerHostFunction: _registerHostFunction,
    setTracing(enabled: boolean) {
      _setTracing(enabled ? 1 : 0);
    },
  };
}
